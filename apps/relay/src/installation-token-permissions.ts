import { identity } from "@mikan-919/oriel-identity";

/**
 * 短命installation tokenへ載せてよい最大権限。
 *
 * CONCEPT.md原則2の「制限された外部操作」を、relayが発行するtokenの権限そのもの
 * でも守る。製品が必要とするのは、canonicalブランチの送信（contents）、Issueと
 * Linear連携の書き込み（issues）、レビュー可能なプルリクエスト（pull_requests）、
 * repositoryの現在値読み取り（metadata）だけとする。これ以外のkey、およびここへ
 * 書いた値より広い値は受け付けない。
 */
export const maximumInstallationTokenPermissions = {
  contents: ["read", "write"],
  issues: ["read", "write"],
  pull_requests: ["read", "write"],
  metadata: ["read"],
} as const satisfies Record<string, readonly string[]>;

/** allowlistの最大値。設定を与えない場合の既定でもある。 */
export const minimalInstallationTokenPermissions: Record<string, string> =
  Object.fromEntries(
    Object.entries(maximumInstallationTokenPermissions).map(
      ([permission, values]) => [permission, values[values.length - 1]],
    ),
  );

function fail(detail: string): never {
  throw new Error(
    `${identity.environmentPrefix}INSTALLATION_TOKEN_PERMISSIONS ${detail}`,
  );
}

/**
 * 設定として受け取った権限を検証する。allowlist外のkey、許可した値より広い値、
 * string以外、空はfail closedにする。
 */
export function assertInstallationTokenPermissions(
  value: Record<string, string>,
): Record<string, string> {
  const entries = Object.entries(value);

  if (entries.length === 0) {
    fail("must grant at least one permission");
  }

  for (const [permission, granted] of entries) {
    const allowed: readonly string[] | undefined = Object.hasOwn(
      maximumInstallationTokenPermissions,
      permission,
    )
      ? maximumInstallationTokenPermissions[
          permission as keyof typeof maximumInstallationTokenPermissions
        ]
      : undefined;

    if (allowed === undefined) {
      fail(`must not grant ${permission}`);
    }

    if (typeof granted !== "string" || !allowed.includes(granted)) {
      fail(`must not grant ${permission} as ${String(granted)}`);
    }
  }

  return { ...value };
}

/** deploy設定のJSONを、allowlistを通った権限だけへ落とす。 */
export function parseInstallationTokenPermissions(
  json: string,
): Record<string, string> {
  let parsed: unknown;

  try {
    parsed = JSON.parse(json);
  } catch {
    return fail("must be JSON");
  }

  if (
    parsed === null ||
    typeof parsed !== "object" ||
    Array.isArray(parsed) ||
    Object.getOwnPropertySymbols(parsed).length > 0
  ) {
    return fail("must be a JSON object of permissions");
  }

  return assertInstallationTokenPermissions(parsed as Record<string, string>);
}
