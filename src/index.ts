import { createInterface } from "node:readline/promises";
import { join } from "node:path";
import { buildDocsSystemPrompt } from "./agent/docsSystemPrompt";
import { createDocsTools } from "./agent/docsTools";
import { createSession } from "./agent/session";
import { formatCreateSandboxResult, formatDestroySandboxResult, formatWorkContext } from "./cli/format";
import { parseDocsArgs } from "./cli/docs";
import { parseSandboxArgs } from "./cli/sandbox";
import { resolveGitContext } from "./context/git";
import { resolveWorkContext } from "./context";
import { createServer } from "./serve";
import { createSandbox, destroySandbox } from "./sandbox";

const DEFAULT_PORT = 4319;

function usage(): never {
  console.error("usage: nook <serve|status|sandbox|docs> [--json]");
  console.error("  nook sandbox create <branch> [--backend worktree|docker] [--json]");
  console.error("  nook sandbox destroy <branch> [--backend worktree|docker] [--force] [--json]");
  console.error("  nook docs [branch]");
  process.exit(1);
}

function requireGithubToken(): string {
  const token = process.env.GITHUB_TOKEN;
  if (!token) {
    throw new Error("GITHUB_TOKEN not set");
  }
  return token;
}

async function runServe() {
  const repoPath = process.cwd();
  const port = process.env.PORT ? Number(process.env.PORT) : DEFAULT_PORT;

  const app = createServer(repoPath);

  console.log(`nook serve: watching ${repoPath} on http://localhost:${port}`);
  Bun.serve({ fetch: app.fetch, port });
}

/**
 * Resolves work context in-process rather than talking to a running
 * `nook serve` — resolveWorkContext holds no server-side state (CONCEPT.md
 * principle 1), so there's nothing an HTTP round trip would add here.
 */
async function runStatus(json: boolean) {
  const repoPath = process.cwd();
  const workContext = await resolveWorkContext(repoPath);
  console.log(json ? JSON.stringify(workContext, null, 2) : formatWorkContext(workContext));
}

async function runSandboxCreate(args: string[]) {
  const { branch, backend, json } = parseSandboxArgs(args);
  const token = requireGithubToken();
  const result = await createSandbox({ repoPath: process.cwd(), branch, token, backend });
  console.log(json ? JSON.stringify(result, null, 2) : formatCreateSandboxResult(result));
  if (!result.ok) process.exit(1);
}

async function runSandboxDestroy(args: string[]) {
  const { branch, backend, force, json } = parseSandboxArgs(args);
  const token = requireGithubToken();
  const result = await destroySandbox({ repoPath: process.cwd(), branch, token, backend, force });
  console.log(json ? JSON.stringify(result, null, 2) : formatDestroySandboxResult(branch, result));
  if (!result.ok) process.exit(1);
}

async function runSandbox(args: string[]) {
  const [sub, ...rest] = args;
  try {
    if (sub === "create") {
      await runSandboxCreate(rest);
    } else if (sub === "destroy") {
      await runSandboxDestroy(rest);
    } else {
      usage();
    }
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}

/**
 * Interactive local session for tending CONCEPT.md/ROADMAP.md/FEATURE.md/
 * HANDOFF.md. Unlike the implementation agent, this goes through the same
 * sandbox/lock lifecycle (no bypass — see ROADMAP.md) but on whatever branch
 * is already checked out, so it never creates a new branch, and its tools
 * are scoped to just those four files plus commit/push (no bash, no PR).
 */
async function runDocs(args: string[]) {
  const repoPath = process.cwd();
  const token = requireGithubToken();
  const { branch: argBranch } = parseDocsArgs(args);
  const branch = argBranch ?? (await resolveGitContext(repoPath)).branch;

  console.log(`nook docs: opening sandbox for branch '${branch}'…`);

  const sessionResult = await createSession({
    repoPath,
    branch,
    token,
    createTools: (ctx) => createDocsTools(ctx.sandboxPath, { branch: ctx.branch, mainBranch: ctx.baseBranch, token: ctx.token }),
    buildSystemPrompt: async ({ workContext, sandboxPath, previousSessionSummary }) => {
      const claudeMdFile = Bun.file(join(sandboxPath, "CLAUDE.md"));
      const claudeMd = (await claudeMdFile.exists()) ? await claudeMdFile.text() : null;
      return buildDocsSystemPrompt(workContext, { claudeMd, previousSessionSummary });
    },
  });

  if (!sessionResult.ok) {
    console.error(sessionResult.error);
    process.exit(1);
  }
  const { session } = sessionResult;

  console.log(`sandbox: ${session.sandboxPath}${session.resumed ? " (resumed)" : ""}`);
  if (branch === session.workContext.git.mainBranch) {
    console.log(`note: '${branch}' is this repo's main branch — git_push will refuse to push directly to it.`);
  }
  console.log("Type a message and press Enter. Empty line or Ctrl+D to exit.\n");

  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    while (true) {
      const line = await rl.question("> ").catch(() => null);
      if (line === null || line.trim().length === 0) break;

      let assistantStarted = false;
      const result = await session.send(line, (event) => {
        if (event.type === "message_update" && event.assistantMessageEvent.type === "text_delta") {
          if (!assistantStarted) {
            process.stdout.write("\n");
            assistantStarted = true;
          }
          process.stdout.write(event.assistantMessageEvent.delta);
        } else if (event.type === "tool_execution_start") {
          process.stdout.write(`\n[${event.toolName}] `);
        } else if (event.type === "tool_execution_end") {
          process.stdout.write(event.isError ? "failed" : "ok");
        }
      });
      process.stdout.write("\n\n");

      if (!result.ok) {
        console.error(result.timedOut ? `idle timeout: ${result.error}` : result.error);
      }
    }
  } finally {
    rl.close();
    await session.close();
    console.log("session closed.");
  }
}

async function main() {
  const [command, ...rest] = process.argv.slice(2);

  if (command === "serve") {
    await runServe();
  } else if (command === "status") {
    await runStatus(rest.includes("--json"));
  } else if (command === "sandbox") {
    await runSandbox(rest);
  } else if (command === "docs") {
    await runDocs(rest);
  } else {
    usage();
  }
}

main();
