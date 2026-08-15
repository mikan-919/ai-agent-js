import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { expect, test } from "bun:test";
import type { Octokit } from "@octokit/rest";

import {
  approvalFingerprint,
  canonicalBranchName,
} from "./approval-fingerprint";
import type { DeviceTokenStore } from "./device-registration";
import type {
  ImplementationApprovalPorts,
  SealOutcome,
} from "./implementation-admission";
import { startImplementationJob } from "./implementation-job";
import type { StartImplementationWorkerOptions } from "./implementation-worker";
import { createRelayOwnershipConnection } from "./ownership-connection";
import { startFakeOwnershipRelay } from "./ownership-relay.fake";

const deviceToken = "7.11.device-token";
const repositoryId = 11;
const repository = { owner: "mikan-919", name: "oriel" };
const repositoryNodeId = "R_kgDOABCDEF";
const issueNodeId = "I_kwDOABCDEF";
const linearIssueId = "0f6f6a0c-1c1e-4a0a-9f6e-2f5f1f3f4f5f";
const baseOid = "1111111111111111111111111111111111111111";
const harnessEntry = new URL("../../harness/src/main.ts", import.meta.url)
  .pathname;

function fingerprintOf(githubTitle: string) {
  return approvalFingerprint({
    repositoryId: repositoryNodeId,
    githubIssueNodeId: issueNodeId,
    githubTitle,
    githubBody: "WHAT body",
    linearIssueUuid: linearIssueId,
    linearTitle: "HOW title",
    linearDescription: "HOW description",
  });
}

const canonicalBranch = canonicalBranchName({
  linearIdentifier: "ENG-12",
  githubIssueNumber: 28,
  approvalFingerprint: fingerprintOf("WHAT title"),
});

function tokenStore(token: string | null): DeviceTokenStore {
  return { set: async () => {}, get: async () => token };
}

