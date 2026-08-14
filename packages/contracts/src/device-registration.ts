import * as v from "valibot";

import { githubRepositorySchema } from "./github";

const nonEmptyString = v.pipe(v.string(), v.minLength(1));
const positiveInteger = v.pipe(v.number(), v.integer(), v.minValue(1));

export const deviceRegistrationPurposeSchema = v.picklist([
  "registration",
  "management",
]);

export type DeviceRegistrationPurpose = v.InferOutput<
  typeof deviceRegistrationPurposeSchema
>;

/** relayからlocalhostへ戻るURLへ載せてよいのは短命codeとstateだけとする。 */
export const deviceRegistrationCallbackSchema = v.strictObject({
  code: nonEmptyString,
  state: nonEmptyString,
});

export type DeviceRegistrationCallback = v.InferOutput<
  typeof deviceRegistrationCallbackSchema
>;

export const deviceTokenExchangeRequestSchema = v.strictObject({
  code: nonEmptyString,
  codeVerifier: nonEmptyString,
});

export type DeviceTokenExchangeRequest = v.InferOutput<
  typeof deviceTokenExchangeRequestSchema
>;

const registeredRepositorySchema = v.strictObject({
  installationId: positiveInteger,
  repositoryId: positiveInteger,
  repository: githubRepositorySchema,
});

/**
 * 登録の交換結果。`cancellationToken`はこのdeviceだけを取り消せる内部限定の証明で、
 * 通常の失効経路ではない。
 */
export const deviceRegistrationExchangeResponseSchema = v.strictObject({
  purpose: v.literal("registration"),
  deviceId: nonEmptyString,
  deviceToken: nonEmptyString,
  cancellationToken: nonEmptyString,
  cancellationExpiresAt: positiveInteger,
  ...registeredRepositorySchema.entries,
});

export type DeviceRegistrationExchangeResponse = v.InferOutput<
  typeof deviceRegistrationExchangeResponseSchema
>;

/** 管理の交換結果。installationを現在管理できるGitHub userだけが受け取れる。 */
export const deviceManagementExchangeResponseSchema = v.strictObject({
  purpose: v.literal("management"),
  managementToken: nonEmptyString,
  expiresAt: positiveInteger,
  ...registeredRepositorySchema.entries,
});

export type DeviceManagementExchangeResponse = v.InferOutput<
  typeof deviceManagementExchangeResponseSchema
>;

export const deviceTokenExchangeResponseSchema = v.variant("purpose", [
  deviceRegistrationExchangeResponseSchema,
  deviceManagementExchangeResponseSchema,
]);

export type DeviceTokenExchangeResponse = v.InferOutput<
  typeof deviceTokenExchangeResponseSchema
>;

/** relayが永続化してよい表示metadata。tokenのhashは外へ出さない。 */
export const deviceRecordSchema = v.strictObject({
  deviceId: nonEmptyString,
  ...registeredRepositorySchema.entries,
  registeredAt: positiveInteger,
  revokedAt: v.nullable(positiveInteger),
});

export type DeviceRecord = v.InferOutput<typeof deviceRecordSchema>;

export const deviceListResponseSchema = v.strictObject({
  devices: v.array(deviceRecordSchema),
});

export type DeviceListResponse = v.InferOutput<typeof deviceListResponseSchema>;

export const deviceCancellationRequestSchema = v.strictObject({
  deviceId: nonEmptyString,
  cancellationToken: nonEmptyString,
});

export type DeviceCancellationRequest = v.InferOutput<
  typeof deviceCancellationRequestSchema
>;

export const deviceRevocationResponseSchema = v.strictObject({
  deviceId: nonEmptyString,
  revokedAt: positiveInteger,
});

export type DeviceRevocationResponse = v.InferOutput<
  typeof deviceRevocationResponseSchema
>;

export function parseDeviceRegistrationCallback(
  value: unknown,
): DeviceRegistrationCallback {
  return v.parse(deviceRegistrationCallbackSchema, value);
}

export function parseDeviceTokenExchangeRequest(
  value: unknown,
): DeviceTokenExchangeRequest {
  return v.parse(deviceTokenExchangeRequestSchema, value);
}

export function parseDeviceTokenExchangeResponse(
  value: unknown,
): DeviceTokenExchangeResponse {
  return v.parse(deviceTokenExchangeResponseSchema, value);
}

export function parseDeviceListResponse(value: unknown): DeviceListResponse {
  return v.parse(deviceListResponseSchema, value);
}

export function parseDeviceCancellationRequest(
  value: unknown,
): DeviceCancellationRequest {
  return v.parse(deviceCancellationRequestSchema, value);
}

export function parseDeviceRevocationResponse(
  value: unknown,
): DeviceRevocationResponse {
  return v.parse(deviceRevocationResponseSchema, value);
}
