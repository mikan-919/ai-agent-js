import type { GitHubRepository } from "@mikan-919/oriel-contracts";
import type { Octokit } from "@octokit/rest";

import type { DeviceTokenStore } from "./device-registration";
import { startHarnessWorker } from "./harness-worker";
import {
  readImplementationApproval,
  sameApproval,
  sealCanonicalBranch,
  type ImplementationApprovalPorts,
  type ImplementationRefusalReason,
} from "./implementation-admission";
import { createRelayOwnershipConnection } from "./ownership-connection";

export interface StartImplementationJobOptions {
  relayOrigin: URL | string;
  tokenStore: DeviceTokenStore;
  /** 認証済みOctokitの解決。用意できない場合はnullでfail closedにする。 */
  createOctokit: () => Promise<Octokit | null>;
  /** WHATとHOWの現在値を読む境界。HOWへ届かない場合はnullでfail closedにする。 */
  createPorts: (
    octokit: Octokit,
  ) =>
    | ImplementationApprovalPorts
    | null
    | Promise<ImplementationApprovalPorts | null>;
  databasePath: string;
  harnessEntry: URL | string;
  repositoryId: number;
  repository: GitHubRepository;
  /** 承認されたHOWのLinear Issue。WHATはattachmentから逆引きする。 */
  linearIssueId: string;
  heartbeatStopMs: number;
}

export type StartImplementationJobResult =
  | {
      status: "started";
      jobId: string;
      canonicalBranch: string;
      branchLeaseId: string | null;
      finished: Promise<void>;
      jobStatus(): string | null;
      close(): void;
    }
  | {
      status: "refused";
      reason:
        | ImplementationRefusalReason
        | "device_not_registered"
        | "github_credentials_unavailable"
        | "linear_credentials_unavailable"
        | "job_ownership_not_acquired"
        | "branch_not_exclusive";
    };

/**
 * 実装Jobの製品経路。
 *
 * [ADR 0003](../../../docs/adr/0003-approval-admission-and-reconciliation.md)の
 * admission順序をそのまま実行する。現在値の先行read、Job所有権とブランチ排他の
 * 取得、取得後の読み直し、`updateRefs`一回だけのatomicなbranch封印、封印後の
 * 読み直しをすべて通るまでworkerを起動しない。どれか一つでも満たせなければ、
 * ブランチ排他、Job所有権の順に返して何も起動しない。
 */
export async function startImplementationJob({
  relayOrigin,
  tokenStore,
  createOctokit,
  createPorts,
  databasePath,
  harnessEntry,
  repositoryId,
  repository,
  linearIssueId,
  heartbeatStopMs,
}: StartImplementationJobOptions): Promise<StartImplementationJobResult> {
  const deviceToken = await tokenStore.get(repositoryId);

  if (deviceToken === null) {
    return { status: "refused", reason: "device_not_registered" };
  }

  const octokit = await createOctokit();

  if (octokit === null) {
    return { status: "refused", reason: "github_credentials_unavailable" };
  }

  const ports = await createPorts(octokit);

  if (ports === null) {
    return { status: "refused", reason: "linear_credentials_unavailable" };
  }

  const target = { repositoryId, linearIssueId };
  // 手順2と3: 現在値だけを読み、承認指紋、canonicalブランチ、Job識別子を導く。
  const first = await readImplementationApproval(ports, target);

  if (first.status === "refused") {
    return { status: "refused", reason: first.reason };
  }

  const approval = first.approval;
  const ownership = createRelayOwnershipConnection({
    relayOrigin,
    deviceToken,
    jobId: approval.jobId,
    heartbeatStopMs,
  });
  const jobLeaseId = await ownership.acquireJobOwnership();

  if (jobLeaseId === null) {
    ownership.release();
    return { status: "refused", reason: "job_ownership_not_acquired" };
  }

  // 手順4: 同じ`claiming`のうちに、canonicalブランチの排他も取る。
  if (
    (await ownership.acquireBranchExclusivity(
      `${repositoryId}/${approval.canonicalBranch}`,
    )) === null
  ) {
    ownership.release();
    return { status: "refused", reason: "branch_not_exclusive" };
  }

  // 手順5: 所有権を取ってからもう一度読み、同じ現在値であることを確かめる。
  const second = await readImplementationApproval(ports, target);

  if (second.status === "refused") {
    ownership.release();
    return { status: "refused", reason: second.reason };
  }

  if (!sameApproval(approval, second.approval)) {
    ownership.release();
    return { status: "refused", reason: "approval_changed" };
  }

  // 手順6と7: canonical refをatomicな比較条件付き作成だけで封印する。
  const sealed = await sealCanonicalBranch(ports, approval);

  if (sealed.status === "refused") {
    ownership.release();
    return { status: "refused", reason: sealed.reason };
  }

  // 手順8: 封印後にもう一度読み、すべて一致したときだけworkerを開始する。
  const third = await readImplementationApproval(ports, target);

  if (third.status === "refused") {
    ownership.release();
    return { status: "refused", reason: third.reason };
  }

  if (!sameApproval(approval, third.approval)) {
    ownership.release();
    return { status: "refused", reason: "approval_changed" };
  }

  const canonical = await ports.readRef(approval.canonicalRef);

  // 封印したcanonical refが、比較条件で作った先端のままであることも確かめる。
  if (
    canonical.status !== "present" ||
    canonical.oid !== approval.targetBaseOid
  ) {
    ownership.release();
    return { status: "refused", reason: "branch_seal_result_unknown" };
  }

  const worker = startHarnessWorker({
    databasePath,
    octokit,
    ownership,
    harnessEntry,
    jobId: approval.jobId,
    jobLeaseId,
    repository,
    issueNumber: approval.githubIssueNumber,
    body: `実装Jobを開始した。canonical branch: ${approval.canonicalBranch}`,
  });

  return {
    status: "started",
    jobId: approval.jobId,
    canonicalBranch: approval.canonicalBranch,
    branchLeaseId: ownership.branchLeaseId,
    finished: worker.finished,
    jobStatus: worker.jobStatus,
    close: worker.close,
  };
}
