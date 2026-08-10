import { formatWorkContext } from "./cli/format";
import { resolveWorkContext } from "./context";
import { createServer } from "./serve";

const DEFAULT_PORT = 4319;

function usage(): never {
  console.error("usage: nook <serve|status> [--json]");
  process.exit(1);
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

async function main() {
  const [command, ...rest] = process.argv.slice(2);

  if (command === "serve") {
    await runServe();
  } else if (command === "status") {
    await runStatus(rest.includes("--json"));
  } else {
    usage();
  }
}

main();
