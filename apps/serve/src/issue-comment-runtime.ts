import type { GitHubRepository } from "@mikan-919/oriel-contracts";
import type { Octokit } from "@octokit/rest";

import {
  createIssueCommentOutbox,
  createIssueCommentService,
  createOctokitIssueCommentPublisher,
  type JobOwnershipVerifier,
} from "./issue-comments";
import {
  type IssueConversationBinding,
  serveOwnedHarnessIssueCommentIpc,
} from "./issue-comment-ipc";
import { openServeLocalState } from "./local-state";

export interface StartIssueCommentRuntimeOptions {
  databasePath: string;
  octokit: Octokit;
  ownershipVerifier: JobOwnershipVerifier;
}

export function startIssueCommentRuntime({
  databasePath,
  octokit,
  ownershipVerifier,
}: StartIssueCommentRuntimeOptions) {
  const database = openServeLocalState(databasePath);
  const service = createIssueCommentService({
    outbox: createIssueCommentOutbox(database),
    ownershipVerifier,
    publisher: createOctokitIssueCommentPublisher(octokit),
  });

  return {
    serveHarnessIssueConversation(
      input: ReadableStream<Uint8Array>,
      output: WritableStream<Uint8Array>,
      binding: IssueConversationBinding,
    ) {
      void service.resumePending(binding);
      return serveOwnedHarnessIssueCommentIpc(
        input,
        output,
        binding,
        service,
        ownershipVerifier.stopSignal,
      );
    },
    close() {
      database.close();
    },
  };
}

export function issueConversationBinding(input: {
  jobId: string;
  jobLeaseId: string;
  repository: GitHubRepository;
  issueNumber: number;
}): IssueConversationBinding {
  return input;
}
