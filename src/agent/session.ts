import { Agent } from "@earendil-works/pi-agent-core";
import type { AgentEvent, AgentTool } from "@earendil-works/pi-agent-core";
import type { WorkContext } from "../context";
import { resolveWorkContext } from "../context";
import { getOwnerRepo } from "../context/github";
import { DEFAULT_TTL_MS, renewLock } from "../lock";
import { createSandbox } from "../sandbox";
import { resolveModel } from "./model";
import {
  defaultTranscriptsBaseDir,
  loadTranscript,
  saveTranscript,
  summarizePreviousSession,
  transcriptPath,
} from "./transcript";

const DEFAULT_IDLE_TIMEOUT_MS = 10 * 60 * 1000;

/**
 * How often agent activity is allowed to refresh the branch lock's TTL
 * clock. Kept well under DEFAULT_TTL_MS so a long-but-active session never
 * has its lock read as abandoned by another process, while throttled so a
 * burst of streamed tokens doesn't turn into a burst of GitHub API calls.
 */
const LOCK_RENEW_INTERVAL_MS = DEFAULT_TTL_MS / 4;

function resolveIdleTimeoutMs(): number {
  const raw = process.env.NOOK_AGENT_IDLE_TIMEOUT_MS;
  const parsed = raw ? Number(raw) : NaN;
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_IDLE_TIMEOUT_MS;
}

export interface SessionToolContext {
  sandboxPath: string;
  owner: string;
  repo: string;
  branch: string;
  baseBranch: string;
  token: string;
}

export interface SystemPromptParams {
  workContext: WorkContext;
  sandboxPath: string;
  previousSessionSummary: string | null;
}

export type SystemPromptBuilder = (params: SystemPromptParams) => string | Promise<string>;

export interface CreateSessionOptions {
  repoPath: string;
  branch: string;
  token: string;
  createTools: (ctx: SessionToolContext) => AgentTool[];
  buildSystemPrompt: SystemPromptBuilder;
}

export interface SessionSendResult {
  ok: boolean;
  summary?: string;
  error?: string;
  timedOut?: boolean;
}

export interface AgentSession {
  sandboxPath: string;
  resumed: boolean;
  workContext: WorkContext;
  /**
   * Runs one turn to completion on the same live Agent. Only the very first
   * turn after a cold start (see createSession) pays for transcript
   * summarization — every `send()` after that is just `agent.prompt()`, so a
   * multi-turn conversation doesn't redo a "resume" on every message.
   */
  send(prompt: string, onEvent?: (event: AgentEvent) => void): Promise<SessionSendResult>;
  /** Persists the transcript one last time. Does not touch the sandbox or its lock — those outlive the session. */
  close(): Promise<void>;
}

export type CreateSessionResult = { ok: true; session: AgentSession } | { ok: false; error: string };

/**
 * Creates (or resumes) the sandbox for `branch` and starts one live Agent
 * that `send()` can be called on repeatedly. This is the shared foundation
 * under both the one-shot implementation-agent run (runAgent: create,
 * send once, close) and any multi-turn use (the docs CLI, the web UI's
 * chat): summarizing a previous session's transcript is a "cold start" cost
 * paid once here, when this sandbox's prior process is no longer around to
 * ask directly — not something a live conversation should pay again on
 * every message. The durable record stays external (transcript on disk,
 * per CONCEPT.md principle 1); the live Agent in memory is just a
 * performance cache for as long as this session is alive.
 */
