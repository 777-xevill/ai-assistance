import path from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import { drizzle as drizzlePg, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import { migrate as migratePg } from 'drizzle-orm/node-postgres/migrator';
import { drizzle as drizzlePglite } from 'drizzle-orm/pglite';
import { migrate as migratePglite } from 'drizzle-orm/pglite/migrator';
import pg from 'pg';
import { config } from '../config.ts';
import { logger } from '../lib/logger.ts';
import * as schema from './schema.ts';

export type Db = NodePgDatabase<typeof schema>;
/** A transaction handle. Inside db.transaction() always use it: the embedded database has a single
 *  connection, so a query on the global `db` would wait for the transaction forever. */
export type Tx = Parameters<Parameters<Db['transaction']>[0]>[0];
export type Executor = Db | Tx;

const migrationsFolder = path.resolve(import.meta.dirname, '..', '..', 'drizzle');

let instance: Db | null = null;
let closeFn: (() => Promise<void>) | null = null;

/**
 * The database handle. Both drivers expose the same Drizzle query builder, so the embedded
 * PGlite instance is typed as the node-postgres flavour (raw `execute` results have `.rows` in both).
 */
export const db = new Proxy({} as Db, {
  get(_target, prop) {
    if (!instance) throw new Error('Database not initialised. Call initDb() first.');
    const value = Reflect.get(instance, prop, instance);
    return typeof value === 'function' ? value.bind(instance) : value;
  },
});

export async function initDb(): Promise<void> {
  if (instance) return;
  if (config.databaseUrl) {
    const pool = new pg.Pool({
      connectionString: config.databaseUrl,
      max: 10,
      ssl: /sslmode=require|ssl=true/.test(config.databaseUrl) ? { rejectUnauthorized: false } : undefined,
    });
    const database = drizzlePg(pool, { schema });
    await migratePg(database, { migrationsFolder });
    instance = database;
    closeFn = () => pool.end();
    logger.info('Connected to PostgreSQL');
  } else {
    const dir = path.join(config.dataDir, 'pgdata');
    const client = new PGlite(dir);
    await client.waitReady;
    const database = drizzlePglite(client, { schema });
    await migratePglite(database, { migrationsFolder });
    instance = database as unknown as Db;
    closeFn = () => client.close();
    logger.info(`Using embedded Postgres (PGlite) at ${dir}`);
  }
}

export async function closeDb(): Promise<void> {
  if (closeFn) await closeFn();
  instance = null;
  closeFn = null;
}

export { schema };
