import {
  parseImplementationClientMessage,
  type CheckpointAcceptedEvent,
  type CheckpointCompletedEvent,
  type CheckpointRejectedEvent,
  type CheckpointRequest,
  type ImplementationStartEvent,
  type ModelStreamRequest,
  type ModelStreamServerMessage,
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

export interface ModelStreamOperations {
  stream(request: ModelStreamRequest): AsyncIterable<ModelStreamServerMessage>;
  abort(requestId: string): void;
}

export interface ImplementationOperations {
  checkpoint: CheckpointOperations;
  model: ModelStreamOperations;
}

/**
 * 実装workerのIPC。
 *
 * 封印済みcanonicalブランチのworktreeと承認済みWHAT/HOWをharnessへ渡し、以後は
 * modelへの要求とcheckpoint要求だけを受け取る。credentialは渡さず、汎用のAPI
 * 中継もcommand実行も公開しない。所有権を失えば新しい要求を受け取る経路自体を
 * 閉じる。
 */
export async function serveOwnedHarnessImplementationIpc(
  input: ReadableStream<Uint8Array>,
  output: WritableStream<Uint8Array>,
  start: ImplementationStartEvent,
  operations: ImplementationOperations,
  stopSignal?: AbortSignal,
): Promise<void> {
  const writer = output.getWriter();
  // NDJSONの行が混ざらないよう、書き込みだけは常に直列化する。
  let writes = Promise.resolve();
  const send = (message: unknown): Promise<void> => {
    writes = writes.then(() => writeNdjson(writer, message));
    return writes;
  };
  const streaming = new Set<Promise<void>>();

  try {
    await send(start);

    for await (const message of readNdjson(input, stopSignal)) {
      const request = parseRequest(message);

      if (request === null) {
        await send(invalid(message));
        continue;
      }

      if (request.type === "model.stream.abort") {
        operations.model.abort(request.requestId);
        continue;
      }

      if (request.type === "model.stream.request") {
        // 中止messageを受け取れるよう、streamの完了で読み取りを止めない。
        const pump = (async () => {
          for await (const event of operations.model.stream(request)) {
            await send(event);
          }
        })().finally(() => streaming.delete(pump));

        streaming.add(pump);
        continue;
      }

      const acceptedOrRejected = await operations.checkpoint.accept(request);
      await send(acceptedOrRejected);

      if (acceptedOrRejected.type === "checkpoint.rejected") {
        continue;
      }

      await send(
        await operations.checkpoint.deliver(acceptedOrRejected.operationId),
      );
    }

    await Promise.all(streaming);
  } finally {
    await writes.catch(() => {});
    writer.releaseLock();
  }
}

function parseRequest(
  message: unknown,
): ReturnType<typeof parseImplementationClientMessage> | null {
  try {
    return parseImplementationClientMessage(message);
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
