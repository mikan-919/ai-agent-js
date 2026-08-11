import { createPullRequestTool } from "./pullRequest";
import { createSession } from "./session";
import { createSandboxTools } from "./sandboxTools";
import { buildSystemPrompt } from "./systemPrompt";
import type { PullRequestOutcome, RunAgentOptions, RunAgentResult } from "./types";

/**
 * Creates (or resumes) the sandbox for `branch`, runs one agent turn to
 * completion (a single-send session), and leaves the sandbox and its lock in
 * place afterward — cleanup is a separate, explicit step (the sandbox
 * destroy subcommand), not something this run does implicitly. This also holds for a
 * run that idle-times-out: whatever the agent already did (commits, pushed
 * branches) survives in the sandbox, so retrying with the same branch
 * resumes rather than restarts.
 */
export async function runAgent(options: RunAgentOptions): Promise<RunAgentResult> {
  let pullRequest: PullRequestOutcome | null = null;

  const sessionResult = await createSession({
    repoPath: options.repoPath,
    branch: options.branch,
    token: options.token,
    createTools: (ctx) => [
      ...createSandboxTools(ctx.sandboxPath),
      createPullRequestTool({
        cwd: ctx.sandboxPath,
        owner: ctx.owner,
        repo: ctx.repo,
        branch: ctx.branch,
        baseBranch: ctx.baseBranch,
        token: ctx.token,
        onResult: (outcome) => {
          pullRequest = outcome;
        },
      }),
    ],
    buildSystemPrompt: ({ workContext, previousSessionSummary }) => buildSystemPrompt(workContext, { previousSessionSummary }),
  });
  if (!sessionResult.ok) {
    return { ok: false, error: sessionResult.error };
  }
  const { session } = sessionResult;

  const result = await session.send(options.prompt, options.onEvent);
  await session.close();

  if (!result.ok) {
    return { ok: false, error: result.error ?? "unknown error", timedOut: result.timedOut };
  }

  return {
    ok: true,
    summary: result.summary ?? "",
    pullRequest,
    sandboxPath: session.sandboxPath,
    resumed: session.resumed,
  };
}
