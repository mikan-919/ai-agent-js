import { describe, expect, test } from "bun:test";
import {
  createCreateIssueTool,
  createReplyToIssueTool,
  getAuthenticatedLogin,
  listIssueComments,
  listOpenIssues,
  listProposedIssues,
} from "./ticketTools";

function href(input: string | URL | Request): string {
  if (typeof input === "string") return input;
  if (input instanceof URL) return input.href;
  return input.url;
}

function withFetch<T>(handler: (url: string) => Response, fn: () => Promise<T>): Promise<T> {
  const original = globalThis.fetch;
  globalThis.fetch = (async (input: string | URL | Request) => handler(href(input))) as typeof fetch;
  return fn().finally(() => {
    globalThis.fetch = original;
  });
}

describe("listOpenIssues", () => {
  test("excludes pull requests from the issues endpoint", async () => {
    const issues = await withFetch(
      () =>
        new Response(
          JSON.stringify([
            { number: 1, title: "A real issue", body: null, html_url: "https://x/1" },
            { number: 2, title: "A PR", body: null, html_url: "https://x/2", pull_request: { url: "https://x" } },
          ]),
        ),
      () => listOpenIssues("acme", "demo", "token"),
    );
    expect(issues).toEqual([{ number: 1, title: "A real issue", url: "https://x/1" }]);
  });
});

describe("listProposedIssues", () => {
  test("returns issue body alongside title/url", async () => {
    const issues = await withFetch(
      () =>
        new Response(JSON.stringify([{ number: 5, title: "Gap X", body: "detail", html_url: "https://x/5" }])),
      () => listProposedIssues("acme", "demo", "token"),
    );
    expect(issues).toEqual([{ number: 5, title: "Gap X", body: "detail", url: "https://x/5" }]);
  });
});

describe("listIssueComments", () => {
  test("defaults a missing user/body to empty rather than throwing", async () => {
    const comments = await withFetch(
      () => new Response(JSON.stringify([{ user: { login: "alice" }, body: "hi" }, { user: null, body: null }])),
      () => listIssueComments("acme", "demo", 5, "token"),
    );
    expect(comments).toEqual([
      { login: "alice", body: "hi" },
      { login: "", body: "" },
    ]);
  });
});

describe("getAuthenticatedLogin", () => {
  test("returns the token's login", async () => {
    const login = await withFetch(() => new Response(JSON.stringify({ login: "nook-bot" })), () =>
      getAuthenticatedLogin("token"),
    );
    expect(login).toBe("nook-bot");
  });
});

describe("create_issue tool", () => {
  test("creates an issue and increments createdCount", async () => {
    const createdCount = { current: 0 };
    const tool = createCreateIssueTool({ owner: "acme", repo: "demo", token: "token", maxIssues: 2, createdCount });

    const result = await withFetch(
      () => new Response(JSON.stringify({ number: 9, html_url: "https://x/9" }), { status: 201 }),
      () => tool.execute("call-1", { title: "New gap", body: "details" }, new AbortController().signal),
    );

    expect(createdCount.current).toBe(1);
    expect(result.content).toEqual([{ type: "text", text: "created issue #9: https://x/9" }]);
  });

  test("refuses once the per-run cap is reached", async () => {
    const createdCount = { current: 2 };
    const tool = createCreateIssueTool({ owner: "acme", repo: "demo", token: "token", maxIssues: 2, createdCount });
    await expect(tool.execute("call-1", { title: "t", body: "b" }, new AbortController().signal)).rejects.toThrow(
      "reached the limit of 2 issue(s)",
    );
  });
});

describe("reply_to_issue tool", () => {
  test("posts a comment on the issue it's bound to", async () => {
    const tool = createReplyToIssueTool({ owner: "acme", repo: "demo", token: "token", issueNumber: 5 });

    const result = await withFetch(
      () => new Response(JSON.stringify({ html_url: "https://x/5#comment" }), { status: 201 }),
      () => tool.execute("call-1", { body: "thanks!" }, new AbortController().signal),
    );

    expect(result.content).toEqual([{ type: "text", text: "replied on issue #5: https://x/5#comment" }]);
  });
});
