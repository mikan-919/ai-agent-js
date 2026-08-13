import { expect, test } from "bun:test";

import {
  parseDeviceRegistrationCallback,
  parseDeviceTokenExchangeResponse,
} from "./index";

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

test("exchange response binds the token to one installation repository", () => {
  const response = {
    deviceId: "device-1",
    deviceToken: "token",
    installationId: 7,
    repositoryId: 11,
    repository: { owner: "mikan-919", name: "oriel" },
  };

  expect(parseDeviceTokenExchangeResponse(response)).toEqual(response);
  expect(() =>
    parseDeviceTokenExchangeResponse({ ...response, repositoryId: 0 }),
  ).toThrow();
});
