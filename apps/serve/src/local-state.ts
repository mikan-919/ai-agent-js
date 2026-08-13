import { fileURLToPath } from "node:url";

import { Database } from "bun:sqlite";
import { drizzle } from "drizzle-orm/bun-sqlite/driver";
import { migrate } from "drizzle-orm/bun-sqlite/migrator";

const sourceMigrationsFolder = fileURLToPath(
  new URL("../migrations", import.meta.url),
);

export function openServeLocalState(
  databasePath: string,
  migrationsFolder = sourceMigrationsFolder,
) {
  const database = new Database(databasePath);
  database.exec("PRAGMA journal_mode = WAL");
  const state = drizzle(database);
  migrate(state, { migrationsFolder });

  return database;
}
