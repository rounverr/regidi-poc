import { readdir, readFile } from "node:fs/promises";

const directory = new URL("../migrations/", import.meta.url);
export const migrations = await Promise.all(
  (await readdir(directory)).filter(name => name.endsWith(".sql")).sort().map(async name => ({
    name, sql: await readFile(new URL(name, directory), "utf8"),
  })),
);

export async function migrateD1(db, files = migrations) {
  // Prepared D1 statements handle complete trigger bodies across lines.
  for (const { sql } of files) await db.prepare(sql).run();
}
