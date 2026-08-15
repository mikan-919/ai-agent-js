import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { expect, test } from "bun:test";

import type { CheckpointBinding } from "./checkpoint-push";
import { runGit } from "./git";
import { startImplementationWorker } from "./implementation-worker";

/** 実際のsystem Gitとharness processを動かすため、既定の5秒では足りない。 */
const gitTestTimeoutMs = 120_000;

const digest = "a".repeat(64);
const canonicalBranch = `oriel/ENG-12-gh-28-${digest}`;
const jobId = `implementation:11:28:${digest}`;
const harnessEntry = new URL("../../harness/src/main.ts", import.meta.url)
  .pathname;

const binding: CheckpointBinding = {
  jobId,
  jobLeaseId: "job-lease-1",
  branchLeaseId: "branch-lease-1",
  branchKey: `11/${canonicalBranch}`,
  approvalFingerprint: digest,
  canonicalBranch,
  repository: { owner: "mikan-919", name: "oriel" },
  issueNumber: 28,
};

async function git(cwd: string, ...args: string[]) {
  const result = await runGit(args, { cwd });

  if (!result.ok) {
    throw new Error(`git ${args.join(" ")} failed: ${result.stderr}`);
  }

  return result.stdout.trim();
}

/** canonicalブランチを封印済みとして持つbare remoteと、`serve`側のcloneを作る。 */
async function withSealedRepository<T>(
  run: (context: {
    databasePath: string;
    repositoryRoot: string;
    worktreesRoot: string;
    remote: string;
    canonicalOid: string;
  }) => Promise<T>,
) {
  const directory = await mkdtemp(join(tmpdir(), "oriel-implementation-e2e-"));
  const remote = join(directory, "remote.git");
  const seed = join(directory, "seed");
  const repositoryRoot = join(directory, "clone");
  const author = ["-c", "user.email=t@t", "-c", "user.name=t"];

  try {
    await git(directory, "init", "--bare", "--initial-branch=main", remote);
    await git(directory, "clone", "--quiet", remote, seed);
    await writeFile(join(seed, "README.md"), "seed\n");
    await git(seed, ...author, "add", "-A");
    await git(seed, ...author, "commit", "--quiet", "-m", "seed");
    await git(seed, "push", "--quiet", "origin", `HEAD:${canonicalBranch}`);
    await git(seed, "push", "--quiet", "origin", "HEAD:main");
    await git(directory, "clone", "--quiet", remote, repositoryRoot);

    return await run({
      databasePath: join(directory, "serve.sqlite"),
      repositoryRoot,
      worktreesRoot: join(directory, "worktrees"),
      remote,
      canonicalOid: await git(seed, "rev-parse", "HEAD"),
    });
  } finally {
    await rm(directory, { force: true, recursive: true });
  }
}

function ownership(current = true) {
  return {
    hasCurrentJobOwnership: () => current,
    hasCurrentBranchExclusivity: () => current,
  };
}

test(
  "the sealed branch becomes a worktree the harness verifies, commits and checkpoints",
  async () => {
    await withSealedRepository(async (context) => {
      const released: boolean[] = [];
      const worker = await startImplementationWorker({
        databasePath: context.databasePath,
        repositoryRoot: context.repositoryRoot,
        worktreesRoot: context.worktreesRoot,
        remote: context.remote,
        harnessEntry,
        ownership: ownership(),
        binding,
        start: {
          type: "implementation.start",
          jobId,
          jobLeaseId: binding.jobLeaseId,
          branchLeaseId: binding.branchLeaseId,
          approvalFingerprint: digest,
          canonicalBranch,
          canonicalOid: context.canonicalOid,
          adopted: false,
          what: { title: "WHAT title", body: "WHAT body" },
          how: { title: "HOW title", description: "HOW description" },
          // worktree内でbuild/testに相当するcommandを実際に走らせる。
          verification: [["git", "--version"]],
        },
        reconcileApprovalFingerprint: async () => digest,
        resolveCredential: async () => ({
          username: "x-access-token",
          token: "installation",
        }),
        release: () => released.push(true),
      });

      if (worker === null) {
        throw new Error("the canonical worktree was not opened");
      }

      try {
        await worker.finished;

        // harnessが封印済み先端の上でcommitし、`serve`が遠隔へ送った。
        const remoteTip = (
          await git(
            context.repositoryRoot,
            "ls-remote",
            context.remote,
            `refs/heads/${canonicalBranch}`,
          )
        ).split("\t")[0];

        expect(remoteTip).not.toBe(context.canonicalOid);
        expect(await git(worker.worktreePath, "rev-parse", "HEAD")).toBe(
          remoteTip,
        );
        // 引き継ぎ先が再開できるHANDOFFがcheckpointへ入っている。
        expect(
          await git(
            worker.worktreePath,
            "show",
            "--name-only",
            "--format=",
            "HEAD",
          ),
        ).toContain("HANDOFF.md");
        expect(worker.jobStatus()).toBe("completed");
      } finally {
        await worker.close();
      }

      expect(released).toEqual([true]);
    });
  },
  gitTestTimeoutMs,
);

test(
  "a checkpoint without the current acquisition IDs never reaches the remote",
  async () => {
    await withSealedRepository(async (context) => {
      const worker = await startImplementationWorker({
        databasePath: context.databasePath,
        repositoryRoot: context.repositoryRoot,
        worktreesRoot: context.worktreesRoot,
        remote: context.remote,
        harnessEntry,
        // 所有権を失った`serve`は新しい外部操作を通さない。
        ownership: ownership(false),
        binding,
        start: {
          type: "implementation.start",
          jobId,
          jobLeaseId: binding.jobLeaseId,
          branchLeaseId: binding.branchLeaseId,
          approvalFingerprint: digest,
          canonicalBranch,
          canonicalOid: context.canonicalOid,
          adopted: false,
          what: { title: "WHAT title", body: "WHAT body" },
          how: { title: "HOW title", description: "HOW description" },
          verification: [],
        },
        reconcileApprovalFingerprint: async () => digest,
        resolveCredential: async () => ({
          username: "x-access-token",
          token: "installation",
        }),
        release: () => {},
      });

      if (worker === null) {
        throw new Error("the canonical worktree was not opened");
      }

      try {
        await worker.finished;

        // ローカルのcommitは残るが、遠隔のcanonicalブランチは動かない。
        expect(
          await git(
            context.repositoryRoot,
            "ls-remote",
            context.remote,
            `refs/heads/${canonicalBranch}`,
          ),
        ).toContain(context.canonicalOid);
      } finally {
        await worker.close();
      }
    });
  },
  gitTestTimeoutMs,
);

test(
  "a tip that no longer matches the sealed OID starts no worker at all",
  async () => {
    await withSealedRepository(async (context) => {
      expect(
        await startImplementationWorker({
          databasePath: context.databasePath,
          repositoryRoot: context.repositoryRoot,
          worktreesRoot: context.worktreesRoot,
          remote: context.remote,
          harnessEntry,
          ownership: ownership(),
          binding,
          start: {
            type: "implementation.start",
            jobId,
            jobLeaseId: binding.jobLeaseId,
            branchLeaseId: binding.branchLeaseId,
            approvalFingerprint: digest,
            canonicalBranch,
            canonicalOid: "9".repeat(40),
            adopted: false,
            what: { title: "WHAT title", body: "WHAT body" },
            how: { title: "HOW title", description: "HOW description" },
            verification: [],
          },
          reconcileApprovalFingerprint: async () => digest,
          resolveCredential: async () => null,
          release: () => {},
        }),
      ).toBeNull();
    });
  },
  gitTestTimeoutMs,
);
