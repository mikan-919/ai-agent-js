import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Octokit } from "@octokit/rest";

import { startIssueCommentRuntime } from "./issue-comment-runtime";

test("runtime startup resumes persisted Issue-comment work and exposes it only through a Job-bound harness channel", async () => {
  const directory = await mkdtemp(join(tmpdir(), "oriel-issue-runtime-"));
  const databasePath = join(directory, "serve.sqlite");
  const harnessToServe = new TransformStream<Uint8Array, Uint8Array>();
  const serveToHarness = new TransformStream<Uint8Array, Uint8Array>();
  const runtime = startIssueCommentRuntime({
    databasePath,
    octokit: {
      rest: {
        issues: {
          createComment: async () => ({ data: { id: 1234 } }),
          listComments: "list-comments" as never,
          deleteComment: async () => {},
        },
        users: {
          getAuthenticated: async () => ({ data: { login: "oriel-bot" } }),
        },
      },
      paginate: async () => [],
    } as unknown as Octokit,
    ownershipVerifier: { hasCurrentJobOwnership: () => true },
  });
  const serving = runtime.serveHarnessIssueConversation(
    harnessToServe.readable,
    serveToHarness.writable,
    {
      jobId: "issue-conversation-1",
      jobLeaseId: "lease-1",
      repository: { owner: "mikan-919", name: "oriel" },
      issueNumber: 28,
    },
  );
  const input = harnessToServe.writable.getWriter();
  const output = serveToHarness.readable.getReader();

  try {
    await input.write(
      new TextEncoder().encode(
        `${JSON.stringify({
          type: "issue_comment.request",
          requestId: "request-1",
          jobId: "issue-conversation-1",
          jobLeaseId: "lease-1",
          repository: { owner: "mikan-919", name: "oriel" },
          issueNumber: 28,
          body: "Agent reply",
        })}\n`,
      ),
    );

    expect(
      JSON.parse(new TextDecoder().decode((await output.read()).value)),
    ).toMatchObject({ type: "issue_comment.accepted" });
    expect(
      JSON.parse(new TextDecoder().decode((await output.read()).value)),
    ).toMatchObject({
      type: "issue_comment.completed",
      requestId: "request-1",
      githubCommentId: 1234,
    });
  } finally {
    await input.close();
    await serving;
    output.releaseLock();
    runtime.close();
    await rm(directory, { force: true, recursive: true });
  }
});
