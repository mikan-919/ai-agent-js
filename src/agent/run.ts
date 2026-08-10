import { Agent } from "@earendil-works/pi-agent-core";
import { getOwnerRepo } from "../context/github";
import { resolveWorkContext } from "../context";
import { createSandbox } from "../sandbox";
import { resolveModel } from "./model";
import { createPullRequestTool } from "./pullRequest";
import { createSandboxTools } from "./sandboxTools";
import { buildSystemPrompt } from "./systemPrompt";
import type { PullRequestOutcome, RunAgentOptions, RunAgentResult } from "./types";

/**
 * Creates (or resumes) the sandbox for `branch`, reassembles WorkContext
 * from inside it, and runs one agent turn to completion: the agent edits
 * files and runs commands via tools scoped to the sandbox, then calls
 * create_pull_request when it's ready for human review. The sandbox and its
 * lock are left in place afterward — cleanup is a separate, explicit step
 * (`nook sandbox destroy`), not something this run does implicitly.
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
  const systemPrompt = buildSystemPrompt(workContext);

  let model: ReturnType<typeof resolveModel>["model"];
  let models: ReturnType<typeof resolveModel>["models"];
  try {
    ({ model, models } = resolveModel());
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }

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

  try {
    await agent.prompt(options.prompt);
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }

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