function fakeOctokit(published: { bodies: string[] }) {
  return {
    rest: {
      issues: {
        createComment: async ({ body }: { body: string }) => {
          published.bodies.push(body);
          return { data: { id: published.bodies.length } };
        },
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

/** 読み直しのたびに現在値を差し替えられるports。呼び出し順も記録する。 */
function fakePorts(
  options: {
    githubTitleByRead?: (read: number) => string;
    targetBaseOidByRead?: (read: number) => string;
    stateName?: string;
    seal?: SealOutcome;
    /** 封印の直後に、別のworkerがcanonical refを動かした場合。 */
    movesSealedRefTo?: string;
    /** 同じ承認指紋のブランチが既に存在する場合の先端。 */
    existingCanonicalOid?: string;
    /** 引き継ぎ判断の後に、その先端が動いた場合。 */
    movesAdoptedRefTo?: string;
  } = {},
) {
  const calls: string[] = [];
  const refs: Record<string, string> = {};
  let reads = 0;
  let refReads = 0;
  const title = options.githubTitleByRead ?? (() => "WHAT title");
  const targetBaseOid = options.targetBaseOidByRead ?? (() => baseOid);

  if (options.existingCanonicalOid !== undefined) {
    refs[`refs/heads/${canonicalBranch}`] = options.existingCanonicalOid;
  }

  const ports: ImplementationApprovalPorts = {
    readLinearIssue: async () => {
      reads += 1;
      calls.push(`read:${reads}`);

      return {
        issueId: linearIssueId,
        identifier: "ENG-12",
        title: "HOW title",
        description: "HOW description",
        stateName: options.stateName ?? "Todo",
        attachmentUrls: ["https://github.com/mikan-919/oriel/issues/28"],
      };
    },
    resolveGitHubIssueByAttachmentUrl: async () => ({
      issueNumber: 28,
      issueNodeId,
      repositoryNodeId,
      title: title(reads),
      body: "WHAT body",
      state: "open",
    }),
    readTargetBase: async () => ({
      ref: "refs/heads/main",
      oid: targetBaseOid(reads),
    }),
    readRef: async (ref) => {
      refReads += 1;

      if (!(ref in refs)) {
        return { status: "absent" };
      }

      const oid = refs[ref]!;

      // 引き継ぎを決めた後の読み直しで、別のworkerが先端を動かした場合。
      if (options.movesAdoptedRefTo !== undefined && refReads > 1) {
        return { status: "present", oid: options.movesAdoptedRefTo };
      }

      return { status: "present", oid };
    },
    listOpenPullRequestHeadRefs: async () => [],
    checkRefFormat: async () => true,
    updateRefsAtomically: async ({ canonicalRef, expectedBaseOid }) => {
      calls.push("seal");

      const outcome = options.seal ?? "sealed";

      if (outcome === "sealed") {
        refs[canonicalRef] = options.movesSealedRefTo ?? expectedBaseOid;
      }

      return outcome;
    },
  };

  return { ports, calls, refs };
}

async function withWorkspace<T>(run: (databasePath: string) => Promise<T>) {
  const directory = await mkdtemp(join(tmpdir(), "oriel-implementation-"));

  try {
    return await run(join(directory, "serve.sqlite"));
  } finally {
    await rm(directory, { force: true, recursive: true });
  }
}

/**
 * admissionの順序を確かめるためのworker。実際のworktreeとGitは
 * `implementation-worktree.test.ts`が端から端まで確かめる。
 */
function fakeWorker(started: StartImplementationWorkerOptions[]) {
  return async (workerOptions: StartImplementationWorkerOptions) => {
    started.push(workerOptions);

    return {
      worktreePath: "/worktrees/job",
      finished: Promise.resolve(),
      jobStatus: () => "running",
      close: async () => {
        workerOptions.release();
      },
    };
  };
}

function options(
  databasePath: string,
  relayOrigin: string,
  ports: ImplementationApprovalPorts,
  startedWorkers: StartImplementationWorkerOptions[] = [],
) {
  return {
    relayOrigin,
    tokenStore: tokenStore(deviceToken),
    createOctokit: async () => fakeOctokit({ bodies: [] }),
    createPorts: () => ports,
    databasePath,
    harnessEntry,
    repositoryId,
    repository,
    linearIssueId,
    heartbeatStopMs: 500,
    repositoryRoot: "/repository",
    worktreesRoot: "/worktrees",
    remote: "origin",
    resolveCredential: async () => null,
    startWorker: fakeWorker(startedWorkers),
  };
}

test("a fully admitted approval seals the branch after ownership and only then starts a worker", async () => {
  await withWorkspace(async (databasePath) => {
    const relay = startFakeOwnershipRelay(deviceToken);
    const { ports, calls, refs } = fakePorts();
    const startedWorkers: StartImplementationWorkerOptions[] = [];
    const started = await startImplementationJob(
      options(databasePath, relay.origin, ports, startedWorkers),
    );

    try {
      expect(started.status).toBe("started");

      if (started.status !== "started") {
        return;
      }

      // Job識別子とcanonicalブランチはclientではなく現在値から導く。
      expect(started.jobId).toBe(
        `implementation:${repositoryId}:28:${fingerprintOf("WHAT title")}`,
      );
      expect(started.canonicalBranch).toBe(canonicalBranch);
      expect(started.branchLeaseId).toEqual(expect.any(String));
      expect(relay.openConnections()).toBe(2);
      expect(refs[`refs/heads/${canonicalBranch}`]).toBe(baseOid);

      // 先行read、所有権取得後のread、封印、封印後のreadの順。
      expect(calls).toEqual(["read:1", "read:2", "seal", "read:3"]);

      await started.finished;

      // workerは封印済みcanonicalブランチと、承認済みWHAT/HOWだけを受け取る。
      expect(startedWorkers).toHaveLength(1);
      expect(startedWorkers[0]!.start).toEqual({
        type: "implementation.start",
        jobId: started.jobId,
        jobLeaseId: expect.any(String),
        branchLeaseId: started.branchLeaseId,
        approvalFingerprint: fingerprintOf("WHAT title"),
        canonicalBranch,
        canonicalOid: baseOid,
        adopted: false,
        what: { title: "WHAT title", body: "WHAT body" },
        how: { title: "HOW title", description: "HOW description" },
        verification: [],
      });
      expect(startedWorkers[0]!.binding).toMatchObject({
        branchKey: `${repositoryId}/${canonicalBranch}`,
        approvalFingerprint: fingerprintOf("WHAT title"),
      });
    } finally {
      if (started.status === "started") {
        await started.close();
      }

      relay.stop();
    }
  });
});

test("the worker starts only after the current acquisition IDs and the fence are confirmed again", async () => {
  await withWorkspace(async (databasePath) => {
    const relay = startFakeOwnershipRelay(deviceToken);
    const { ports } = fakePorts();
    const started = await startImplementationJob(
      options(databasePath, relay.origin, ports),
    );

    try {
      expect(started.status).toBe("started");
      // 取得直後の置換隔離、worker開始直前のJob・ブランチ取得IDの再確認と再隔離。
      expect(relay.requests()).toEqual([
        { type: "ownership.inspect", kind: "job" },
        { type: "ownership.confirm", kind: "job" },
        { type: "ownership.confirm", kind: "branch" },
        { type: "ownership.inspect", kind: "job" },
      ]);
    } finally {
      if (started.status === "started") {
        await started.close();
      }

      relay.stop();
    }
  });
});

test("a live Job of a different approval fingerprint in the same Workflow starts no worker", async () => {
  await withWorkspace(async (databasePath) => {
    const relay = startFakeOwnershipRelay(deviceToken);
    // 同じWorkflowの、異なる承認指紋の旧Jobがまだ接続を持っている。
    const previous = createRelayOwnershipConnection({
      relayOrigin: relay.origin,
      deviceToken,
      jobId: `implementation:${repositoryId}:28:${fingerprintOf("older WHAT")}`,
      heartbeatStopMs: 500,
    });

    try {
      expect(await previous.acquireJobOwnership()).toEqual(expect.any(String));
      expect(
        await startImplementationJob(
          options(databasePath, relay.origin, fakePorts().ports),
        ),
      ).toEqual({ status: "refused", reason: "workflow_not_fenced" });

      await Bun.sleep(50);

      // 新Jobは自分の接続だけを返し、旧Jobの接続には触れない。
      expect(relay.openConnections()).toBe(1);
    } finally {
      previous.release();
      relay.stop();
    }
  });
});

test("a live branch exclusivity of a different fingerprint in the same Workflow starts no worker", async () => {
  await withWorkspace(async (databasePath) => {
    const relay = startFakeOwnershipRelay(deviceToken);
    const previous = createRelayOwnershipConnection({
      relayOrigin: relay.origin,
      deviceToken,
      // Job識別子はWorkflowの外だが、ブランチは同じWorkflowを指している。
      jobId: "pull-request:11:28",
      heartbeatStopMs: 500,
    });

    try {
      await previous.acquireJobOwnership();

      expect(
        await previous.acquireBranchExclusivity(
          `${repositoryId}/oriel/ENG-9-gh-28-${fingerprintOf("older WHAT")}`,
        ),
      ).toEqual(expect.any(String));
      expect(
        await startImplementationJob(
          options(databasePath, relay.origin, fakePorts().ports),
        ),
      ).toEqual({ status: "refused", reason: "workflow_not_fenced" });

      await Bun.sleep(50);

      expect(relay.openConnections()).toBe(2);
    } finally {
      previous.release();
      relay.stop();
    }
  });
});

test("an existing branch of the same fingerprint is adopted without writing any ref", async () => {
  await withWorkspace(async (databasePath) => {
    const relay = startFakeOwnershipRelay(deviceToken);
    const workInProgressOid = "2".repeat(40);
    const { ports, calls, refs } = fakePorts({
      existingCanonicalOid: workInProgressOid,
      // 取り込み先の前進は同じ承認を失効させない。
      targetBaseOidByRead: (read) => (read < 3 ? baseOid : "3".repeat(40)),
    });
    const started = await startImplementationJob(
      options(databasePath, relay.origin, ports),
    );

    try {
      expect(started.status).toBe("started");

      if (started.status !== "started") {
        return;
      }

      expect(started.adopted).toBe(true);
      expect(started.canonicalOid).toBe(workInProgressOid);
      // 既存Git参照を強制送信、reset、上書きしない。
      expect(calls).toEqual(["read:1", "read:2", "read:3"]);
      expect(refs[`refs/heads/${canonicalBranch}`]).toBe(workInProgressOid);
    } finally {
      if (started.status === "started") {
        await started.close();
      }

      relay.stop();
    }
  });
});

test("an existing branch whose tip moves during admission starts no worker", async () => {
  await withWorkspace(async (databasePath) => {
    const relay = startFakeOwnershipRelay(deviceToken);
    const { ports } = fakePorts({
      existingCanonicalOid: "2".repeat(40),
      movesAdoptedRefTo: "4".repeat(40),
    });

    try {
      expect(
        await startImplementationJob(
          options(databasePath, relay.origin, ports),
        ),
      ).toEqual({ status: "refused", reason: "branch_adoption_unavailable" });

      await Bun.sleep(50);

      expect(relay.openConnections()).toBe(0);
    } finally {
      relay.stop();
    }
  });
});

test("a WHAT that changed after ownership seals nothing and starts no worker", async () => {
  await withWorkspace(async (databasePath) => {
    const relay = startFakeOwnershipRelay(deviceToken);
    const { ports, calls } = fakePorts({
      githubTitleByRead: (read) => (read === 1 ? "WHAT title" : "changed"),
    });

    try {
      expect(
        await startImplementationJob(
          options(databasePath, relay.origin, ports),
        ),
      ).toEqual({ status: "refused", reason: "approval_changed" });
      expect(calls).toEqual(["read:1", "read:2"]);

      await Bun.sleep(50);

      // ブランチ排他、Job所有権の順に返し、接続を残さない。
      expect(relay.openConnections()).toBe(0);
    } finally {
      relay.stop();
    }
  });
});

test("a WHAT that changed after the seal starts no worker either", async () => {
  await withWorkspace(async (databasePath) => {
    const relay = startFakeOwnershipRelay(deviceToken);
    const { ports, calls } = fakePorts({
      githubTitleByRead: (read) => (read === 3 ? "changed" : "WHAT title"),
    });

    try {
      expect(
        await startImplementationJob(
          options(databasePath, relay.origin, ports),
        ),
      ).toEqual({ status: "refused", reason: "approval_changed" });
      expect(calls).toEqual(["read:1", "read:2", "seal", "read:3"]);

      await Bun.sleep(50);

      expect(relay.openConnections()).toBe(0);
    } finally {
      relay.stop();
    }
  });
});

test("an API that cannot seal atomically starts no worker", async () => {
  await withWorkspace(async (databasePath) => {
    const relay = startFakeOwnershipRelay(deviceToken);
    const { ports } = fakePorts({ seal: "unsupported" });

    try {
      expect(
        await startImplementationJob(
          options(databasePath, relay.origin, ports),
        ),
      ).toEqual({ status: "refused", reason: "branch_seal_unsupported" });

      await Bun.sleep(50);

      expect(relay.openConnections()).toBe(0);
    } finally {
      relay.stop();
    }
  });
});

test("a canonical branch that is not at the sealed tip starts no worker", async () => {
  await withWorkspace(async (databasePath) => {
    const relay = startFakeOwnershipRelay(deviceToken);
    const { ports } = fakePorts({ movesSealedRefTo: "9".repeat(40) });

    try {
      expect(
        await startImplementationJob(
          options(databasePath, relay.origin, ports),
        ),
      ).toEqual({ status: "refused", reason: "branch_seal_result_unknown" });

      await Bun.sleep(50);

      expect(relay.openConnections()).toBe(0);
    } finally {
      relay.stop();
    }
  });
});

test("an approval that is not current Todo takes no ownership at all", async () => {
  await withWorkspace(async (databasePath) => {
    const relay = startFakeOwnershipRelay(deviceToken);
    const { ports, calls } = fakePorts({ stateName: "Triage" });

    try {
      expect(
        await startImplementationJob(
          options(databasePath, relay.origin, ports),
        ),
      ).toEqual({ status: "refused", reason: "linear_state_not_todo" });
      expect(calls).toEqual(["read:1"]);
      expect(relay.openConnections()).toBe(0);
    } finally {
      relay.stop();
    }
  });
});

test("credentials that the product cannot resolve fail closed before any read", async () => {
  await withWorkspace(async (databasePath) => {
    const relay = startFakeOwnershipRelay(deviceToken);
    const { ports } = fakePorts();
    const base = options(databasePath, relay.origin, ports);

    try {
      expect(
        await startImplementationJob({ ...base, tokenStore: tokenStore(null) }),
      ).toEqual({ status: "refused", reason: "device_not_registered" });
      expect(
        await startImplementationJob({
          ...base,
          createOctokit: async () => null,
        }),
      ).toEqual({
        status: "refused",
        reason: "github_credentials_unavailable",
      });
      // HOWの正本へ届かないなら、実装Jobを始めない。
      expect(
        await startImplementationJob({ ...base, createPorts: () => null }),
      ).toEqual({
        status: "refused",
        reason: "linear_credentials_unavailable",
      });
      expect(relay.openConnections()).toBe(0);
    } finally {
      relay.stop();
    }
  });
});

test("a second implementation Job for the same canonical branch is refused", async () => {
  await withWorkspace(async (databasePath) => {
    const relay = startFakeOwnershipRelay(deviceToken);
    const first = await startImplementationJob(
      options(databasePath, relay.origin, fakePorts().ports),
    );

    try {
      expect(first.status).toBe("started");

      // 同じJob識別子はJob所有権で、同じ承認指紋の別Jobはブランチ排他で止まる。
      expect(
        await startImplementationJob(
          options(databasePath, relay.origin, fakePorts().ports),
        ),
      ).toEqual({ status: "refused", reason: "job_ownership_not_acquired" });

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
