import { Octokit } from "@octokit/rest";

import type { DeviceTokenStore } from "./device-registration";
import type { RelayDeviceClient } from "./relay-client";

export interface InstallationOctokitOptions {
  relay: Pick<RelayDeviceClient, "requestInstallationToken">;
  tokenStore: DeviceTokenStore;
  repositoryId: number;
  newOctokit?: (auth: string) => Octokit;
}

/**
 * 外部書き込みに使う認証済みOctokitを、要求のたびに組み立てる。
 *
 * device tokenは`Bun.secrets`から読み、relayが返す短命installation tokenは
 * この呼び出しの中だけで使い、どこにも保存しない。harnessのenv、argv、tool
 * 入力へは渡さない。tokenを取れない場合はnullを返してfail closedにする。
 */
export function createInstallationOctokitResolver({
  relay,
  tokenStore,
  repositoryId,
  newOctokit = (auth) => new Octokit({ auth }),
}: InstallationOctokitOptions): () => Promise<Octokit | null> {
  return async () => {
    const deviceToken = await tokenStore.get(repositoryId);

    if (deviceToken === null) {
      return null;
    }

    const issued = await relay
      .requestInstallationToken(deviceToken)
      .catch(() => null);

    return issued === null || issued.repositoryId !== repositoryId
      ? null
      : newOctokit(issued.token);
  };
}
