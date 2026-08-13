import { createHash, randomBytes } from "node:crypto";

import { parseDeviceRegistrationCallback } from "@mikan-919/oriel-contracts";
import { identity } from "@mikan-919/oriel-identity";

import type { DeviceRegistry } from "./device-registry";

/** device tokenの保存先。Secret Serviceを使えない場合はfail closedにする。 */
export interface DeviceTokenStore {
  set(input: { repositoryId: number; deviceToken: string }): Promise<void>;
}

export function bunSecretsDeviceTokenStore(): DeviceTokenStore {
  return {
    async set({ repositoryId, deviceToken }) {
      await Bun.secrets.set({
        service: identity.codeName,
        name: `device-token:${repositoryId}`,
        value: deviceToken,
      });
    },
  };
}

export type DeviceRegistrationResult =
  | { status: "registered"; deviceId: string }
  | {
      status: "rejected";
      reason:
        | "invalid_callback"
        | "unknown_state"
        | "exchange_rejected"
        | "registration_target_mismatch"
        | "credential_store_unavailable";
    };

export interface DeviceRegistrationFlowOptions {
  relay: Pick<DeviceRegistry, "exchange" | "revoke">;
  tokenStore: DeviceTokenStore;
  authorizeEndpoint: URL;
  redirectUri: URL;
  newSecret?: () => string;
}

interface PendingRegistration {
  codeVerifier: string;
  installationId: number;
  repositoryId: number;
}

/**
 * localhost UIから始めるdevice登録。verifier、challenge、stateは`serve`が作り、
 * codeの交換にverifierを要求することで、登録を開始したこの`serve`へ結び付ける。
 */
export function createDeviceRegistrationFlow({
  relay,
  tokenStore,
  authorizeEndpoint,
  redirectUri,
  newSecret = () => randomBytes(32).toString("base64url"),
}: DeviceRegistrationFlowOptions) {
  const pending = new Map<string, PendingRegistration>();

  return {
    begin({
      installationId,
      repositoryId,
    }: {
      installationId: number;
      repositoryId: number;
    }): { authorizeUrl: URL } {
      const codeVerifier = newSecret();
      const state = newSecret();

      pending.set(state, { codeVerifier, installationId, repositoryId });

      const authorizeUrl = new URL(authorizeEndpoint);
      authorizeUrl.searchParams.set("installation_id", String(installationId));
      authorizeUrl.searchParams.set("repository_id", String(repositoryId));
      authorizeUrl.searchParams.set(
        "code_challenge",
        createHash("sha256").update(codeVerifier).digest("base64url"),
      );
      authorizeUrl.searchParams.set("code_challenge_method", "S256");
      authorizeUrl.searchParams.set("state", state);
      authorizeUrl.searchParams.set("redirect_uri", redirectUri.toString());

      return { authorizeUrl };
    },
    async complete(
      callbackUrl: URL | string,
    ): Promise<DeviceRegistrationResult> {
      let callback;

      try {
        callback = parseDeviceRegistrationCallback(
          Object.fromEntries(new URL(callbackUrl).searchParams),
        );
      } catch {
        return { status: "rejected", reason: "invalid_callback" };
      }

      const started = pending.get(callback.state);

      // stateは一回限り。交換の成否によらず取り下げる。
      pending.delete(callback.state);

      if (started === undefined) {
        return { status: "rejected", reason: "unknown_state" };
      }

      const exchanged = await relay.exchange({
        code: callback.code,
        codeVerifier: started.codeVerifier,
      });

      if (exchanged.status === "rejected") {
        return { status: "rejected", reason: "exchange_rejected" };
      }

      const { deviceId, deviceToken, installationId, repositoryId } = exchanged;

      // 発行後に受理できない事情が出たら、tokenを持ったまま止めずdeviceを失効させる。
      const failClosed = async (
        reason: Extract<
          DeviceRegistrationResult,
          { status: "rejected" }
        >["reason"],
      ): Promise<DeviceRegistrationResult> => {
        await relay.revoke({
          actor: { type: "device", deviceToken },
          deviceId,
        });

        return { status: "rejected", reason };
      };

      if (
        installationId !== started.installationId ||
        repositoryId !== started.repositoryId
      ) {
        return failClosed("registration_target_mismatch");
      }

      try {
        await tokenStore.set({ repositoryId, deviceToken });
      } catch {
        return failClosed("credential_store_unavailable");
      }

      return { status: "registered", deviceId };
    },
  };
}
