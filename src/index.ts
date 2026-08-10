import { formatCreateSandboxResult, formatDestroySandboxResult, formatWorkContext } from "./cli/format";
import { parseSandboxArgs } from "./cli/sandbox";
import { resolveWorkContext } from "./context";
import { createServer } from "./serve";
import { createSandbox, destroySandbox } from "./sandbox";

const DEFAULT_PORT = 4319;

function usage(): never {
  console.error("usage: nook <serve|status|sandbox> [--json]");
  console.error("  nook sandbox create <branch> [--backend worktree|docker] [--json]");
  console.error("  nook sandbox destroy <branch> [--backend worktree|docker] [--force] [--json]");
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

async function main() {
  const [command, ...rest] = process.argv.slice(2);

  if (command === "serve") {
    await runServe();
  } else if (command === "status") {
    await runStatus(rest.includes("--json"));
  } else if (command === "sandbox") {
    await runSandbox(rest);
  } else {
    usage();
  }
}

main();
