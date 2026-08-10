import type { AgentEvent } from "@earendil-works/pi-agent-core";

export interface RunAgentOptions {
  repoPath: string;
  branch: string;
  /** Task instruction for the agent. Required — WorkContext alone does not decide what to do. */
  prompt: string;
  token: string;
  /**
   * Optional sink for every AgentEvent (a streamed token, a tool call, a turn
   * boundary, ...) as it happens, in addition to the idle-timer/lock-renew
   * bookkeeping runAgent already does on each event. Lets a caller (e.g. an
   * SSE HTTP handler) forward live progress without runAgent knowing
   * anything about HTTP.
   */
  onEvent?: (event: AgentEvent) => void;
}

export interface PullRequestOutcome {
  url: string;
  number: number;
  created: boolean;
}

export type RunAgentResult =
  | {
      ok: true;
      summary: string;
      pullRequest: PullRequestOutcome | null;
      sandboxPath: string;
      resumed: boolean;
    }
  | { ok: false; error: string; timedOut?: boolean };
