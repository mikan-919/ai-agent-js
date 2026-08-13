import { createHash, randomBytes, randomUUID } from "node:crypto";

import type {
  DeviceTokenExchangeRequest,
  DeviceTokenExchangeResponse,
  GitHubRepository,
} from "@mikan-919/oriel-contracts";
import type { Octokit } from "@octokit/rest";

/**
 * GitHub user tokenの用途は本人確認、installation管理権限、repository選択の現在値確認だけとする。
 * 登録簿はこのtokenを保存しない。
 */
export interface GitHubInstallationDirectory {
  getViewer(userToken: string): Promise<{ id: number; login: string } | null>;
  canAdministerInstallation(input: {
    userToken: string;
    installationId: number;
  }): Promise<boolean>;
  listInstallationRepositories(input: {
    userToken: string;
    installationId: number;
  }): Promise<{ id: number; owner: string; name: string }[]>;
}

/**
 * `asUser`はGitHub user tokenで認証したOctokitを返す。tokenごとに別のuserを見るため、
 * 共有インスタンスではなく要求ごとに解決する。
 */
export function createOctokitGitHubInstallationDirectory(
  asUser: (userToken: string) => Octokit,
): GitHubInstallationDirectory {
  async function findInstallation(octokit: Octokit, installationId: number) {
    const installations = await octokit.paginate(
      octokit.rest.apps.listInstallationsForAuthenticatedUser,
      { per_page: 100 },
    );

    return installations.find(
      (installation) => installation.id === installationId,
    );
  }

  return {
    async getViewer(userToken) {
      try {
        const response = await asUser(userToken).rest.users.getAuthenticated();
        return { id: response.data.id, login: response.data.login };
      } catch (error) {
        // 失効したlogin tokenは認証失敗として扱い、登録要求を拒否する。
        if (
          typeof error === "object" &&
          error !== null &&
          "status" in error &&
          (error.status === 401 || error.status === 403)
        ) {
          return null;
        }

        throw error;
      }
    },
    async canAdministerInstallation({ userToken, installationId }) {
      const octokit = asUser(userToken);
      const installation = await findInstallation(octokit, installationId);

      if (installation === undefined) {
        return false;
      }

      const account = installation.account;

      if (account === null || !("type" in account)) {
        return false;
      }

      if (account.type !== "Organization") {
        const viewer = await octokit.rest.users.getAuthenticated();
        return account.id === viewer.data.id;
      }

      const membership =
        await octokit.rest.orgs.getMembershipForAuthenticatedUser({
          org: account.login,
        });

      return (
        membership.data.role === "admin" && membership.data.state === "active"
      );
    },
    async listInstallationRepositories({ userToken, installationId }) {
      const octokit = asUser(userToken);
      const repositories = await octokit.paginate(
        octokit.rest.apps.listInstallationReposForAuthenticatedUser,
        { installation_id: installationId, per_page: 100 },
      );

      return repositories.map((repository) => ({
        id: repository.id,
        owner: repository.owner.login,
        name: repository.name,
      }));
    },
  };
}

/** 失効時に、そのdeviceの現在の所有権接続を論理失効させてから閉じる相手。 */
export interface DeviceOwnershipRevoker {
  revokeDevice(deviceId: string): void;
}

/** relayが永続化してよい全項目。tokenそのものとGitHub user tokenは含めない。 */
export interface StoredDeviceRecord {
  deviceId: string;
  deviceTokenHash: string;
  installationId: number;
  repositoryId: number;
  repository: GitHubRepository;
  registeredAt: number;
  revokedAt: number | null;
}

export type DeviceAuthorizationResult =
  | { status: "issued"; code: string; state: string }
  | {
      status: "rejected";
      reason:
        | "github_login_required"
        | "repository_not_in_installation"
        | "unsupported_code_challenge_method";
    };

export type DeviceTokenExchangeResult =
  | ({ status: "issued" } & DeviceTokenExchangeResponse)
  | {
      status: "rejected";
      reason: "unknown_code" | "code_expired" | "code_verifier_mismatch";
    };

export type DeviceRevocationActor =
  | { type: "github_user"; userToken: string }
  | { type: "device"; deviceToken: string };

export type DeviceRevocationResult =
  | { status: "revoked" }
  | {
      status: "rejected";
      reason: "unknown_device" | "not_installation_admin" | "not_device_owner";
    };

export interface DeviceRegistry {
  authorize(input: {
    userToken: string;
    installationId: number;
    repositoryId: number;
    codeChallenge: string;
    codeChallengeMethod: string;
    state: string;
  }): Promise<DeviceAuthorizationResult>;
  exchange(
    request: DeviceTokenExchangeRequest,
  ): Promise<DeviceTokenExchangeResult>;
  authenticateDevice(
    deviceToken: string,
  ): { deviceId: string; installationId: number; repositoryId: number } | null;
  revoke(input: {
    actor: DeviceRevocationActor;
    deviceId: string;
  }): Promise<DeviceRevocationResult>;
  listDevices(input: {
    userToken: string;
    installationId: number;
  }): Promise<StoredDeviceRecord[]>;
}

