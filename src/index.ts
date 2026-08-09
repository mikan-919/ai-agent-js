import { createServer } from "./serve";

const DEFAULT_PORT = 4319;

function usage(): never {
  console.error("usage: har serve");
  process.exit(1);
}

async function main() {
  const [command] = process.argv.slice(2);

  if (command !== "serve") {
    usage();
  }

  const repoPath = process.cwd();
  const port = process.env.PORT ? Number(process.env.PORT) : DEFAULT_PORT;

  const app = createServer(repoPath);

  console.log(`har serve: watching ${repoPath} on http://localhost:${port}`);
  Bun.serve({ fetch: app.fetch, port });
}

main();
