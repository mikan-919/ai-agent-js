import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runTicketExtractionPass, runTicketPollPass } from "./ticketRun";

const owner = "acme";
const repo = "demo";
const token = "fake-token";

async function git(cwd: string, args: string[]): Promise<void> {
  const proc = Bun.spawn(["git", ...args], { cwd, stdout: "ignore", stderr: "ignore" });
  const exitCode = await proc.exited;
  if (exitCode !== 0) throw new Error(`git ${args.join(" ")} failed with code ${exitCode}`);
}

async function initRepoWithoutRemote(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "nook-ticket-run-noremote-"));
  await git(dir, ["init", "-q", "-b", "main"]);
  await git(dir, ["config", "user.email", "test@example.com"]);
  await git(dir, ["config", "user.name", "test"]);
  await git(dir, ["commit", "-q", "--allow-empty", "-m", "initial"]);
  return dir;
}

async function initRepoWithRemote(): Promise<string> {
  const dir = await initRepoWithoutRemote();
  await git(dir, ["remote", "add", "origin", `git@github.com:${owner}/${repo}.git`]);
  return dir;
}

const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

function href(input: string | URL | Request): string {
  if (typeof input === "string") return input;
  if (input instanceof URL) return input.href;
  return input.url;
}

function withFetch<T>(handler: (url: string, init?: RequestInit) => Response, fn: () => Promise<T>): Promise<T> {
  const original = globalThis.fetch;
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => handler(href(input), init)) as typeof fetch;
  return fn().finally(() => {
    globalThis.fetch = original;
  });
}

describe("runTicketExtractionPass", () => {
  test("fails fast when the repo has no origin remote, without any network calls", async () => {
    const dir = await initRepoWithoutRemote();
    dirs.push(dir);

    const result = await runTicketExtractionPass(dir, token);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain("could not determine owner/repo");
    expect(result.createdCount).toBe(0);
  });
});

describe("runTicketPollPass", () => {
  test("throws when the repo has no origin remote", async () => {
    const dir = await initRepoWithoutRemote();
    dirs.push(dir);

    await expect(runTicketPollPass(dir, token)).rejects.toThrow("could not determine owner/repo");
  });

  test("skips every issue whose latest comment is already nook's own, replying to none", async () => {
    const dir = await initRepoWithRemote();
    dirs.push(dir);

    const result = await withFetch(
      (url) => {
        if (url === "https://api.github.com/user") {
          return new Response(JSON.stringify({ login: "nook-bot" }));
        }
        if (url.startsWith(`https://api.github.com/repos/${owner}/${repo}/issues?state=open&labels=`)) {
          return new Response(
            JSON.stringify([
              { number: 1, title: "Gap A", body: "detail", html_url: "https://x/1" },
              { number: 2, title: "Gap B", body: "detail", html_url: "https://x/2" },
            ]),
          );
        }
        if (url === `https://api.github.com/repos/${owner}/${repo}/issues/1/comments?per_page=100`) {
          return new Response(JSON.stringify([{ user: { login: "nook-bot" }, body: "on it" }]));
        }
        if (url === `https://api.github.com/repos/${owner}/${repo}/issues/2/comments?per_page=100`) {
          return new Response(JSON.stringify([{ user: { login: "nook-bot" }, body: "acknowledged" }]));
        }
        throw new Error(`unhandled fake GitHub request: ${url}`);
      },
      () => runTicketPollPass(dir, token),
    );

    expect(result).toEqual({ repliedCount: 0, checkedCount: 2, errors: [] });
  });

  test("records a per-issue error and keeps going when a reply attempt's sandbox setup fails", async () => {
    const dir = await initRepoWithRemote();
    dirs.push(dir);

    const result = await withFetch(
      (url) => {
        if (url === "https://api.github.com/user") {
          return new Response(JSON.stringify({ login: "nook-bot" }));
        }
        if (url.startsWith(`https://api.github.com/repos/${owner}/${repo}/issues?state=open&labels=`)) {
          return new Response(JSON.stringify([{ number: 10, title: "Gap C", body: "detail", html_url: "https://x/10" }]));
        }
        if (url === `https://api.github.com/repos/${owner}/${repo}/issues/10/comments?per_page=100`) {
          return new Response(JSON.stringify([{ user: { login: "human" }, body: "please clarify" }]));
        }
        // Reaching this means the poll pass tried to acquire the branch
        // lock / sandbox for a reply — deliberately unmocked so the attempt
        // fails and the failure surfaces in `errors` instead of throwing.
        throw new Error("lock API unavailable in this test");
      },
      () => runTicketPollPass(dir, token),
    );

    expect(result.repliedCount).toBe(0);
    expect(result.checkedCount).toBe(1);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]).toContain("issue #10");
  });
});