export interface DeviceRegistryOptions {
  github: GitHubInstallationDirectory;
  ownership: DeviceOwnershipRevoker;
  /** 短命codeの有効期間。運用値は測定と検証専用環境から決めるため既定値を持たない。 */
  codeExpiryMs: number;
  now?: () => number;
  newDeviceId?: () => string;
  newSecret?: () => string;
}

interface PendingRegistrationCode {
  codeChallenge: string;
  state: string;
  installationId: number;
  repository: { id: number; owner: string; name: string };
  issuedAt: number;
}

function sha256Hex(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

/**
 * ADR 0004/0005のデバイス登録簿。tokenのhashと経路制御に要るmetadataだけを持ち、
 * GitHub user tokenも登録履歴も残さない。
 *
 * ponytail: job-ownership.tsの調停と同じく、リレーのDurable Objectがまだ無いため
 * in-processの登録簿として置く。relay appを作る時にそのままDO側へ移す。
 */
export function createDeviceRegistry({
  github,
  ownership,
  codeExpiryMs,
  now = Date.now,
  newDeviceId = randomUUID,
  newSecret = () => randomBytes(32).toString("base64url"),
}: DeviceRegistryOptions): DeviceRegistry {
  const pendingCodes = new Map<string, PendingRegistrationCode>();
  const devices = new Map<string, StoredDeviceRecord>();

  // ponytail: hash索引を作らず線形走査する。一つのinstallationのdevice数で足りる。
  // 走査費用が問題になったらhash→deviceIdのMapを足す。
  function deviceByToken(deviceToken: string): StoredDeviceRecord | null {
    const hash = sha256Hex(deviceToken);

    for (const device of devices.values()) {
      if (device.deviceTokenHash === hash) {
        return device;
      }
    }

    return null;
  }

  return {
    async authorize({
      userToken,
      installationId,
      repositoryId,
      codeChallenge,
      codeChallengeMethod,
      state,
    }) {
      if (codeChallengeMethod !== "S256") {
        return {
          status: "rejected",
          reason: "unsupported_code_challenge_method",
        };
      }

      const viewer = await github.getViewer(userToken);

      if (viewer === null) {
        return { status: "rejected", reason: "github_login_required" };
      }

      const repositories = await github.listInstallationRepositories({
        userToken,
        installationId,
      });
      const repository = repositories.find(
        (candidate) => candidate.id === repositoryId,
      );

      if (repository === undefined) {
        return { status: "rejected", reason: "repository_not_in_installation" };
      }

      const code = newSecret();
      pendingCodes.set(code, {
        codeChallenge,
        state,
        installationId,
        repository,
        issuedAt: now(),
      });

      return { status: "issued", code, state };
    },
    async exchange({ code, codeVerifier }) {
      const pending = pendingCodes.get(code);

      // 一回限りの交換。await前に取り下げて、同じcodeが二度成功しないようにする。
      pendingCodes.delete(code);

      if (pending === undefined) {
        return { status: "rejected", reason: "unknown_code" };
      }

      if (now() - pending.issuedAt > codeExpiryMs) {
        return { status: "rejected", reason: "code_expired" };
      }

      if (
        createHash("sha256").update(codeVerifier).digest("base64url") !==
        pending.codeChallenge
      ) {
        return { status: "rejected", reason: "code_verifier_mismatch" };
      }

      const deviceId = newDeviceId();
      const deviceToken = newSecret();

      devices.set(deviceId, {
        deviceId,
        deviceTokenHash: sha256Hex(deviceToken),
        installationId: pending.installationId,
        repositoryId: pending.repository.id,
        repository: {
          owner: pending.repository.owner,
          name: pending.repository.name,
        },
        registeredAt: now(),
        revokedAt: null,
      });

      return {
        status: "issued",
        deviceId,
        deviceToken,
        installationId: pending.installationId,
        repositoryId: pending.repository.id,
        repository: {
          owner: pending.repository.owner,
          name: pending.repository.name,
        },
      };
    },
    authenticateDevice(deviceToken) {
      const device = deviceByToken(deviceToken);

      if (device === null || device.revokedAt !== null) {
        return null;
      }

      return {
        deviceId: device.deviceId,
        installationId: device.installationId,
        repositoryId: device.repositoryId,
      };
    },
    async revoke({ actor, deviceId }) {
      const device = devices.get(deviceId);

      if (device === undefined) {
        return { status: "rejected", reason: "unknown_device" };
      }

      if (actor.type === "device") {
        if (deviceByToken(actor.deviceToken)?.deviceId !== deviceId) {
          return { status: "rejected", reason: "not_device_owner" };
        }
      } else if (
        !(await github.canAdministerInstallation({
          userToken: actor.userToken,
          installationId: device.installationId,
        }))
      ) {
        return { status: "rejected", reason: "not_installation_admin" };
      }

      // 先に登録簿を失効させて新規接続を拒否し、その後で現在の所有権接続を閉じる。
      device.revokedAt ??= now();
      ownership.revokeDevice(deviceId);

      return { status: "revoked" };
    },
    async listDevices({ userToken, installationId }) {
      if (
        !(await github.canAdministerInstallation({ userToken, installationId }))
      ) {
        return [];
      }

      return [...devices.values()]
        .filter((device) => device.installationId === installationId)
        .map((device) => ({ ...device }));
    },
  };
}
