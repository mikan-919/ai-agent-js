import { expect, test } from "bun:test";

import {
  parseDeviceRegistrationCallback,
  parseDeviceTokenExchangeResponse,
} from "./index";

const registeredRepository = {
  installationId: 7,
  repositoryId: 11,
  repository: { owner: "mikan-919", name: "oriel" },
};

test("callback carries only the one-time code and state", () => {
  expect(
    parseDeviceRegistrationCallback({ code: "one-time", state: "state" }),
  ).toEqual({ code: "one-time", state: "state" });

  expect(() =>
    parseDeviceRegistrationCallback({
      code: "one-time",
      state: "state",
      deviceToken: "leaked",
    }),
  ).toThrow();

  expect(() =>
    parseDeviceRegistrationCallback({ code: "", state: "" }),
  ).toThrow();
});

test("a registration exchange binds the token to one installation repository", () => {
  const response = {
    purpose: "registration" as const,
    deviceId: "device-1",
    deviceToken: "token",
    cancellationToken: "cancellation",
    cancellationExpiresAt: 1_000,
    ...registeredRepository,
  };

  expect(parseDeviceTokenExchangeResponse(response)).toEqual(response);
  expect(() =>
    parseDeviceTokenExchangeResponse({ ...response, repositoryId: 0 }),
  ).toThrow();
  expect(() =>
    parseDeviceTokenExchangeResponse({ ...response, cancellationToken: "" }),
  ).toThrow();
});

test("a management exchange carries a session instead of a device token", () => {
  const response = {
    purpose: "management" as const,
    managementToken: "session",
    expiresAt: 1_000,
    ...registeredRepository,
  };

  expect(parseDeviceTokenExchangeResponse(response)).toEqual(response);
  expect(() =>
    parseDeviceTokenExchangeResponse({ ...response, deviceToken: "leaked" }),
  ).toThrow();
});
