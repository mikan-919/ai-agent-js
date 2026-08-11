import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveGithubContext } from "./github";

const dirs: string[] = [];

async function git(cwd: string, args: string[]): Promise<void> {
  const proc = Bun.spawn(["git", ...args], { cwd, stdout: "ignore", stderr: "ignore" });
  const exitCode = await proc.exited;
  if (exitCode !== 0) throw new Error(`git ${args.join(" ")} failed with code ${exitCode}`);
}

async function initRepoWithOrigin(url: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "agent-harness-github-context-"));
  dirs.push(dir);
  await git(dir, ["init", "-q", "-b", "main"]);
  await git(dir, ["remote", "add", "origin", url]);
  return dir;
}

function pullsResponse(): Response {
  return new Response(
    JSON.stringify([
      {
        number: 42,
        title: "Add feature",
        state: "open",
        draft: false,
        html_url: "https://github.com/acme/demo/pull/42",
        body: null,
        head: { ref: "feature/x" },
        base: { ref: "main" },
      },
    ]),
    { status: 200 },
  );
}

function href(input: string | URL | Request): string {
  if (typeof input === "string") return input;
  if (input instanceof URL) return input.href;
  return input.url;
}

afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("resolveGithubContext", () => {
  let originalFetch: typeof fetch;
  let originalToken: string | undefined;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
    originalToken = process.env.GITHUB_TOKEN;
    process.env.GITHUB_TOKEN = "test-token";
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    if (originalToken === undefined) delete process.env.GITHUB_TOKEN;
    else process.env.GITHUB_TOKEN = originalToken;
  });

  test("populates reviewDecision and checksStatus from the GraphQL response", async () => {
    const dir = await initRepoWithOrigin("https://github.com/acme/demo.git");
    globalThis.fetch = (async (input: string | URL | Request) => {
      const url = href(input);
      if (url.includes("/pulls")) return pullsResponse();
      if (url.includes("/graphql")) {
        return new Response(
          JSON.stringify({
            data: {
              repository: {
                pullRequest: {
                  reviewDecision: "APPROVED",
                  closingIssuesReferences: { nodes: [] },
                  commits: { nodes: [{ commit: { statusCheckRollup: { state: "SUCCESS" } } }] },
                },
              },
            },
          }),
          { status: 200 },
        );
      }
      throw new Error(`unexpected fetch: ${url}`);
    }) as typeof fetch;

    const result = await resolveGithubContext(dir, "feature/x");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.pullRequest?.reviewDecision).toBe("APPROVED");
    expect(result.data.pullRequest?.checksStatus).toBe("SUCCESS");
  });

  test("defaults reviewDecision/checksStatus to null when nothing has run yet", async () => {
    const dir = await initRepoWithOrigin("https://github.com/acme/demo.git");
    globalThis.fetch = (async (input: string | URL | Request) => {
      const url = href(input);
      if (url.includes("/pulls")) return pullsResponse();
      if (url.includes("/graphql")) {
        return new Response(
          JSON.stringify({
            data: {
              repository: {
                pullRequest: {
                  reviewDecision: null,
                  closingIssuesReferences: { nodes: [] },
                  commits: { nodes: [{ commit: { statusCheckRollup: null } }] },
                },
              },
            },
          }),
          { status: 200 },
        );
      }
      throw new Error(`unexpected fetch: ${url}`);
    }) as typeof fetch;

    const result = await resolveGithubContext(dir, "feature/x");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.pullRequest?.reviewDecision).toBeNull();
    expect(result.data.pullRequest?.checksStatus).toBeNull();
  });
});
