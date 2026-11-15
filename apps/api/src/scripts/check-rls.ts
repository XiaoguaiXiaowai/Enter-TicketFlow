import { Client } from 'pg';

import { writeLog } from '../common/logger';
import { getEnv } from '../config/runtime';
import { credentialsFromUrl, parseConnectionUrl } from './db-connection';

interface RlsRow {
  relname: string;
  relrowsecurity: boolean;
  relforcerowsecurity: boolean;
}

/**
 * RLS 覆盖检查：任何含 tenant_id 的表都必须同时启用并强制 RLS。
 * 以表所有者身份检查元数据，不读取业务数据。
 */
async function main(): Promise<void> {
  const env = getEnv();
  const target = parseConnectionUrl(env.MIGRATE_DATABASE_URL);
  const migrator = credentialsFromUrl(env.MIGRATE_DATABASE_URL);
  const client = new Client({
    host: target.host,
    port: target.port,
    database: target.database,
    user: migrator.user,
    password: migrator.password,
  });

  await client.connect();
  try {
    const result = await client.query<RlsRow>(
      `SELECT c.relname, c.relrowsecurity, c.relforcerowsecurity
         FROM pg_class c
         JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'public'
          AND c.relkind = 'r'
          AND EXISTS (
            SELECT 1 FROM information_schema.columns col
             WHERE col.table_schema = 'public'
               AND col.table_name = c.relname
               AND col.column_name = 'tenant_id'
          )
        ORDER BY c.relname`,
    );

    const failures = result.rows.filter(
      (row) => !row.relrowsecurity || !row.relforcerowsecurity,
    );

    if (result.rows.length === 0) {
      throw new Error('未发现任何含 tenant_id 的表，检查逻辑可能失效');
    }
    if (failures.length > 0) {
      writeLog('error', 'RLS coverage check failed', {
        tables: failures.map((row) => ({
          table: row.relname,
          enabled: row.relrowsecurity,
          forced: row.relforcerowsecurity,
        })),
      });
      process.exit(1);
    }

    writeLog('info', 'RLS coverage check passed', {
      tables: result.rows.map((row) => row.relname),
    });
  } finally {
    await client.end();
  }
}

main().catch((error: unknown) => {
  writeLog('error', 'RLS coverage check crashed', {
    error: error instanceof Error ? error.message : String(error),
  });
  process.exit(1);
});
