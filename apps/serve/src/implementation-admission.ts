import {
  approvalFingerprint,
  canonicalBranchName,
  canonicalRefName,
} from "./approval-fingerprint";

/**
 * 実装Jobの正式なadmission。
 *
 * [ADR 0003](../../../docs/adr/0003-approval-admission-and-reconciliation.md)の
 * 手順2〜7のうち、外部の現在値だけから決まる部分をここに置く。所有権の取得、
 * 二度目・三度目の読み直しの順序、workerの起動は`implementation-job.ts`が持つ。
 *
 * 満たせない入力とprovider APIの能力不足はすべてfail closedにする。弱いcreate
 * APIや逐次更新へのfallbackはしない。
 */
export interface LinearApprovalSnapshot {
  /** Linear IssueのUUID。 */
  issueId: string;
  identifier: string;
  title: string;
  description: string | null;
  /** 現在のworkflow state名。実行承認はTodoだけとする。 */
  stateName: string;
  attachmentUrls: string[];
}

export interface GitHubIssueSnapshot {
  issueNumber: number;
  issueNodeId: string;
  repositoryNodeId: string;
  title: string;
  body: string | null;
  state: string;
}

export type RefRead =
  | { status: "present"; oid: string }
  | { status: "absent" }
  /** 読めなかった。存在の有無を決めない。 */
  | { status: "unknown" };

export type SealOutcome =
  | "sealed"
  | "rejected"
  /** installation/tokenがatomicな`updateRefs`を使えない。 */
  | "unsupported"
  /** timeout、切断、曖昧な応答。送ったかどうかを決めない。 */
  | "unknown";

export interface ImplementationApprovalPorts {
  readLinearIssue(
    linearIssueId: string,
  ): Promise<LinearApprovalSnapshot | null>;
  /** attachment URLから対象repositoryのIssueを逆引きする。対象外はnull。 */
  resolveGitHubIssueByAttachmentUrl(
    url: string,
  ): Promise<GitHubIssueSnapshot | null>;
  /** 取り込み先Git参照とその現在OID。 */
  readTargetBase(): Promise<{ ref: string; oid: string } | null>;
  readRef(qualifiedRef: string): Promise<RefRead>;
  /** 開いているプルリクエストのhead ref。読めない場合はnull。 */
  listOpenPullRequestHeadRefs(): Promise<string[] | null>;
  checkRefFormat(branch: string): Promise<boolean>;
  /** GraphQLの`updateRefs`一回だけで作る比較条件付きの作成。 */
  updateRefsAtomically(input: {
    repositoryNodeId: string;
    baseRef: string;
    expectedBaseOid: string;
    canonicalRef: string;
  }): Promise<SealOutcome>;
}

export interface ImplementationApproval {
  jobId: string;
  approvalFingerprint: string;
  canonicalBranch: string;
  canonicalRef: string;
  targetBaseRef: string;
  targetBaseOid: string;
  githubIssueNumber: number;
  githubIssueNodeId: string;
  githubRepositoryNodeId: string;
  linearIssueId: string;
  linearIdentifier: string;
}

export type ImplementationRefusalReason =
  | "linear_issue_not_found"
  | "linear_state_not_todo"
  | "github_issue_not_uniquely_attached"
  | "github_issue_not_open"
  | "approval_fingerprint_unavailable"
  | "canonical_branch_unavailable"
  | "target_base_unavailable"
  | "pull_request_state_unknown"
  | "workflow_pull_request_open"
  | "approval_changed"
  | "branch_adoption_unavailable"
  | "branch_seal_unsupported"
  | "branch_seal_rejected"
  | "branch_seal_result_unknown";

export type ImplementationApprovalRead =
  | { status: "read"; approval: ImplementationApproval }
  | { status: "refused"; reason: ImplementationRefusalReason };

export type SealResult =
  | { status: "sealed" }
  | { status: "refused"; reason: ImplementationRefusalReason };

/** 実行承認とみなすLinearのworkflow state名。 */
const approvedStateName = "Todo";

function refused(reason: ImplementationRefusalReason): {
  status: "refused";
  reason: ImplementationRefusalReason;
} {
  return { status: "refused", reason };
}

