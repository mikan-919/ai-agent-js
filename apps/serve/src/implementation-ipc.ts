import {
  parseCheckpointRequest,
  type CheckpointAcceptedEvent,
  type CheckpointCompletedEvent,
  type CheckpointRejectedEvent,
  type CheckpointRequest,
  type ImplementationStartEvent,
} from "@mikan-919/oriel-contracts";

import { readNdjson, writeNdjson } from "./ndjson";

export interface CheckpointOperations {
  accept(
    request: CheckpointRequest,
  ): Promise<CheckpointAcceptedEvent | CheckpointRejectedEvent>;
  deliver(
    operationId: string,
  ): Promise<CheckpointCompletedEvent | CheckpointRejectedEvent>;
}

/**
 * 実装workerのIPC。
 *
 * 封印済みcanonicalブランチのworktreeと承認済みWHAT/HOWをharnessへ渡し、以後は
 * checkpoint要求だけを受け取る。credentialは渡さず、汎用のAPI中継もcommand実行も
 * 公開しない。所有権を失えば新しい要求を受け取る経路自体を閉じる。
 */
export async function serveOwnedHarnessImplementationIpc(
  input: ReadableStream<Uint8Array>,
  output: WritableStream<Uint8Array>,
  start: ImplementationStartEvent,
  operations: CheckpointOperations,
  stopSignal?: AbortSignal,
): Promise<void> {
  const writer = output.getWriter();

  try {
    await writeNdjson(writer, start);

    for await (const message of readNdjson(input, stopSignal)) {
      const request = parseRequest(message);

      if (request === null) {
        await writeNdjson(writer, invalid(message));
        continue;
      }

      const acceptedOrRejected = await operations.accept(request);
      await writeNdjson(writer, acceptedOrRejected);

      if (acceptedOrRejected.type === "checkpoint.rejected") {
        continue;
      }

      await writeNdjson(
        writer,
        await operations.deliver(acceptedOrRejected.operationId),
      );
    }
  } finally {
    writer.releaseLock();
  }
}

function parseRequest(message: unknown): CheckpointRequest | null {
  try {
    return parseCheckpointRequest(message);
  } catch {
    return null;
  }
}

function invalid(message: unknown): CheckpointRejectedEvent {
  const requestId =
    typeof message === "object" &&
    message !== null &&
    "requestId" in message &&
    typeof message.requestId === "string" &&
    message.requestId !== ""
      ? message.requestId
      : "invalid-request";

  return { type: "checkpoint.rejected", requestId, reason: "invalid_request" };
}
