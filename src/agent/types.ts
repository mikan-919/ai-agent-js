export interface RunAgentOptions {
  repoPath: string;
  branch: string;
  /** Task instruction for the agent. Required — WorkContext alone does not decide what to do. */
  prompt: string;
  token: string;
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
