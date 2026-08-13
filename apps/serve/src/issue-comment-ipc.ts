import {
  type GitHubRepository,
  type IssueCommentEvent,
  type IssueCommentRejectedEvent,
  parseIssueCommentRequest,
} from "@mikan-919/oriel-contracts";

import { type createIssueCommentService } from "./issue-comments";

type IssueCommentService = ReturnType<typeof createIssueCommentService>;

export interface IssueConversationBinding {
  jobId: string;
  jobLeaseId: string;
  repository: GitHubRepository;
  issueNumber: number;
}

export async function serveOwnedHarnessIssueCommentIpc(
  input: ReadableStream<Uint8Array>,
  output: WritableStream<Uint8Array>,
  binding: IssueConversationBinding,
  service: IssueCommentService,
  stopSignal?: AbortSignal,
) {
  const writer = output.getWriter();

  try {
    for await (const message of readNdjson(input, stopSignal)) {
      const request = parseRequest(message);

      if (request === null) {
        await writeEvent(writer, rejectedFromMalformedMessage(message));
        continue;
      }

      if (!matchesBinding(request, binding)) {
        await writeEvent(
          writer,
          rejected(request.requestId, "target_mismatch"),
        );
        continue;
      }

      const acceptedOrRejected = await service.accept(request);
      await writeEvent(writer, acceptedOrRejected);

      if (acceptedOrRejected.type === "issue_comment.rejected") {
        continue;
      }

      await writeEvent(
        writer,
        await service.waitForOutcome(acceptedOrRejected.operationId),
      );
    }
  } finally {
    writer.releaseLock();
  }
}

async function* readNdjson(
  input: ReadableStream<Uint8Array>,
  stopSignal?: AbortSignal,
) {
  const reader = input.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  // 所有権を失ったら、harnessからの新しい要求を受け取る経路自体を閉じる。
  const stop = () => void reader.cancel().catch(() => {});
  const stopped = () => stopSignal?.aborted ?? false;
  stopSignal?.addEventListener("abort", stop, { once: true });

  try {
    if (stopped()) {
      return;
    }

    while (true) {
      const { done, value } = await reader.read();

      if (done) {
        break;
      }

      if (stopped()) {
        return;
      }

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";

      for (const line of lines) {
        if (line !== "") {
          yield parseLine(line);
        }
      }
    }

    const finalLine = buffer + decoder.decode();

    if (finalLine !== "") {
      yield parseLine(finalLine);
    }
  } finally {
    stopSignal?.removeEventListener("abort", stop);
    reader.releaseLock();
  }
}

function parseLine(line: string): unknown {
  try {
    return JSON.parse(line) as unknown;
  } catch {
    return {};
  }
}

function parseRequest(message: unknown) {
  try {
    return parseIssueCommentRequest(message);
  } catch {
    return null;
  }
}

function matchesBinding(
  request: IssueConversationBinding,
  binding: IssueConversationBinding,
) {
  return (
    request.jobId === binding.jobId &&
    request.jobLeaseId === binding.jobLeaseId &&
    request.repository.owner === binding.repository.owner &&
    request.repository.name === binding.repository.name &&
    request.issueNumber === binding.issueNumber
  );
}

function rejectedFromMalformedMessage(
  message: unknown,
): IssueCommentRejectedEvent {
  const requestId =
    typeof message === "object" &&
    message !== null &&
    "requestId" in message &&
    typeof message.requestId === "string"
      ? message.requestId
      : "invalid-request";

  return rejected(requestId, "invalid_request");
}

function rejected(
  requestId: string,
  reason: IssueCommentRejectedEvent["reason"],
): IssueCommentRejectedEvent {
  return { type: "issue_comment.rejected", requestId, reason };
}

async function writeEvent(
  writer: WritableStreamDefaultWriter<Uint8Array>,
  event: IssueCommentEvent,
) {
  await writer.write(new TextEncoder().encode(`${JSON.stringify(event)}\n`));
}
