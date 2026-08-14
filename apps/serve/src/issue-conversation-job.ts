import type { GitHubRepository } from "@mikan-919/oriel-contracts";
import type { Octokit } from "@octokit/rest";

import type { DeviceTokenStore } from "./device-registration";
import { startIssueCommentRuntime } from "./issue-comment-runtime";
import { createRelayOwnershipConnection } from "./ownership-connection";

export interface StartIssueConversationJobOptions {
  relayOrigin: URL | string;
  tokenStore: DeviceTokenStore;
  databasePath: string;
  octokit: Octokit;
  repositoryId: number;
  repository: GitHubRepository;
  jobId: string;
  issueNumber: number;
  /** コードを変更するJobだけがcanonicalブランチの接続排他も取得する。 */
  canonicalBranch?: string;
  heartbeatStopMs: number;
}

export type StartIssueConversationJobResult =
  | {
      status: "started";
      runtime: ReturnType<typeof startIssueCommentRuntime>;
      binding: {
        jobId: string;
        jobLeaseId: string;
        repository: GitHubRepository;
        issueNumber: number;
      };
      close(): void;
    }
  | {
      status: "refused";
      reason:
        | "device_not_registered"
        | "job_ownership_not_acquired"
        | "branch_not_exclusive";
    };

/**
 * 明示的に起動したIssue対話の製品経路。device tokenを`Bun.secrets`から読み、
 * relayでJob所有権と必要なブランチ排他を取れた場合だけworkerを動かす。
 */
export async function startIssueConversationJob({
  relayOrigin,
  tokenStore,
  databasePath,
  octokit,
  repositoryId,
  repository,
  jobId,
  issueNumber,
  canonicalBranch,
  heartbeatStopMs,
}: StartIssueConversationJobOptions): Promise<StartIssueConversationJobResult> {
  const deviceToken = await tokenStore.get(repositoryId);

  if (deviceToken === null) {
    return { status: "refused", reason: "device_not_registered" };
  }

  const ownership = createRelayOwnershipConnection({
    relayOrigin,
    deviceToken,
    jobId,
    heartbeatStopMs,
  });
  const jobLeaseId = await ownership.acquireJobOwnership();

  if (jobLeaseId === null) {
    ownership.release();
    return { status: "refused", reason: "job_ownership_not_acquired" };
  }

  if (canonicalBranch !== undefined) {
    const branchLeaseId = await ownership.acquireBranchExclusivity(
      `${repositoryId}/${canonicalBranch}`,
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

  return {
    status: "started",
    runtime,
    binding: { jobId, jobLeaseId, repository, issueNumber },
    close() {
      ownership.release();
      runtime.close();
    },
  };
}
