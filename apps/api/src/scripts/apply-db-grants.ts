import { Client } from 'pg';

import { writeLog } from '../common/logger';
import { getEnv } from '../config/runtime';
import {
  assertRoleName,
  credentialsFromUrl,
  parseConnectionUrl,
  quoteIdentifier,
} from './db-connection';

/**
 * 迁移完成后由表所有者（app_migrator）授予运行时角色读写权限，
 * 同时为后续迁移新建的表设置默认权限。
 */
export async function applyDbGrants(): Promise<void> {
  const env = getEnv();
  const target = parseConnectionUrl(env.MIGRATE_DATABASE_URL);
  const migrator = credentialsFromUrl(env.MIGRATE_DATABASE_URL);
  const runtimeRoles = [
    credentialsFromUrl(env.DATABASE_URL).user,
    credentialsFromUrl(env.WORKER_DATABASE_URL).user,
  ];

  assertRoleName(migrator.user);
  for (const role of runtimeRoles) {
    assertRoleName(role);
  }

  const client = new Client({
    host: target.host,
    port: target.port,
    database: target.database,
    user: migrator.user,
    password: migrator.password,
  });

  await client.connect();
  try {
    const roleList = runtimeRoles.map(quoteIdentifier).join(', ');
    const migratorName = quoteIdentifier(migrator.user);

    await client.query(
      `GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO ${roleList}`,
    );
    await client.query(`GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO ${roleList}`);
    await client.query(
      `ALTER DEFAULT PRIVILEGES FOR ROLE ${migratorName} IN SCHEMA public
       GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO ${roleList}`,
    );
    await client.query(
      `ALTER DEFAULT PRIVILEGES FOR ROLE ${migratorName} IN SCHEMA public
       GRANT USAGE, SELECT ON SEQUENCES TO ${roleList}`,
    );

    // 审计只追加：运行时角色只能 SELECT / INSERT，直接 UPDATE / DELETE 会被数据库拒绝。
    await client.query(`REVOKE UPDATE, DELETE ON "audit_logs" FROM ${roleList}`);

    writeLog('info', 'database grants applied', { roles: runtimeRoles });
  } finally {
    await client.end();
  }
}
