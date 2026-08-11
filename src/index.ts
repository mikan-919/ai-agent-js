import { createInterface } from "node:readline/promises";
import { join } from "node:path";
import { buildDocsSystemPrompt } from "./agent/docsSystemPrompt";
import { createDocsTools } from "./agent/docsTools";
import { createSession } from "./agent/session";
import { buildTicketExtractionSystemPrompt, buildTicketReplySystemPrompt } from "./agent/ticketSystemPrompt";
import {
  createCreateIssueTool,
  createReplyToIssueTool,
  getAuthenticatedLogin,
  listIssueComments,
  listOpenIssues,
  listProposedIssues,
  resolveMaxIssuesPerRun,
} from "./agent/ticketTools";
import { formatCreateSandboxResult, formatDestroySandboxResult, formatWorkContext } from "./cli/format";
import { parseDocsArgs } from "./cli/docs";
import { parseSandboxArgs } from "./cli/sandbox";
import { parseTicketArgs } from "./cli/ticket";
import { resolveGitContext, detectMainBranch } from "./context/git";
import { getOwnerRepo } from "./context/github";
import { resolveWorkContext } from "./context";
import { createServer } from "./serve";
import { createSandbox, destroySandbox } from "./sandbox";

const DEFAULT_PORT = 4319;

function usage(): never {
  console.error("usage: nook <serve|status|sandbox|docs|ticket> [--json]");
  console.error("  nook sandbox create <branch> [--backend worktree|docker] [--json]");
  console.error("  nook sandbox destroy <branch> [--backend worktree|docker] [--force] [--json]");
  console.error("  nook docs [branch]");
  console.error("  nook ticket [--json]");
  console.error("  nook ticket poll");
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

/**
 * Files nook:proposed GitHub issues for gaps the human has already flagged
 * in ROADMAP.md/HANDOFF.md (see ROADMAP.md's ticket-extraction agent
 * design). Always targets the repo's default branch, never whatever branch
 * happens to be checked out — the point is project-wide direction, not a
 * feature branch's possibly-stale docs. The sandbox/lock are torn down again
 * once the run ends: unlike the implementation/docs agents, this one never
 * writes to its worktree, so there's nothing worth keeping it around for.
 */
async function runTicketExtract(json: boolean) {
  const repoPath = process.cwd();
  const token = requireGithubToken();

  const ownerRepo = await getOwnerRepo(repoPath);
  if (!ownerRepo) {
    throw new Error(`could not determine owner/repo from git remote 'origin' in ${repoPath}`);
  }

  const mainBranch = await detectMainBranch(repoPath);
  const maxIssues = resolveMaxIssuesPerRun();
  const createdCount = { current: 0 };
  const openIssues = await listOpenIssues(ownerRepo.owner, ownerRepo.repo, token);

  console.log(`nook ticket: opening sandbox for '${mainBranch}'…`);

  const sessionResult = await createSession({
    repoPath,
    branch: mainBranch,
    token,
    createTools: (ctx) => [
      createCreateIssueTool({ owner: ctx.owner, repo: ctx.repo, token: ctx.token, maxIssues, createdCount }),
    ],
    buildSystemPrompt: ({ workContext }) =>
      buildTicketExtractionSystemPrompt({
        roadmap: workContext.docs.roadmap,
        handoff: workContext.docs.handoff,
        openIssues,
        maxIssues,
      }),
  });

  if (!sessionResult.ok) {
    console.error(sessionResult.error);
    process.exit(1);
  }
  const { session } = sessionResult;

  const result = await session.send(
    "Review ROADMAP.md's next priorities and open questions, and HANDOFF.md's " +
      "handoff note, for gaps that don't yet have a matching open issue. File a " +
      "nook:proposed issue for each genuinely new gap; skip anything the existing " +
      "open issues already cover. If there's nothing new, create nothing and say so.",
  );
  await session.close();
  await destroySandbox({ repoPath, branch: mainBranch, token });

  if (!result.ok) {
    console.error(result.timedOut ? `idle timeout: ${result.error}` : result.error);
    process.exit(1);
  }

  console.log(
    json
      ? JSON.stringify({ createdCount: createdCount.current, summary: result.summary }, null, 2)
      : `created ${createdCount.current} issue(s).\n\n${result.summary}`,
  );
}

/**
 * Stateless polling pass for the ticket-extraction agent's issue-conversation
 * extension (ROADMAP.md): for every open nook:proposed issue, replies if and
 * only if the latest comment wasn't posted by nook itself. No "last seen"
 * cursor is kept between passes (CONCEPT.md principle 1) — "does this need a
 * reply" is re-derived from the thread every time this runs.
 *
 * Each issue gets its own freshly created-then-destroyed sandbox/lock rather
 * than one shared across the whole pass: they all target the same default
 * branch, and reusing one sandbox across issues would make session.ts treat
 * the previous issue's transcript as "the previous session in this sandbox"
 * and feed it in as unrelated context for the next issue's reply.
 */
async function runTicketPoll() {
  const repoPath = process.cwd();
  const token = requireGithubToken();

  const ownerRepo = await getOwnerRepo(repoPath);
  if (!ownerRepo) {
    throw new Error(`could not determine owner/repo from git remote 'origin' in ${repoPath}`);
  }

  const mainBranch = await detectMainBranch(repoPath);
  const botLogin = await getAuthenticatedLogin(token);
  const proposedIssues = await listProposedIssues(ownerRepo.owner, ownerRepo.repo, token);

  let replied = 0;
  for (const issue of proposedIssues) {
    const comments = await listIssueComments(ownerRepo.owner, ownerRepo.repo, issue.number, token);
    const lastComment = comments[comments.length - 1];
    if (!lastComment || lastComment.login === botLogin) continue;

    console.log(`nook ticket poll: replying on issue #${issue.number}…`);

    const sessionResult = await createSession({
      repoPath,
      branch: mainBranch,
      token,
      createTools: (ctx) => [
        createReplyToIssueTool({ owner: ctx.owner, repo: ctx.repo, token: ctx.token, issueNumber: issue.number }),
      ],
      buildSystemPrompt: () => buildTicketReplySystemPrompt({ issue, comments }),
    });

    if (!sessionResult.ok) {
      console.error(`issue #${issue.number}: ${sessionResult.error}`);
      continue;
    }

    const result = await sessionResult.session.send("Reply to the human's latest comment in the thread above.");
    await sessionResult.session.close();
    await destroySandbox({ repoPath, branch: mainBranch, token });

    if (!result.ok) {
      console.error(`issue #${issue.number}: ${result.timedOut ? `idle timeout: ${result.error}` : result.error}`);
      continue;
    }
    replied++;
  }

  console.log(
    `nook ticket poll: replied on ${replied} issue(s) (${proposedIssues.length} nook:proposed issue(s) checked).`,
  );
}

async function runTicket(args: string[]) {
  try {
    const { mode, json } = parseTicketArgs(args);
    if (mode === "poll") {
      await runTicketPoll();
    } else {
      await runTicketExtract(json);
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
  } else if (command === "docs") {
    await runDocs(rest);
  } else if (command === "ticket") {
    await runTicket(rest);
  } else {
    usage();
  }
}

main();
