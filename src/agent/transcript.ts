import { mkdir, rm } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { generateSummary } from "@earendil-works/pi-agent-core";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { Api, Model, Models } from "@earendil-works/pi-ai";

/**
 * Tied to the sandbox by (owner, repo, branch), not to the sandbox directory
 * itself: the worktree/container backends differ in whether that path is
 * even host-reachable (a Docker sandbox's path lives inside the container),
 * and writing here must never register as an uncommitted change in the
 * sandbox's own git status (see destroySandbox's dirty-worktree check).
 */
export function defaultTranscriptsBaseDir(): string {
  return join(homedir(), ".nook", "transcripts");
}

export function transcriptPath(baseDir: string, owner: string, repo: string, branch: string): string {
  return join(baseDir, `${owner}-${repo}`, `${branch.replace(/\//g, "-")}.json`);
}

/** Overwrites whatever was stored before — only the most recent run's messages are kept, not a full history. */
export async function saveTranscript(path: string, messages: AgentMessage[]): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await Bun.write(path, JSON.stringify(messages));
}

export async function loadTranscript(path: string): Promise<AgentMessage[] | null> {
  const file = Bun.file(path);
  if (!(await file.exists())) return null;
  try {
    const data = JSON.parse(await file.text());
    return Array.isArray(data) && data.length > 0 ? (data as AgentMessage[]) : null;
  } catch {
    return null;
  }
}

export async function deleteTranscript(path: string): Promise<void> {
  await rm(path, { force: true });
}

/** Matches pi-agent-core's own DEFAULT_COMPACTION_SETTINGS.reserveTokens. */
const SUMMARY_RESERVE_TOKENS = 16384;

const MAX_TOOL_ARG_CHARS = 200;

function truncateArgValue(value: unknown): unknown {
  if (typeof value === "string" && value.length > MAX_TOOL_ARG_CHARS) {
    return `${value.slice(0, MAX_TOOL_ARG_CHARS)}… (${value.length} chars total)`;
  }
  return value;
}

/**
 * Mechanical pre-pass run before handing a transcript to pi-agent-core's
 * generateSummary. generateSummary's own serializeConversation truncates
 * large tool *results* but otherwise serializes thinking blocks in full and
 * tool-call arguments as complete JSON — which would replay entire file
 * contents (edit_file's old_string/new_string, write_file's content) back
 * into the summarization prompt. This strips thinking blocks entirely (not
 * useful for a resume brief) and truncates tool-call argument values, so
 * what reaches the LLM is "called write_file(path=...)", not the file body.
 */
export function compressForSummary(messages: AgentMessage[]): AgentMessage[] {
  return messages.map((message) => {
    if (!("role" in message) || message.role !== "assistant") return message;
    const content = message.content
      .filter((block) => block.type !== "thinking")
      .map((block) =>
        block.type === "toolCall"
          ? { ...block, arguments: Object.fromEntries(Object.entries(block.arguments).map(([k, v]) => [k, truncateArgValue(v)])) }
          : block,
      );
    return { ...message, content };
  });
}

/**
 * Compresses a previous run's raw transcript into a short checkpoint brief
 * for the agent resuming this sandbox. Reuses pi-agent-core's own compaction
 * summarizer for the structured checkpoint format and its LLM call
 * (generateSummary), after running compressForSummary to strip thinking and
 * truncate tool-call arguments first. Returns null (rather than throwing) on
 * failure so a resume degrades to running without prior context instead of
 * failing outright.
 */
export async function summarizePreviousSession(
  models: Models,
  model: Model<Api>,
  messages: AgentMessage[],
): Promise<string | null> {
  const result = await generateSummary(compressForSummary(messages), models, model, SUMMARY_RESERVE_TOKENS);
  return result.ok ? result.value : null;
}
