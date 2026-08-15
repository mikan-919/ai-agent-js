import type { ImplementationStartEvent } from "@mikan-919/oriel-contracts";

import {
  openCanonicalWorktree,
  pushCheckpoint,
  type CanonicalWorktree,
} from "./canonical-worktree";
import {
  createCheckpointOutbox,
  createCheckpointService,
  type BranchOwnershipVerifier,
  type CheckpointBinding,
} from "./checkpoint-push";
import type { GitCredential } from "./git";
import { serveOwnedHarnessImplementationIpc } from "./implementation-ipc";
import { createJobStateStore } from "./job-state";
import { openServeLocalState } from "./local-state";

export interface StartImplementationWorkerOptions {
  databasePath: string;
  /** `serve`が持つrepositoryのcloneと、worktreeを置く領域。 */
  repositoryRoot: string;
  worktreesRoot: string;
  remote: string;
  harnessEntry: URL | string;
  ownership: BranchOwnershipVerifier & { readonly stopSignal?: AbortSignal };
  binding: CheckpointBinding;
  /** worktreeを開いた後にharnessへ渡すstart event。 */
  start: Omit<ImplementationStartEvent, "worktreePath">;
  reconcileApprovalFingerprint: () => Promise<string | null>;
  resolveCredential: () => Promise<GitCredential | null>;
  release: () => void;
}

export interface ImplementationWorker {
  worktreePath: string;
  finished: Promise<void>;
  jobStatus(): string | null;
  close(): Promise<void>;
}

/**
 * 実装Jobのworker。
 *
 * 封印済みcanonicalブランチのworktreeを開き、credentialを持たないharness
 * processへその一つのworktreeと承認済みWHAT/HOWだけを渡す。遠隔Gitへの送信は
 * `serve`のcheckpoint操作としてだけ通し、所有権を失えばworkerを止める。
 * worktreeを開けない場合はworkerを起動せずnullを返す。
 */
export async function startImplementationWorker({
  databasePath,
  repositoryRoot,
  worktreesRoot,
  remote,
  harnessEntry,
  ownership,
  binding,
  start,
  reconcileApprovalFingerprint,
  resolveCredential,
  release,
}: StartImplementationWorkerOptions): Promise<ImplementationWorker | null> {
  const worktree: CanonicalWorktree | null = await openCanonicalWorktree({
    repositoryRoot,
    worktreesRoot,
    jobId: binding.jobId,
    canonicalBranch: start.canonicalBranch,
    canonicalOid: start.canonicalOid,
    remote,
    credential: await resolveCredential(),
  });

  if (worktree === null) {
    return null;
  }

  const database = openServeLocalState(databasePath);
  const jobState = createJobStateStore(database);
  const service = createCheckpointService({
    outbox: createCheckpointOutbox(database),
    binding,
    ownership,
    reconcileApprovalFingerprint,
    resolveCredential,
    push: (input) =>
      pushCheckpoint({ ...input, worktreePath: worktree.path, remote }),
  });

  // harnessへはcredentialを渡さない。承認済みの対象だけをstdinのstart eventで渡す。
  const harness = Bun.spawn(
    [
      process.execPath,
      typeof harnessEntry === "string" ? harnessEntry : harnessEntry.pathname,
      "--mode",
      "implementation",
    ],
    {
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
      /**
       * harnessが必要とするのはcommandを見つけるPATHだけとする。credentialも、
       * 利用者のglobal Git設定やcredential helperも継承させない。
       */
      env: {
        PATH: Bun.env.PATH ?? "",
        GIT_CONFIG_GLOBAL: "/dev/null",
        GIT_CONFIG_NOSYSTEM: "1",
        GIT_TERMINAL_PROMPT: "0",
        GIT_ASKPASS: "",
      },
    },
  );
  const stopHarness = () => harness.kill();
  let running = !(ownership.stopSignal?.aborted ?? false);

  jobState.set(binding.jobId, running ? "running" : "interrupted");
  ownership.stopSignal?.addEventListener("abort", stopHarness, { once: true });
  ownership.stopSignal?.addEventListener("abort", () => {
    if (running) {
      running = false;
      jobState.set(binding.jobId, "interrupted");
    }
  });

  const serving = serveOwnedHarnessImplementationIpc(
    harness.stdout,
    new WritableStream<Uint8Array>({
      write(chunk) {
        harness.stdin.write(chunk);
        harness.stdin.flush();
      },
      close() {
        harness.stdin.end();
      },
    }),
    { ...start, worktreePath: worktree.path },
    service,
    ownership.stopSignal,
  );

  let lastJobStatus: string | null = null;
  let closed = false;

  return {
    worktreePath: worktree.path,
    finished: serving.then(async () => {
      const exitCode = await harness.exited;

      // 所有権を失っていない正常終了だけを`completed`にする。
      if (running && exitCode === 0) {
        running = false;
        jobState.set(binding.jobId, "completed");
      }
    }),
    jobStatus: () => (closed ? lastJobStatus : jobState.get(binding.jobId)),
    async close() {
      if (closed) {
        return;
      }

      lastJobStatus = jobState.get(binding.jobId);
      closed = true;
      ownership.stopSignal?.removeEventListener("abort", stopHarness);
      harness.kill();
      // heartbeatと取得IDを持ち続けない。
      release();
      database.close();
      // 復元可能でcleanなsandboxだけを消す。
      await worktree.remove();
    },
  };
}
