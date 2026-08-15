import * as v from "valibot";

const nonEmptyString = v.pipe(v.string(), v.minLength(1));
const objectId = v.pipe(v.string(), v.regex(/^[0-9a-f]{40}$/));
const approvalFingerprint = v.pipe(v.string(), v.regex(/^[0-9a-f]{64}$/));

/**
 * 実装workerのIPC。
 *
 * `serve`はcredentialを渡さず、封印済みcanonicalブランチのworktreeと、承認済みの
 * WHAT/HOWだけをharnessへ渡す。harnessはworktree内の編集、build、test、commitを
 * 自分で行い、外部への送信は`serve`の用途限定操作としてだけ要求する。
 */
export const implementationStartEventSchema = v.strictObject({
  type: v.literal("implementation.start"),
  jobId: nonEmptyString,
  jobLeaseId: nonEmptyString,
  branchLeaseId: nonEmptyString,
  approvalFingerprint,
  /** 封印済みcanonicalブランチと、その現在の先端。 */
  canonicalBranch: nonEmptyString,
  canonicalOid: objectId,
  worktreePath: nonEmptyString,
  /** 既存ブランチの引き継ぎでは、先端を未検証の作業途中成果として扱う。 */
  adopted: v.boolean(),
  what: v.strictObject({ title: nonEmptyString, body: v.string() }),
  how: v.strictObject({ title: nonEmptyString, description: v.string() }),
  /**
   * worktree内で順に実行する検証command。shell文字列ではなく引数配列で渡す。
   * 引き継いだ先端は未検証の作業途中成果のため、workerはこれを最初からやり直す。
   */
  verification: v.array(v.pipe(v.array(nonEmptyString), v.minLength(1))),
});

export type ImplementationStartEvent = v.InferOutput<
  typeof implementationStartEventSchema
>;

/** checkpointの送信要求。送信前OIDを比較条件として`serve`へ渡す。 */
export const checkpointRequestSchema = v.strictObject({
  type: v.literal("checkpoint.request"),
  requestId: nonEmptyString,
  jobId: nonEmptyString,
  jobLeaseId: nonEmptyString,
  branchLeaseId: nonEmptyString,
  approvalFingerprint,
  canonicalBranch: nonEmptyString,
  expectedOid: objectId,
  headOid: objectId,
  /** 未検証のWIP checkpointかどうか。 */
  verified: v.boolean(),
});

export type CheckpointRequest = v.InferOutput<typeof checkpointRequestSchema>;

export const checkpointAcceptedEventSchema = v.strictObject({
  type: v.literal("checkpoint.accepted"),
  requestId: nonEmptyString,
  operationId: nonEmptyString,
});

export type CheckpointAcceptedEvent = v.InferOutput<
  typeof checkpointAcceptedEventSchema
>;

export const checkpointCompletedEventSchema = v.strictObject({
  type: v.literal("checkpoint.completed"),
  requestId: nonEmptyString,
  operationId: nonEmptyString,
  canonicalOid: objectId,
});

export type CheckpointCompletedEvent = v.InferOutput<
  typeof checkpointCompletedEventSchema
>;

export const checkpointRejectedEventSchema = v.strictObject({
  type: v.literal("checkpoint.rejected"),
  requestId: nonEmptyString,
  reason: v.picklist([
    "invalid_request",
    "ownership_not_current",
    "target_mismatch",
    "remote_diverged",
    "push_failed",
  ]),
});

export type CheckpointRejectedEvent = v.InferOutput<
  typeof checkpointRejectedEventSchema
>;

export const checkpointEventSchema = v.variant("type", [
  checkpointAcceptedEventSchema,
  checkpointCompletedEventSchema,
  checkpointRejectedEventSchema,
]);

export type CheckpointEvent = v.InferOutput<typeof checkpointEventSchema>;

/** `serve`からharnessへ流すmessage。 */
export const implementationServerMessageSchema = v.variant("type", [
  implementationStartEventSchema,
  checkpointAcceptedEventSchema,
  checkpointCompletedEventSchema,
  checkpointRejectedEventSchema,
]);

export type ImplementationServerMessage = v.InferOutput<
  typeof implementationServerMessageSchema
>;

/** harnessから`serve`へ流すmessage。用途限定の外部操作要求だけとする。 */
export const implementationClientMessageSchema = v.variant("type", [
  checkpointRequestSchema,
]);

export type ImplementationClientMessage = v.InferOutput<
  typeof implementationClientMessageSchema
>;

export function parseImplementationStartEvent(
  value: unknown,
): ImplementationStartEvent {
  return v.parse(implementationStartEventSchema, value);
}

export function parseCheckpointRequest(value: unknown): CheckpointRequest {
  return v.parse(checkpointRequestSchema, value);
}

export function parseCheckpointEvent(value: unknown): CheckpointEvent {
  return v.parse(checkpointEventSchema, value);
}

export function parseImplementationServerMessage(
  value: unknown,
): ImplementationServerMessage {
  return v.parse(implementationServerMessageSchema, value);
}

export function parseImplementationClientMessage(
  value: unknown,
): ImplementationClientMessage {
  return v.parse(implementationClientMessageSchema, value);
}
