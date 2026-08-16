import type { Context, Models } from "@earendil-works/pi-ai";
import { builtinModels } from "@earendil-works/pi-ai/providers/all";
import { identity } from "@mikan-919/oriel-identity";

import { createLmStudioProvider } from "./lm-studio-provider";
import type { ModelStreamProvider } from "./model-stream";

export interface PiModelStreamProviderDependencies {
  /** 提供元と互換性設定の正本。`serve`が構成し、harnessへは渡さない。 */
  models: Models;
  /**
   * 提供元のcredentialの解決。`Bun.secrets`など`serve`の内側だけで解け、
   * 解けない場合はnullでfail closedにする。
   */
  resolveApiKey: (provider: string) => Promise<string | null>;
}

/**
 * `@earendil-works/pi-ai`で提供元へ接続するproduction provider。
 *
 * modelを利用できない場合は例外で止め、別のmodelへ暗黙に切り替えない。pi-aiの
 * stream eventは別形式へ変換せず、そのままIPCへ流す。
 */
export function createPiModelStreamProvider({
  models,
  resolveApiKey,
}: PiModelStreamProviderDependencies): ModelStreamProvider {
  return {
    async *stream({ provider, model, context, signal }) {
      let selected = models.getModel(provider, model);

      // 動的なcatalogは、要求されたmodelが未知のときだけ読み直す。
      if (selected === undefined) {
        await models.refresh({
          allowNetwork: true,
          providers: [provider],
          signal,
        });
        selected = models.getModel(provider, model);
      }

      if (selected === undefined) {
        throw new Error(`the model ${provider}/${model} is not available`);
      }

      const apiKey = await resolveApiKey(provider);

      if (apiKey === null) {
        throw new Error(`no credential is configured for ${provider}`);
      }

      // credentialはこの呼び出しの引数としてだけ渡り、harnessへは出ない。
      yield* models.streamSimple(selected, context as Context, {
        apiKey,
        signal,
      });
    },
  };
}

/**
 * `serve`が持つ提供元の集合。
 *
 * pi-aiの公式providerに加えて、LM Studioの接続先が設定されている場合だけ暫定
 * 接続部を登録する。接続先はrepositoryではなく、この`serve`の利用者固有設定から
 * 来る。
 */
export function createServeModels({
  lmStudioBaseUrl,
}: { lmStudioBaseUrl?: string } = {}): Models {
  const models = builtinModels();

  if (lmStudioBaseUrl !== undefined && lmStudioBaseUrl !== "") {
    models.setProvider(createLmStudioProvider({ baseUrl: lmStudioBaseUrl }));
  }

  return models;
}

/**
 * 提供元のcredentialの保存先。
 *
 * ROADMAPのとおり`Bun.secrets`だけを正本とし、Secret Serviceを使えない場合は
 * 平文file、SQLite、環境変数へfallbackせずfail closedにする。keyを要求しない
 * ローカル提供元でも、`serve`へ明示的に登録した場合だけ要求を送る。
 */
export function bunSecretsModelCredential(provider: string) {
  return {
    async get(): Promise<string | null> {
      try {
        return (
          (await Bun.secrets.get({
            service: identity.codeName,
            name: `model-credential:${provider}`,
          })) ?? null
        );
      } catch {
        return null;
      }
    },
  };
}
