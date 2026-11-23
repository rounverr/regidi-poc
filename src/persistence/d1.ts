import { sqlStore, type Query } from "./sql-store.ts";

export function d1Store(db: D1Database) {
  function prepare([sql, ...parameters]: Query) {
    const statement = db.prepare(sql);
    return parameters.length ? statement.bind(...parameters) : statement;
  }

  return sqlStore({
    first: <Row>(query: Query) => prepare(query).first<Row>(),
    async run(query) {
      await prepare(query).run();
    },
    async batch<Row>(queries: readonly Query[]) {
      const results = await db.batch<Row>(queries.map(prepare));
      return results.map(({ results }) => results);
    },
  });
}
