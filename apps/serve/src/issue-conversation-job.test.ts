import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { expect, test } from "bun:test";
import type { Octokit } from "@octokit/rest";

import type { DeviceTokenStore } from "./device-registration";
import { startIssueConversationJob } from "./issue-conversation-job";
import { startFakeOwnershipRelay } from "./ownership-relay.fake";

const deviceToken = "7.11.device-token";
const repositoryId = 11;
const repository = { owner: "mikan-919", name: "oriel" };
const jobId = "issue-conversation-1";

function tokenStore(token: string | null): DeviceTokenStore {
  return {
    set: async () => {},
    get: async () => token,
  };
}

function fakeOctokit(published: { count: number }) {
  return {
    rest: {
      issues: {
        createComment: async () => ({ data: { id: (published.count += 1) } }),
        listComments: "list-comments" as never,
        deleteComment: async () => {},
      },
      users: {
        getAuthenticated: async () => ({ data: { login: "oriel-bot" } }),
      },
    },
    paginate: async () => [],
  } as unknown as Octokit;
}

async function withWorkspace<T>(run: (databasePath: string) => Promise<T>) {
  const directory = await mkdtemp(join(tmpdir(), "oriel-conversation-"));

  try {
    return await run(join(directory, "serve.sqlite"));
  } finally {
    await rm(directory, { force: true, recursive: true });
  }
}

test("an explicit Issue conversation takes relay ownership from the stored device token before a worker runs", async () => {
  await withWorkspace(async (databasePath) => {
    const relay = startFakeOwnershipRelay(deviceToken);
    const published = { count: 0 };
    const started = await startIssueConversationJob({
      relayOrigin: relay.origin,
      tokenStore: tokenStore(deviceToken),
      databasePath,
      octokit: fakeOctokit(published),
      repositoryId,
      repository,
      jobId,
      issueNumber: 28,
      canonicalBranch: "oriel/job-1",
      heartbeatStopMs: 500,
    });

    try {
      expect(started.status).toBe("started");
      expect(relay.authorizationHeaders()).toEqual([
        `Bearer ${deviceToken}`,
        `Bearer ${deviceToken}`,
      ]);
      expect(relay.openConnections()).toBe(2);

      if (started.status !== "started") {
        return;
      }

      const harnessToServe = new TransformStream<Uint8Array, Uint8Array>();
      const serveToHarness = new TransformStream<Uint8Array, Uint8Array>();
      const serving = started.runtime.serveHarnessIssueConversation(
        harnessToServe.readable,
        serveToHarness.writable,
        started.binding,
      );
      const input = harnessToServe.writable.getWriter();
      const output = serveToHarness.readable.getReader();

      expect(started.runtime.jobStatus(jobId)).toBe("running");

      await input.write(
        new TextEncoder().encode(
          `${JSON.stringify({
            type: "issue_comment.request",
            requestId: "request-1",
            ...started.binding,
            body: "Agent reply",
          })}\n`,
        ),
      );

      expect(
        JSON.parse(new TextDecoder().decode((await output.read()).value)),
      ).toMatchObject({ type: "issue_comment.accepted" });
      expect(
        JSON.parse(new TextDecoder().decode((await output.read()).value)),
      ).toMatchObject({ type: "issue_comment.completed" });
      expect(published.count).toBe(1);

      // relayがdeviceを失効させ、Job所有権とブランチ排他の両方を閉じる。
      relay.revokeDevice();
      await Bun.sleep(50);

      expect(relay.openConnections()).toBe(0);
      expect(started.runtime.jobStatus(jobId)).toBe("interrupted");

      const refusedWrite = await input
        .write(
          new TextEncoder().encode(
            `${JSON.stringify({
              type: "issue_comment.request",
              requestId: "request-after-revocation",
              ...started.binding,
              body: "Agent reply after revocation",
            })}\n`,
          ),
        )
        .then(
          () => "accepted",
          () => "refused",
        );

      expect(refusedWrite).toBe("refused");
      await input.close().catch(() => undefined);
      await serving;
      output.releaseLock();

      expect(published.count).toBe(1);
    } finally {
      if (started.status === "started") {
        started.close();
      }

      relay.stop();
    }
  });
});

test("no worker runs without a registered device or without relay ownership", async () => {
  await withWorkspace(async (databasePath) => {
    const relay = startFakeOwnershipRelay(deviceToken);
    const options = {
      relayOrigin: relay.origin,
      databasePath,
      octokit: fakeOctokit({ count: 0 }),
      repositoryId,
      repository,
      jobId,
      issueNumber: 28,
      heartbeatStopMs: 500,
    };

    try {
      expect(
        await startIssueConversationJob({
          ...options,
          tokenStore: tokenStore(null),
        }),
      ).toEqual({ status: "refused", reason: "device_not_registered" });

      const holder = await startIssueConversationJob({
        ...options,
        tokenStore: tokenStore(deviceToken),
      });

      expect(holder.status).toBe("started");
      expect(
        await startIssueConversationJob({
          ...options,
          tokenStore: tokenStore(deviceToken),
        }),
      ).toEqual({ status: "refused", reason: "job_ownership_not_acquired" });

      if (holder.status === "started") {
        holder.close();
      }
    } finally {
      relay.stop();
    }
  });
});

test("a Job that changes code is refused when the canonical branch is already exclusive", async () => {
  await withWorkspace(async (databasePath) => {
    const relay = startFakeOwnershipRelay(deviceToken);
    const options = {
      relayOrigin: relay.origin,
      tokenStore: tokenStore(deviceToken),
      databasePath,
      octokit: fakeOctokit({ count: 0 }),
      repositoryId,
      repository,
      issueNumber: 28,
      canonicalBranch: "oriel/job-1",
      heartbeatStopMs: 500,
    };
    const first = await startIssueConversationJob({ ...options, jobId });
    const second = await startIssueConversationJob({
      ...options,
      jobId: "issue-conversation-2",
    });

    try {
      expect(first.status).toBe("started");
      expect(second).toEqual({
        status: "refused",
        reason: "branch_not_exclusive",
      });
      // ブランチ排他を取れなかったJobは、取ったJob所有権も解放する。
      await Bun.sleep(50);

      expect(relay.openConnections()).toBe(2);
    } finally {
      if (first.status === "started") {
        first.close();
      }

      relay.stop();
    }
  });
});
