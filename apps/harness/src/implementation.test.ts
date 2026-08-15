import { expect, test } from "bun:test";

import type {
  ImplementationClientMessage,
  ImplementationStartEvent,
} from "@mikan-919/oriel-contracts";

import type { LocalGit } from "./git";
import { runImplementationWorker } from "./implementation";

const digest = "a".repeat(64);
const sealedOid = "1".repeat(40);
const checkpointOid = "2".repeat(40);

function startEvent(
  overrides: Partial<ImplementationStartEvent> = {},
): ImplementationStartEvent {
  return {
    type: "implementation.start",
    jobId: `implementation:11:28:${digest}`,
    jobLeaseId: "job-lease-1",
    branchLeaseId: "branch-lease-1",
    approvalFingerprint: digest,
    canonicalBranch: `oriel/ENG-12-gh-28-${digest}`,
    canonicalOid: sealedOid,
    worktreePath: "/worktrees/job",
    adopted: false,
    what: { title: "WHAT title", body: "WHAT body" },
    how: { title: "HOW title", description: "HOW description" },
    verification: [["bun", "run", "typecheck"]],
    ...overrides,
  };
}

/**
 * worktree内のGitを模す。commitで先端が動き、それ以外は成功として答える。
 */
function fakeGit(options: { headOids?: string[]; dirty?: boolean } = {}) {
  const calls: string[][] = [];
  const heads = options.headOids ?? [sealedOid, checkpointOid];
  let revParses = 0;
  const git: LocalGit = {
    async run(args) {
      calls.push(args);

      if (args[0] === "rev-parse") {
        const head = heads[Math.min(revParses, heads.length - 1)]!;
        revParses += 1;
        return { ok: true, stdout: `${head}\n`, stderr: "" };
      }

      if (args[0] === "status") {
        return {
          ok: true,
          stdout: options.dirty === false ? "" : " M HANDOFF.md\n",
          stderr: "",
        };
      }

      return { ok: true, stdout: "", stderr: "" };
    },
  };

  return { git, calls };
}

function fakeTransport(answers: unknown[]) {
  const written: ImplementationClientMessage[] = [];
  const queue = [...answers];

  return {
    written,
    transport: {
      write(message: ImplementationClientMessage) {
        written.push(message);
      },
      read: () => Promise.resolve(queue.shift()),
    },
  };
}

function acceptedThenCompleted(requestId = "checkpoint-1") {
  return [
    { type: "checkpoint.accepted", requestId, operationId: "operation-1" },
    {
      type: "checkpoint.completed",
      requestId,
      operationId: "operation-1",
      canonicalOid: checkpointOid,
    },
  ];
}

test("the worker verifies, commits and checkpoints inside the sealed worktree", async () => {
  const { git, calls } = fakeGit();
  const { transport, written } = fakeTransport(acceptedThenCompleted());
  const commands: { command: string[]; cwd: string }[] = [];
  const files = new Map<string, string>();
  const start = startEvent();

  const outcome = await runImplementationWorker({
    start,
    transport,
    git,
    runCommand: async (command, cwd) => {
      commands.push({ command, cwd });
      return { ok: true, output: "" };
    },
    writeFile: async (path, content) => {
      files.set(path, content);
    },
  });

  // build/testは承認済みworktreeの中だけで動く。
  expect(commands).toEqual([
    { command: ["bun", "run", "typecheck"], cwd: "/worktrees/job" },
  ]);
  expect(outcome.verified).toBe(true);
  expect(outcome.checkpoint).toBe("completed");
  expect(outcome.headOid).toBe(checkpointOid);

  // 別のworkerが再開できるHANDOFFを、checkpointへ含める。
  const handoff = files.get("/worktrees/job/HANDOFF.md") ?? "";

  expect(handoff).toContain("HOW title");
  expect(handoff).toContain(start.canonicalBranch);
  expect(handoff).not.toContain(start.jobLeaseId);

  // commitは人間のGit設定を継承せず、固定の著者で行う。
  const commit = calls.find((args) => args.includes("commit")) ?? [];

  expect(commit).toContain("user.name=Oriel");
  expect(commit).toContain("user.email=oriel@oriel.invalid");

  // 送信前OIDを比較条件として渡し、credentialは一切載せない。
  expect(written).toEqual([
    {
      type: "checkpoint.request",
      requestId: "checkpoint-1",
      jobId: start.jobId,
      jobLeaseId: start.jobLeaseId,
      branchLeaseId: start.branchLeaseId,
      approvalFingerprint: digest,
      canonicalBranch: start.canonicalBranch,
      expectedOid: sealedOid,
      headOid: checkpointOid,
      verified: true,
    },
  ]);
});

test("a failing verification still checkpoints, marked as unverified work in progress", async () => {
  const { git } = fakeGit();
  const { transport, written } = fakeTransport(acceptedThenCompleted());
  const files = new Map<string, string>();

  const outcome = await runImplementationWorker({
    start: startEvent({
      verification: [
        ["bun", "run", "typecheck"],
        ["bun", "test"],
      ],
    }),
    transport,
    git,
    runCommand: async (command) => ({
      ok: command[1] !== "test",
      output: "1 failing test",
    }),
    writeFile: async (path, content) => {
      files.set(path, content);
    },
  });

  // 計画停止で検証を通せない場合も、失敗中の検証を明記したWIPを残す。
  expect(outcome.verified).toBe(false);
  expect(outcome.checkpoint).toBe("completed");
  expect(written[0]).toMatchObject({ verified: false });
  expect(files.get("/worktrees/job/HANDOFF.md")).toContain("bun test");
});

test("the worker refuses a worktree that is not at the sealed tip", async () => {
  const { git } = fakeGit({ headOids: ["9".repeat(40)] });
  const { transport, written } = fakeTransport([]);

  await expect(
    runImplementationWorker({
      start: startEvent(),
      transport,
      git,
      runCommand: async () => ({ ok: true, output: "" }),
      writeFile: async () => {},
    }),
  ).rejects.toThrow();

  // 封印した先端でなければ、検証もcommitも外部操作も始めない。
  expect(written).toEqual([]);
});

test("a rejected checkpoint is reported rather than resent", async () => {
  const { git } = fakeGit();
  const { transport, written } = fakeTransport([
    {
      type: "checkpoint.rejected",
      requestId: "checkpoint-1",
      reason: "remote_diverged",
    },
  ]);

  const outcome = await runImplementationWorker({
    start: startEvent(),
    transport,
    git,
    runCommand: async () => ({ ok: true, output: "" }),
    writeFile: async () => {},
  });

  expect(outcome.checkpoint).toBe("rejected");
  expect(outcome.checkpointRejection).toBe("remote_diverged");
  expect(written).toHaveLength(1);
});

test("a worktree with nothing to commit sends no checkpoint", async () => {
  const { git } = fakeGit({ headOids: [sealedOid], dirty: false });
  const { transport, written } = fakeTransport([]);

  const outcome = await runImplementationWorker({
    start: startEvent({ verification: [] }),
    transport,
    git,
    runCommand: async () => ({ ok: true, output: "" }),
    // HANDOFFの内容が現在の作業ツリーと同じで、差分が出ない場合。
    writeFile: async () => {},
  });

  expect(outcome.committed).toBe(false);
  expect(outcome.checkpoint).toBe("skipped");
  expect(written).toEqual([]);
});
