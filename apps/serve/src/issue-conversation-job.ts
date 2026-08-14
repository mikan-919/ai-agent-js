import type { GitHubRepository } from "@mikan-919/oriel-contracts";
import type { Octokit } from "@octokit/rest";

import type { DeviceTokenStore } from "./device-registration";
import { startIssueCommentRuntime } from "./issue-comment-runtime";
import {
  createGitHubIssueConversationAdmission,
  type IssueConversationAdmission,
} from "./issue-conversation-admission";
import { createRelayOwnershipConnection } from "./ownership-connection";

export interface StartIssueConversationJobOptions {
  relayOrigin: URL | string;
  tokenStore: DeviceTokenStore;
  /**
   * 認証済みOctokitの解決。用意できない場合はnullを返し、外部書き込み経路を
   * fail closedにする。未認証clientは使わない。
   */
  createOctokit: () => Promise<Octokit | null>;
  createAdmission?: (octokit: Octokit) => IssueConversationAdmission;
  databasePath: string;
  harnessEntry: URL | string;
  repositoryId: number;
  repository: GitHubRepository;
  issueNumber: number;
  /** 人間がlocalhost UIで書いた、この対話の返答本文。 */
  body: string;
  /**
   * コードを変更するJobか。`serve`だけが決め、HTTP入力からは受け取らない。
   * 真の場合はcanonicalブランチのキーを承認指紋から導いて排他も取得する。
   */
  changesCode?: boolean;
  heartbeatStopMs: number;
}

export type StartIssueConversationJobResult =
  | {
      status: "started";
      jobId: string;
      branchLeaseId: string | null;
      /** harness processが終わるまで待つ。 */
      finished: Promise<void>;
      jobStatus(): string | null;
      close(): void;
    }
  | {
      status: "refused";
      reason:
        | "device_not_registered"
        | "github_credentials_unavailable"
        | "issue_not_found"
        | "issue_not_open"
        | "repository_mismatch"
        | "job_ownership_not_acquired"
        | "branch_not_exclusive"
        | "approval_changed";
    };

/**
 * 明示的に起動したIssue対話の製品経路。ADR 0003の受け入れ判定を通し、
 * device tokenでrelayのJob所有権を取り、credentialを持たないharness processを
 * 起動してstdioのNDJSONを`serve`の外部操作へつなぐ。
 *
 * コードを変更するJobでは、canonicalブランチのキーを承認指紋から導いて排他も
 * 取得する。ブランチ名をHTTP入力から受け取らない。LinearのTriage→Todo、
 * attachmentの逆引き、HOWの取り込み、ブランチ封印は実装Jobの受け入れ判定の
 * 範囲であり、この経路では扱わない。
 */
export async function startIssueConversationJob({
  relayOrigin,
  tokenStore,
  createOctokit,
  createAdmission = createGitHubIssueConversationAdmission,
  databasePath,
  harnessEntry,
  repositoryId,
  repository,
  issueNumber,
  body,
  changesCode = false,
  heartbeatStopMs,
}: StartIssueConversationJobOptions): Promise<StartIssueConversationJobResult> {
  const deviceToken = await tokenStore.get(repositoryId);

  if (deviceToken === null) {
    return { status: "refused", reason: "device_not_registered" };
  }

  const octokit = await createOctokit();

  if (octokit === null) {
    return { status: "refused", reason: "github_credentials_unavailable" };
  }

  const admission = createAdmission(octokit);
  const admitted = await admission.admit({
    repositoryId,
    repository,
    issueNumber,
  });

  if (admitted.status === "refused") {
    return { status: "refused", reason: admitted.reason };
  }

  const ownership = createRelayOwnershipConnection({
    relayOrigin,
    deviceToken,
    jobId: admitted.jobId,
    heartbeatStopMs,
  });
  const jobLeaseId = await ownership.acquireJobOwnership();

  if (jobLeaseId === null) {
    ownership.release();
    return { status: "refused", reason: "job_ownership_not_acquired" };
  }

  // 所有権を取得した後にもう一度読み、同じ現在値であることを確かめる。
  if (
    !(await admission.reconfirm({
      repository,
      issueNumber,
      approvalFingerprint: admitted.approvalFingerprint,
    }))
  ) {
    ownership.release();
    return { status: "refused", reason: "approval_changed" };
  }

  if (changesCode) {
    // ブランチキーは承認指紋から導く。clientは指定できない。
    const branchLeaseId = await ownership.acquireBranchExclusivity(
      `${repositoryId}/oriel/${admitted.approvalFingerprint.slice(0, 16)}`,
    );

    if (branchLeaseId === null) {
      ownership.release();
      return { status: "refused", reason: "branch_not_exclusive" };
    }
  }

  const runtime = startIssueCommentRuntime({
    databasePath,
    octokit,
    ownershipVerifier: ownership,
  });
  const binding = {
    jobId: admitted.jobId,
    jobLeaseId,
    repository,
    issueNumber,
  };
  // harnessへはcredentialを渡さない。対象と取得IDだけを引数で渡す。
  const harness = Bun.spawn(
    [
      process.execPath,
      typeof harnessEntry === "string" ? harnessEntry : harnessEntry.pathname,
      "--request",
      `${admitted.jobId}:1`,
      "--job",
      admitted.jobId,
      "--lease",
      jobLeaseId,
      "--repository",
      `${repository.owner}/${repository.name}`,
      "--issue",
      String(issueNumber),
      "--body",
      body,
    ],
    { stdin: "pipe", stdout: "pipe", stderr: "pipe", env: {} },
  );
  const stopHarness = () => harness.kill();

  ownership.stopSignal.addEventListener("abort", stopHarness, { once: true });

  const serving = runtime.serveHarnessIssueConversation(
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
    binding,
  );

  let lastJobStatus: string | null = null;
  let closed = false;
  const close = () => {
    if (closed) {
      return;
    }

    // 閉じた後も最後の実行状態を答えられるようにする。
    lastJobStatus = runtime.jobStatus(admitted.jobId);
    closed = true;
    ownership.stopSignal.removeEventListener("abort", stopHarness);
    harness.kill();
    // heartbeatとleaseを持ち続けない。
    ownership.release();
    runtime.close();
  };

  return {
    status: "started",
    jobId: admitted.jobId,
    branchLeaseId: ownership.branchLeaseId,
    finished: serving.then(async () => {
      const exitCode = await harness.exited;

      // 所有権を失っていない正常終了だけを`completed`にする。
      if (!ownership.stopSignal.aborted && exitCode === 0) {
        runtime.completeJob(admitted.jobId);
      }
    }),
    jobStatus: () =>
      closed ? lastJobStatus : runtime.jobStatus(admitted.jobId),
    close,
  };
}
