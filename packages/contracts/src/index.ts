import * as v from "valibot";

const nonEmptyString = v.pipe(v.string(), v.minLength(1));

export const issueCommentRequestSchema = v.strictObject({
  type: v.literal("issue_comment.request"),
  requestId: nonEmptyString,
  jobId: nonEmptyString,
  jobLeaseId: nonEmptyString,
  repository: nonEmptyString,
  issueNumber: v.pipe(v.number(), v.integer(), v.minValue(1)),
  body: nonEmptyString,
});

export type IssueCommentRequest = v.InferOutput<
  typeof issueCommentRequestSchema
>;

export const issueCommentAcceptedEventSchema = v.strictObject({
  type: v.literal("issue_comment.accepted"),
  requestId: nonEmptyString,
  operationId: nonEmptyString,
});

export type IssueCommentAcceptedEvent = v.InferOutput<
  typeof issueCommentAcceptedEventSchema
>;

export const issueCommentCompletedEventSchema = v.strictObject({
  type: v.literal("issue_comment.completed"),
  requestId: nonEmptyString,
  operationId: nonEmptyString,
  githubCommentId: v.pipe(v.number(), v.integer(), v.minValue(1)),
});

export type IssueCommentCompletedEvent = v.InferOutput<
  typeof issueCommentCompletedEventSchema
>;

export function parseIssueCommentRequest(value: unknown): IssueCommentRequest {
  return v.parse(issueCommentRequestSchema, value);
}

export function parseIssueCommentAcceptedEvent(
  value: unknown,
): IssueCommentAcceptedEvent {
  return v.parse(issueCommentAcceptedEventSchema, value);
}

export function parseIssueCommentCompletedEvent(
  value: unknown,
): IssueCommentCompletedEvent {
  return v.parse(issueCommentCompletedEventSchema, value);
}