/** 現在値だけから承認指紋、canonicalブランチ、Job識別子を導く読み取り。 */
export async function readImplementationApproval(
  ports: ImplementationApprovalPorts,
  {
    repositoryId,
    linearIssueId,
  }: { repositoryId: number; linearIssueId: string },
): Promise<ImplementationApprovalRead> {
  const linear = await ports.readLinearIssue(linearIssueId);

  if (linear === null) {
    return refused("linear_issue_not_found");
  }

  if (linear.stateName !== approvedStateName) {
    return refused("linear_state_not_todo");
  }

  const resolved = await Promise.all(
    linear.attachmentUrls.map((url) =>
      ports.resolveGitHubIssueByAttachmentUrl(url),
    ),
  );
  const issues = new Map<string, GitHubIssueSnapshot>();

  for (const issue of resolved) {
    if (issue !== null) {
      issues.set(issue.issueNodeId, issue);
    }
  }

  if (issues.size !== 1) {
    return refused("github_issue_not_uniquely_attached");
  }

  const [issue] = [...issues.values()];

  if (issue === undefined || issue.state.toLowerCase() !== "open") {
    return refused("github_issue_not_open");
  }

  let fingerprint;

  try {
    fingerprint = approvalFingerprint({
      repositoryId: issue.repositoryNodeId,
      githubIssueNodeId: issue.issueNodeId,
      githubTitle: issue.title,
      githubBody: issue.body,
      linearIssueUuid: linear.issueId,
      linearTitle: linear.title,
      linearDescription: linear.description,
    });
  } catch {
    return refused("approval_fingerprint_unavailable");
  }

  let canonicalBranch;

  try {
    canonicalBranch = canonicalBranchName({
      linearIdentifier: linear.identifier,
      githubIssueNumber: issue.issueNumber,
      approvalFingerprint: fingerprint,
    });
  } catch {
    return refused("canonical_branch_unavailable");
  }

  if (!(await ports.checkRefFormat(canonicalBranch))) {
    return refused("canonical_branch_unavailable");
  }

  const base = await ports.readTargetBase();

  if (base === null) {
    return refused("target_base_unavailable");
  }

  // Workflow全体の置換隔離。実装中はプルリクエストが存在してはならない。
  const openHeadRefs = await ports.listOpenPullRequestHeadRefs();

  if (openHeadRefs === null) {
    return refused("pull_request_state_unknown");
  }

  const workflowPrefix = canonicalBranch.slice(0, -fingerprint.length);

  if (openHeadRefs.some((headRef) => headRef.startsWith(workflowPrefix))) {
    return refused("workflow_pull_request_open");
  }

  return {
    status: "read",
    approval: {
      jobId: `implementation:${repositoryId}:${issue.issueNumber}:${fingerprint}`,
      approvalFingerprint: fingerprint,
      canonicalBranch,
      canonicalRef: canonicalRefName(canonicalBranch),
      targetBaseRef: base.ref,
      targetBaseOid: base.oid,
      githubIssueNumber: issue.issueNumber,
      githubIssueNodeId: issue.issueNodeId,
      githubRepositoryNodeId: issue.repositoryNodeId,
      linearIssueId: linear.issueId,
      linearIdentifier: linear.identifier,
    },
  };
}

/** 二つの読み取りが同じ承認対象を指すか。 */
export function sameApproval(
  first: ImplementationApproval,
  second: ImplementationApproval,
): boolean {
  return JSON.stringify(first) === JSON.stringify(second);
}

/**
 * ADR 0003手順6と7。canonical refが不存在のときだけ、target baseの不変と
 * canonical refの不存在を同じatomic updateの比較条件にして一回だけ作る。
 * 曖昧な応答は再送せず、read-backで確定できたときだけsealとする。
 */
export async function sealCanonicalBranch(
  ports: ImplementationApprovalPorts,
  approval: ImplementationApproval,
): Promise<SealResult> {
  const canonical = await ports.readRef(approval.canonicalRef);

  if (canonical.status === "unknown") {
    return refused("approval_changed");
  }

  // 既存の同指紋ブランチの引き継ぎはADR 0004の範囲であり、ここでは行わない。
  // 強制送信、reset、上書きはしない。
  if (canonical.status === "present") {
    return refused("branch_adoption_unavailable");
  }

  const base = await ports.readTargetBase();

  if (base === null) {
    return refused("target_base_unavailable");
  }

  if (
    base.ref !== approval.targetBaseRef ||
    base.oid !== approval.targetBaseOid
  ) {
    return refused("approval_changed");
  }

  const outcome = await ports.updateRefsAtomically({
    repositoryNodeId: approval.githubRepositoryNodeId,
    baseRef: approval.targetBaseRef,
    expectedBaseOid: approval.targetBaseOid,
    canonicalRef: approval.canonicalRef,
  });

  if (outcome === "sealed") {
    return { status: "sealed" };
  }

  if (outcome === "unsupported") {
    return refused("branch_seal_unsupported");
  }

  if (outcome === "rejected") {
    return refused("branch_seal_rejected");
  }

  // 結果不明。成功として再送せず、両方のrefを読み直して確定できたときだけ進む。
  const [createdRef, baseAfter] = await Promise.all([
    ports.readRef(approval.canonicalRef),
    ports.readTargetBase(),
  ]);

  return createdRef.status === "present" &&
    createdRef.oid === approval.targetBaseOid &&
    baseAfter !== null &&
    baseAfter.ref === approval.targetBaseRef &&
    baseAfter.oid === approval.targetBaseOid
    ? { status: "sealed" }
    : refused("branch_seal_result_unknown");
}
