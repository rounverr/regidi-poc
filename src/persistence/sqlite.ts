import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { sqlStore, type Query } from "./sql-store.ts";

const migrations = new URL("../../migrations/", import.meta.url);

function transaction<Result>(db: DatabaseSync, execute: () => Result): Result {
  // Acquire the write lock before any reads so other connections cannot change the snapshot.
  db.exec("BEGIN IMMEDIATE");
  try {
    const result = execute();
    db.exec("COMMIT");
    return result;
  } catch (error) {
    if (db.isTransaction) db.exec("ROLLBACK");
    throw error;
  }
}

function migrate(db: DatabaseSync) {
  const files = readdirSync(migrations).filter((file) => /^\d{4}_[a-z0-9_]+\.sql$/.test(file)).sort();
  if (!files.length) throw new Error("No lab migrations found");

  transaction(db, () => {
    db.exec("CREATE TABLE IF NOT EXISTS lab_schema_migrations (name TEXT PRIMARY KEY, checksum TEXT NOT NULL) STRICT");
    const applied = db.prepare("SELECT name, checksum FROM lab_schema_migrations ORDER BY name").all();
    const record = db.prepare("INSERT INTO lab_schema_migrations (name, checksum) VALUES (?, ?)");
    for (const [index, file] of files.entries()) {
      const sql = readFileSync(new URL(file, migrations), "utf8");
      const checksum = createHash("sha256").update(sql.replaceAll("\r\n", "\n")).digest("hex");
      const prior = applied[index];
      if (prior) {
        if (prior.name !== file || prior.checksum !== checksum) {
          throw new Error(`SQLite migration history differs at ${file}`);
        }
        continue;
      }
      db.exec(sql);
      record.run(file, checksum);
    }
    if (applied.length > files.length) throw new Error("SQLite schema is newer than this version of the lab");
  });
}

/** Open a SQLite database, updating the shared schema atomically before use. */
export function openSqlite(path: string) {
  const database = new DatabaseSync(path, { enableForeignKeyConstraints: true, timeout: 5_000 });
  try {
    database.exec("PRAGMA journal_mode = WAL");
    migrate(database);
  } catch (error) {
    database.close();
    throw error;
  }
  const store = sqlStore({
    async first<Row>([sql, ...parameters]: Query) {
      return (database.prepare(sql).get(...parameters) as Row | undefined) ?? null;
    },
    async run([sql, ...parameters]) {
      database.prepare(sql).run(...parameters);
    },
    async batch<Row>(queries: readonly Query[]) {
      return transaction(database, () =>
        queries.map(([sql, ...parameters]) => database.prepare(sql).all(...parameters) as Row[]),
      );
    },
  });
  return { database, store };
}
