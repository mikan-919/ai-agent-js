import { expect, test } from "bun:test";
import type { Octokit } from "@octokit/rest";

import type { DeviceTokenStore } from "./device-registration";
import { createInstallationOctokitResolver } from "./installation-octokit";

const repositoryId = 11;
const deviceToken = "7.11.device-token";

function tokenStore(token: string | null): DeviceTokenStore {
  return { set: async () => {}, get: async () => token };
}

function resolver(options: {
  token: string | null;
  storedToken?: string | null;
  repositoryIdOverride?: number;
  throws?: boolean;
}) {
  const authorizations: string[] = [];
  const requested: string[] = [];
  const resolve = createInstallationOctokitResolver({
    relay: {
      requestInstallationToken: async (token: string) => {
        requested.push(token);

        if (options.throws === true) {
          throw new Error("the relay is unreachable");
        }

        return options.token === null
          ? null
          : {
              token: options.token,
              expiresAt: "2026-08-14T00:10:00Z",
              installationId: 7,
              repositoryId: options.repositoryIdOverride ?? repositoryId,
            };
      },
    },
    tokenStore: tokenStore(
      options.storedToken === undefined ? deviceToken : options.storedToken,
    ),
    repositoryId,
    newOctokit: (auth) => {
      authorizations.push(auth);
      return {} as Octokit;
    },
  });

  return { resolve, authorizations, requested };
}

test("the device token buys a short lived installation token for the Octokit", async () => {
  const context = resolver({ token: "installation-token" });

  expect(await context.resolve()).not.toBeNull();
  expect(context.requested).toEqual([deviceToken]);
  expect(context.authorizations).toEqual(["installation-token"]);

  // 呼び出しごとに取り直し、保存しない。
  await context.resolve();

  expect(context.authorizations).toEqual([
    "installation-token",
    "installation-token",
  ]);
});

test("external writes fail closed without a device token or a relay answer", async () => {
  expect(
    await resolver({
      token: "installation-token",
      storedToken: null,
    }).resolve(),
  ).toBeNull();
  expect(await resolver({ token: null }).resolve()).toBeNull();
  expect(
    await resolver({ token: "installation-token", throws: true }).resolve(),
  ).toBeNull();
  expect(
    await resolver({
      token: "installation-token",
      repositoryIdOverride: repositoryId + 1,
    }).resolve(),
  ).toBeNull();
});
