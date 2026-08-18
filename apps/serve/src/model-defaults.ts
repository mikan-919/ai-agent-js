import type { Database } from "bun:sqlite";

import type { JobKind } from "./job-registry";

export const modelDefaultKinds = [
  "what_confirmation",
  "how_confirmation",
  "pr_response",
  "implementation",
] as const satisfies readonly Exclude<JobKind, "issue_conversation">[];

export type ModelDefaultKind = (typeof modelDefaultKinds)[number];
export type ModelDefaultScope = "base" | ModelDefaultKind;

export interface ModelSelection {
  provider: string;
  id: string;
}

export interface ModelDefaults {
  base: ModelSelection | null;
  perKind: Record<ModelDefaultKind, ModelSelection | null>;
}

export interface ModelDefaultsStore {
  get(scope: ModelDefaultScope): ModelSelection | null;
  set(scope: ModelDefaultScope, model: ModelSelection): void;
  clear(scope: ModelDefaultScope): void;
  list(): ModelDefaults;
}

interface ModelDefaultRow {
  provider: string;
  modelId: string;
}

function toModelSelection(row: ModelDefaultRow | null): ModelSelection | null {
  return row === null ? null : { provider: row.provider, id: row.modelId };
}

export function createModelDefaultsStore(
  database: Database,
): ModelDefaultsStore {
  const select = database.query<ModelDefaultRow, [string]>(
    `SELECT provider, model_id AS modelId
     FROM model_defaults
     WHERE scope = ?`,
  );
  const upsert = database.query(
    `INSERT INTO model_defaults (scope, provider, model_id)
     VALUES (?, ?, ?)
     ON CONFLICT(scope) DO UPDATE SET
       provider = excluded.provider,
       model_id = excluded.model_id`,
  );
  const remove = database.query(`DELETE FROM model_defaults WHERE scope = ?`);

  return {
    get(scope) {
      return toModelSelection(select.get(scope) ?? null);
    },
    set(scope, model) {
      upsert.run(scope, model.provider, model.id);
    },
    clear(scope) {
      remove.run(scope);
    },
    list() {
      return {
        base: toModelSelection(select.get("base") ?? null),
        perKind: Object.fromEntries(
          modelDefaultKinds.map((kind) => [
            kind,
            toModelSelection(select.get(kind) ?? null),
          ]),
        ) as Record<ModelDefaultKind, ModelSelection | null>,
      };
    },
  };
}

/**
 * Job作成時点でmodelを固定するためのfallback連鎖。
 * `issue_conversation`はmodelを使わないため、どの値も解決しない。
 */
export function resolveModelDefault(
  store: ModelDefaultsStore,
  kind: JobKind,
  override?: ModelSelection,
): ModelSelection | null {
  if (kind === "issue_conversation") {
    return null;
  }

  return override ?? store.get(kind) ?? store.get("base");
}