export async function createSession(options: CreateSessionOptions): Promise<CreateSessionResult> {
  const sandboxResult = await createSandbox({
    repoPath: options.repoPath,
    branch: options.branch,
    token: options.token,
  });
  if (!sandboxResult.ok) {
    return { ok: false, error: sandboxResult.error };
  }
  const { sandbox } = sandboxResult;

  const ownerRepo = await getOwnerRepo(sandbox.path);
  if (!ownerRepo) {
    return { ok: false, error: `could not determine owner/repo from git remote 'origin' in ${sandbox.path}` };
  }

  const workContext = await resolveWorkContext(sandbox.path);

  let model: ReturnType<typeof resolveModel>["model"];
  let models: ReturnType<typeof resolveModel>["models"];
  try {
    ({ model, models } = resolveModel());
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }

  const transcriptFile = transcriptPath(defaultTranscriptsBaseDir(), ownerRepo.owner, ownerRepo.repo, options.branch);
  let previousSessionSummary: string | null = null;
  if (sandbox.resumed) {
    const previousMessages = await loadTranscript(transcriptFile);
    if (previousMessages) {
      // Best-effort: a summarization failure just means this session starts
      // without prior-session context rather than failing outright.
      previousSessionSummary = await summarizePreviousSession(models, model, previousMessages).catch(() => null);
    }
  }

  const systemPrompt = await options.buildSystemPrompt({ workContext, sandboxPath: sandbox.path, previousSessionSummary });

  const tools = options.createTools({
    sandboxPath: sandbox.path,
    owner: ownerRepo.owner,
    repo: ownerRepo.repo,
    branch: options.branch,
    baseBranch: workContext.git.mainBranch,
    token: options.token,
  });

  const agent = new Agent({
    initialState: { systemPrompt, model, thinkingLevel: "medium", tools },
    streamFn: models.streamSimple.bind(models),
  });

  // Throttles lock renewal across the whole session's lifetime (not reset
  // per send) — same reasoning as runAgent had for a single run.
  let lastRenewAt = 0;

  const persistTranscript = () => saveTranscript(transcriptFile, agent.state.messages).catch(() => {});

  const send = async (prompt: string, onEvent?: (event: AgentEvent) => void): Promise<SessionSendResult> => {
    const idleTimeoutMs = resolveIdleTimeoutMs();
    let timedOut = false;
    let idleTimer: ReturnType<typeof setTimeout> | undefined;

    const armIdleTimer = () => {
      if (idleTimer) clearTimeout(idleTimer);
      idleTimer = setTimeout(() => {
        timedOut = true;
        agent.abort();
      }, idleTimeoutMs);
    };

    const unsubscribe = agent.subscribe((event) => {
      onEvent?.(event);
      armIdleTimer();
      const now = Date.now();
      if (now - lastRenewAt >= LOCK_RENEW_INTERVAL_MS) {
        lastRenewAt = now;
        void renewLock({
          owner: ownerRepo.owner,
          repo: ownerRepo.repo,
          branch: options.branch,
          token: options.token,
          holder: sandbox.holder,
        }).catch(() => {
          // Best-effort: a failed renewal just leaves the TTL clock running
          // from the last successful renew (or the original acquire).
        });
      }
    });
    armIdleTimer();

    const timeoutResult = (): SessionSendResult => ({
      ok: false,
      error: `agent turn idle-timed out after ${idleTimeoutMs}ms with no activity`,
      timedOut: true,
    });

    try {
      await agent.prompt(prompt);
    } catch (error) {
      clearTimeout(idleTimer);
      unsubscribe();
      await persistTranscript();
      if (timedOut) return timeoutResult();
      return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
    clearTimeout(idleTimer);
    unsubscribe();
    await persistTranscript();

    if (timedOut) return timeoutResult();

    return { ok: true, summary: summarizeFinalMessage(agent) };
  };

  const close = async () => {
    await persistTranscript();
  };

  return {
    ok: true,
    session: { sandboxPath: sandbox.path, resumed: sandbox.resumed, workContext, send, close },
  };
}

function summarizeFinalMessage(agent: Agent): string {
  const messages = agent.state.messages;
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i];
    if (message && "role" in message && message.role === "assistant") {
      return message.content
        .filter((block): block is { type: "text"; text: string } => block.type === "text")
        .map((block) => block.text)
        .join("\n");
    }
  }
  return "";
}
