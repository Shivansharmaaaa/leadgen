import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schema from "./schema";

const connectionString =
  process.env.DATABASE_URL ?? "postgres://leadgen:leadgen@localhost:5433/leadgen";

// One pool per process. Next dev reloads modules, so cache it on globalThis.
const globalForDb = globalThis as unknown as { __leadgenSql?: ReturnType<typeof postgres> };

const client =
  globalForDb.__leadgenSql ??
  postgres(connectionString, { max: 10, idle_timeout: 20, prepare: false });

if (process.env.NODE_ENV !== "production") globalForDb.__leadgenSql = client;

export const db = drizzle(client, { schema });
export { client as sql };
export * from "./schema";
export type Db = typeof db;
