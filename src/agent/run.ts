import { Agent } from "@earendil-works/pi-agent-core";
import { getOwnerRepo } from "../context/github";
import { resolveWorkContext } from "../context";
import { createSandbox } from "../sandbox";
import { DEFAULT_TTL_MS, renewLock } from "../lock";
import { resolveModel } from "./model";
import { createPullRequestTool } from "./pullRequest";
import { createSandboxTools } from "./sandboxTools";
import { buildSystemPrompt } from "./systemPrompt";
import { defaultTranscriptsBaseDir, loadTranscript, saveTranscript, summarizePreviousSession, transcriptPath } from "./transcript";
import type { PullRequestOutcome, RunAgentOptions, RunAgentResult } from "./types";

/**
 * How long the agent run may go without emitting a single AgentEvent before
 * it's treated as hung and aborted. This is an idle timeout, not a wall-clock
 * budget: a run that keeps producing events (tokens, tool calls) can run
 * indefinitely. Override with NOOK_AGENT_IDLE_TIMEOUT_MS.
 */
const DEFAULT_IDLE_TIMEOUT_MS = 10 * 60 * 1000;

/**
 * How often agent activity is allowed to refresh the branch lock's TTL
 * clock. Kept well under DEFAULT_TTL_MS so a long-but-active run never has
 * its lock read as abandoned by another process, while throttled so a burst
 * of streamed tokens doesn't turn into a burst of GitHub API calls.
 */
const LOCK_RENEW_INTERVAL_MS = DEFAULT_TTL_MS / 4;

function resolveIdleTimeoutMs(): number {
  const raw = process.env.NOOK_AGENT_IDLE_TIMEOUT_MS;
  const parsed = raw ? Number(raw) : NaN;
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_IDLE_TIMEOUT_MS;
}

/**
 * Creates (or resumes) the sandbox for `branch`, reassembles WorkContext
 * from inside it, and runs one agent turn to completion: the agent edits
 * files and runs commands via tools scoped to the sandbox, then calls
 * create_pull_request when it's ready for human review. The sandbox and its
 * lock are left in place afterward — cleanup is a separate, explicit step
 * (`nook sandbox destroy`), not something this run does implicitly. This
 * also holds for a run that idle-times-out: whatever the agent already did
 * (commits, pushed branches) survives in the sandbox, so retrying with the
 * same branch resumes rather than restarts.
 */
export async function runAgent(options: RunAgentOptions): Promise<RunAgentResult> {
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
      // Best-effort: a summarization failure just means this resume proceeds
      // without prior-session context rather than failing the whole run.
      previousSessionSummary = await summarizePreviousSession(models, model, previousMessages).catch(() => null);
    }
  }

  const systemPrompt = buildSystemPrompt(workContext, { previousSessionSummary });

  let pullRequest: PullRequestOutcome | null = null;

  const tools = [
    ...createSandboxTools(sandbox.path),
    createPullRequestTool({
      cwd: sandbox.path,
      owner: ownerRepo.owner,
      repo: ownerRepo.repo,
      branch: options.branch,
      baseBranch: workContext.git.mainBranch,
      token: options.token,
      onResult: (outcome) => {
        pullRequest = outcome;
      },
    }),
  ];

  const agent = new Agent({
    initialState: { systemPrompt, model, thinkingLevel: "medium", tools },
    streamFn: models.streamSimple.bind(models),
  });

  const idleTimeoutMs = resolveIdleTimeoutMs();
  let timedOut = false;
  let idleTimer: ReturnType<typeof setTimeout> | undefined;
  let lastRenewAt = 0;

  const armIdleTimer = () => {
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = setTimeout(() => {
      timedOut = true;
      agent.abort();
    }, idleTimeoutMs);
  };

  // Every agent event (a streamed token, a tool call, a turn boundary, ...)
  // counts as proof of life: it pushes back the idle-abort deadline and, at
  // most once per LOCK_RENEW_INTERVAL_MS, refreshes the branch lock so it
  // doesn't age out from under a run that's still making progress.
  const unsubscribe = agent.subscribe((event) => {
    options.onEvent?.(event);
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

  const timeoutResult = (): RunAgentResult => ({
    ok: false,
    error: `agent run idle-timed out after ${idleTimeoutMs}ms with no activity`,
    timedOut: true,
  });

  // Whatever the agent produced (even a partial, timed-out, or failed run) is
  // worth keeping for the next resume of this sandbox — best-effort so a
  // storage failure here doesn't turn a real result into an error.
  const persistTranscript = () => saveTranscript(transcriptFile, agent.state.messages).catch(() => {});

  try {
    await agent.prompt(options.prompt);
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

  const summary = summarizeFinalMessage(agent);

  return {
    ok: true,
    summary,
    pullRequest,
    sandboxPath: sandbox.path,
    resumed: sandbox.resumed,
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
