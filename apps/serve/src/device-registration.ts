import { createHash, randomBytes } from "node:crypto";

import {
  parseDeviceRegistrationCallback,
  type DeviceRecord,
  type DeviceRegistrationPurpose,
} from "@mikan-919/oriel-contracts";
import { identity } from "@mikan-919/oriel-identity";

import type { RelayDeviceClient } from "./relay-client";

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
  | { status: "management_session"; expiresAt: number }
  | {
      status: "rejected";
      reason:
        | "invalid_callback"
        | "unknown_state"
        | "exchange_rejected"
        | "unexpected_purpose"
        | "registration_target_mismatch"
        | "credential_store_unavailable";
    }
  /** 発行済deviceを取り消せたか確認できない状態。人手か再試行で収束させる。 */
  | { status: "reconciliation_required"; deviceId: string };

export interface PendingDeviceCancellation {
  deviceId: string;
  cancellationToken: string;
  cancellationExpiresAt: number;
}

export interface DeviceRegistrationFlowOptions {
  relay: RelayDeviceClient;
  tokenStore: DeviceTokenStore;
  authorizeEndpoint: URL;
  redirectUri: URL;
  now?: () => number;
  newSecret?: () => string;
}

interface PendingAuthorization {
  codeVerifier: string;
  purpose: DeviceRegistrationPurpose;
  installationId: number;
  repositoryId: number;
}

interface ManagementSession {
  managementToken: string;
  expiresAt: number;
}

/**
 * localhost UIから始めるdevice登録と管理。verifier、challenge、stateは`serve`が作り、
 * codeの交換にverifierを要求することで、開始したこの`serve`へ結び付ける。
 */
export function createDeviceRegistrationFlow({
  relay,
  tokenStore,
  authorizeEndpoint,
  redirectUri,
  now = Date.now,
  newSecret = () => randomBytes(32).toString("base64url"),
}: DeviceRegistrationFlowOptions) {
  const pending = new Map<string, PendingAuthorization>();
  const pendingCancellations = new Map<string, PendingDeviceCancellation>();
  let management: ManagementSession | null = null;

  async function cancelIssuedDevice(issued: {
    deviceId: string;
    cancellationToken: string;
    cancellationExpiresAt: number;
  }): Promise<boolean> {
    const cancellation: PendingDeviceCancellation = {
      deviceId: issued.deviceId,
      cancellationToken: issued.cancellationToken,
      cancellationExpiresAt: issued.cancellationExpiresAt,
    };

    try {
      if (await relay.cancelIssuedDevice(cancellation)) {
        pendingCancellations.delete(cancellation.deviceId);
        return true;
      }
    } catch {
      // 結果不明。取消証明を保持して再調停できるようにする。
    }

    pendingCancellations.set(cancellation.deviceId, cancellation);
    return false;
  }

  function currentManagementSession(): string | null {
    if (management === null || management.expiresAt <= now()) {
      management = null;
      return null;
    }

    return management.managementToken;
  }

  return {
    begin({
      installationId,
      repositoryId,
      purpose = "registration",
    }: {
      installationId: number;
      repositoryId: number;
      purpose?: DeviceRegistrationPurpose;
    }): { authorizeUrl: URL } {
      const codeVerifier = newSecret();
      const state = newSecret();

      pending.set(state, {
        codeVerifier,
        purpose,
        installationId,
        repositoryId,
      });

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
      authorizeUrl.searchParams.set("purpose", purpose);

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

      if (exchanged === null) {
        return { status: "rejected", reason: "exchange_rejected" };
      }

      if (exchanged.purpose !== started.purpose) {
        return { status: "rejected", reason: "unexpected_purpose" };
      }

      if (
        exchanged.installationId !== started.installationId ||
        exchanged.repositoryId !== started.repositoryId
      ) {
        if (exchanged.purpose === "registration") {
          return (await cancelIssuedDevice(exchanged))
            ? { status: "rejected", reason: "registration_target_mismatch" }
            : {
                status: "reconciliation_required",
                deviceId: exchanged.deviceId,
              };
        }

        return { status: "rejected", reason: "registration_target_mismatch" };
      }

      if (exchanged.purpose === "management") {
        management = {
          managementToken: exchanged.managementToken,
          expiresAt: exchanged.expiresAt,
        };

        return { status: "management_session", expiresAt: exchanged.expiresAt };
      }

      try {
        await tokenStore.set({
          repositoryId: exchanged.repositoryId,
          deviceToken: exchanged.deviceToken,
        });
      } catch {
        // tokenを保管できないまま有効なdeviceを残さない。
        return (await cancelIssuedDevice(exchanged))
          ? { status: "rejected", reason: "credential_store_unavailable" }
          : { status: "reconciliation_required", deviceId: exchanged.deviceId };
      }

      return { status: "registered", deviceId: exchanged.deviceId };
    },
    /** 取消を確認できなかった発行済device。空でない限り登録は完了していない。 */
    pendingCancellations(): PendingDeviceCancellation[] {
      return [...pendingCancellations.values()];
    },
    /** 期限切れの取消証明は自動収束できないため、報告したまま残す。 */
    async retryPendingCancellations(): Promise<PendingDeviceCancellation[]> {
      for (const cancellation of [...pendingCancellations.values()]) {
        if (cancellation.cancellationExpiresAt <= now()) {
          continue;
        }

        await cancelIssuedDevice(cancellation);
      }

      return [...pendingCancellations.values()];
    },
    hasManagementSession(): boolean {
      return currentManagementSession() !== null;
    },
    async listDevices(): Promise<DeviceRecord[] | null> {
      const managementToken = currentManagementSession();

      return managementToken === null
        ? null
        : relay.listDevices(managementToken);
    },
    /**
     * 失効はinstallationを現在管理できるGitHub userのsessionでだけ実行できる。
     * device bearer tokenでは失効できない。
     */
    async revokeDevice(deviceId: string): Promise<boolean> {
      const managementToken = currentManagementSession();

      if (managementToken === null) {
        return false;
      }

      const revoked = await relay.revokeDevice({ managementToken, deviceId });

      return revoked !== null;
    },
  };
}

export type DeviceRegistrationFlow = ReturnType<
  typeof createDeviceRegistrationFlow
>;
