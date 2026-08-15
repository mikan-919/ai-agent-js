import type { GitHubRepository } from "@mikan-919/oriel-contracts";
import type { Octokit } from "@octokit/rest";

import type { DeviceTokenStore } from "./device-registration";
import type { GitCredential } from "./git";
import {
  readImplementationApproval,
  sameApproval,
  sealCanonicalBranch,
  workflowIsFenced,
  type ImplementationApproval,
  type ImplementationApprovalPorts,
  type ImplementationRefusalReason,
} from "./implementation-admission";
import {
  startImplementationWorker,
  type ImplementationWorker,
  type StartImplementationWorkerOptions,
} from "./implementation-worker";
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
  /** `serve`が持つrepositoryのclone、worktreeを置く領域、送信先remote。 */
  repositoryRoot: string;
  worktreesRoot: string;
  remote: string;
  /** canonicalブランチへの送信に使う、実装用途へ絞ったcredentialの解決。 */
  resolveCredential: () => Promise<GitCredential | null>;
  /**
   * worktree内で順に実行する検証command。repositoryの実行設定はまだ正本を
   * 持たないため、呼び出し側が明示した分だけを渡す。
   */
  verification?: string[][];
  startWorker?: (
    options: StartImplementationWorkerOptions,
  ) => Promise<ImplementationWorker | null>;
}

export interface StartImplementationJobRefusal {
  status: "refused";
  reason:
    | ImplementationRefusalReason
    | "device_not_registered"
    | "github_credentials_unavailable"
    | "linear_credentials_unavailable"
    | "job_ownership_not_acquired"
    | "branch_not_exclusive"
    | "canonical_worktree_unavailable";
}

export type StartImplementationJobResult =
  | {
      status: "started";
      jobId: string;
      canonicalBranch: string;
      /** 封印した先端、または引き継いだ未検証の作業途中成果の先端。 */
      canonicalOid: string;
      adopted: boolean;
      branchLeaseId: string;
      /** harnessが編集、build、test、commitを行う封印済みworktree。 */
      worktreePath: string;
      finished: Promise<void>;
      jobStatus(): string | null;
      close(): Promise<void>;
    }
  | StartImplementationJobRefusal;

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
  repositoryRoot,
  worktreesRoot,
  remote,
  resolveCredential,
  verification = [],
  startWorker = startImplementationWorker,
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

  const refuse = (
    reason: StartImplementationJobRefusal["reason"],
  ): StartImplementationJobRefusal => {
    ownership.release();
    return { status: "refused", reason };
  };

  // 手順4: ブランチ排他より先に、Workflow全体の置換隔離を事前確認する。
  if (
    !workflowIsFenced(
      await ownership.inspectOwnership(),
      approval,
      repositoryId,
    )
  ) {
    return refuse("workflow_not_fenced");
  }

  const branchKey = `${repositoryId}/${approval.canonicalBranch}`;
  const branchLeaseId = await ownership.acquireBranchExclusivity(branchKey);

  if (branchLeaseId === null) {
    return refuse("branch_not_exclusive");
  }

  // 手順5: 所有権を取ってからもう一度読み、同じ現在値であることを確かめる。
  const second = await readImplementationApproval(ports, target);

  if (second.status === "refused") {
    return refuse(second.reason);
  }

  const canonicalBefore = await ports.readRef(approval.canonicalRef);
  // 引き継ぎ候補では、取り込み先OIDの前進だけは承認を失効させない。
  const adopting = canonicalBefore.status === "present";

  if (
    !sameApproval(approval, second.approval, {
      allowTargetBaseAdvance: adopting,
    })
  ) {
    return refuse("approval_changed");
  }

  // 手順6と7: 不存在なら比較条件付き作成、既存なら同じ承認指紋の引き継ぎ。
  const sealed = await sealCanonicalBranch(ports, approval, canonicalBefore);

  if (sealed.status === "refused") {
    return refuse(sealed.reason);
  }

  // 手順8: 封印後にもう一度読み、すべて一致したときだけworkerを開始する。
  const third = await readImplementationApproval(ports, target);

  if (third.status === "refused") {
    return refuse(third.reason);
  }

  if (
    !sameApproval(approval, third.approval, {
      allowTargetBaseAdvance: adopting,
    })
  ) {
    return refuse("approval_changed");
  }

  const canonical = await ports.readRef(approval.canonicalRef);

  // 封印または引き継ぎで確認した先端のままであることも確かめる。
  if (canonical.status !== "present" || canonical.oid !== sealed.canonicalOid) {
    return refuse(
      adopting ? "branch_adoption_unavailable" : "branch_seal_result_unknown",
    );
  }

  // worker開始直前に、現在のJob・ブランチ取得IDと置換隔離を明示して再確認する。
  const current =
    (await ownership.hasCurrentJobOwnership({
      jobId: approval.jobId,
      jobLeaseId,
      repository,
      issueNumber: approval.githubIssueNumber,
    })) &&
    (await ownership.hasCurrentBranchExclusivity(branchKey, branchLeaseId));

  if (!current) {
    return refuse("ownership_not_current");
  }

  if (
    !workflowIsFenced(
      await ownership.inspectOwnership(),
      approval,
      repositoryId,
    )
  ) {
    return refuse("workflow_not_fenced");
  }

  const worker = await startWorker({
    databasePath,
    repositoryRoot,
    worktreesRoot,
    remote,
    harnessEntry,
    ownership,
    binding: {
      jobId: approval.jobId,
      jobLeaseId,
      branchLeaseId,
      branchKey,
      approvalFingerprint: approval.approvalFingerprint,
      canonicalBranch: approval.canonicalBranch,
      repository,
      issueNumber: approval.githubIssueNumber,
    },
    start: {
      type: "implementation.start",
      jobId: approval.jobId,
      jobLeaseId,
      branchLeaseId,
      approvalFingerprint: approval.approvalFingerprint,
      canonicalBranch: approval.canonicalBranch,
      canonicalOid: canonical.oid,
      adopted: sealed.status === "adopted",
      // 封印後の読みで一致したWHAT/HOWだけをworkerへ渡す。保存はしない。
      what: { title: third.content.whatTitle, body: third.content.whatBody },
      how: {
        title: third.content.howTitle,
        description: third.content.howDescription,
      },
      verification,
    },
    // 送信の直前に、現在値から承認指紋を導き直す。
    reconcileApprovalFingerprint: () =>
      currentApprovalFingerprint(ports, target, approval),
    resolveCredential,
    release: () => {
      ownership.release();
    },
  });

  if (worker === null) {
    return refuse("canonical_worktree_unavailable");
  }

  return {
    status: "started",
    jobId: approval.jobId,
    canonicalBranch: approval.canonicalBranch,
    canonicalOid: canonical.oid,
    adopted: sealed.status === "adopted",
    branchLeaseId,
    worktreePath: worker.worktreePath,
    finished: worker.finished,
    jobStatus: worker.jobStatus,
    close: worker.close,
  };
}

/**
 * 外部操作直前の再調停。現在値から導いた承認指紋を返す。
 *
 * 承認対象そのものが変わった場合は、指紋だけでなく対象の一致も確かめる。読めない、
 * または一致しない場合はnullでfail closedにする。
 */
async function currentApprovalFingerprint(
  ports: ImplementationApprovalPorts,
  target: { repositoryId: number; linearIssueId: string },
  approval: ImplementationApproval,
): Promise<string | null> {
  const current = await readImplementationApproval(ports, target);

  return current.status === "read" &&
    sameApproval(approval, current.approval, { allowTargetBaseAdvance: true })
    ? current.approval.approvalFingerprint
    : null;
}
