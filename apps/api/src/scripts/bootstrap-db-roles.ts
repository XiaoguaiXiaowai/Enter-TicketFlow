import { Client } from 'pg';

import { writeLog } from '../common/logger';
import { getEnv } from '../config/runtime';
import {
  assertRoleName,
  credentialsFromUrl,
  parseConnectionUrl,
  quoteIdentifier,
  quoteLiteral,
  type RoleCredentials,
} from './db-connection';

/**
 * 以超级用户创建/更新三个数据库角色，并授予 schema 层面的最小权限：
 * - app_migrator：可执行 DDL，用于迁移
 * - app_rw：无 CREATE，执行 DDL 会被拒绝
 * - app_worker：与 app_rw 同级，用于后台任务
 * 脚本可重复执行。
 */
export async function bootstrapDbRoles(): Promise<void> {
  const env = getEnv();
  const target = parseConnectionUrl(env.MIGRATE_DATABASE_URL);
  const roles: [RoleCredentials, RoleCredentials, RoleCredentials] = [
    credentialsFromUrl(env.DATABASE_URL),
    credentialsFromUrl(env.MIGRATE_DATABASE_URL),
    credentialsFromUrl(env.WORKER_DATABASE_URL),
  ];

  for (const role of roles) {
    assertRoleName(role.user);
  }

  const client = new Client({
    host: target.host,
    port: target.port,
    database: target.database,
    user: env.POSTGRES_SUPERUSER,
    password: env.POSTGRES_SUPERUSER_PASSWORD,
  });

  await client.connect();
  try {
    for (const role of roles) {
      const identifier = quoteIdentifier(role.user);
      await client.query(`
        DO $$
        BEGIN
          IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = ${quoteLiteral(role.user)}) THEN
            CREATE ROLE ${identifier} LOGIN;
          END IF;
        END
        $$;
      `);
      await client.query(
        `ALTER ROLE ${identifier} WITH LOGIN PASSWORD ${quoteLiteral(role.password)} NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS`,
      );
    }

    const [rw, migrator, worker] = roles;
    const database = quoteIdentifier(target.database);
    const rwName = quoteIdentifier(rw.user);
    const migratorName = quoteIdentifier(migrator.user);
    const workerName = quoteIdentifier(worker.user);

    await client.query(
      `GRANT CONNECT ON DATABASE ${database} TO ${rwName}, ${migratorName}, ${workerName}`,
    );
    await client.query(`GRANT USAGE, CREATE ON SCHEMA public TO ${migratorName}`);
    await client.query(`GRANT CREATE ON DATABASE ${database} TO ${migratorName}`);
    await client.query(`GRANT USAGE ON SCHEMA public TO ${rwName}, ${workerName}`);
    await client.query(`REVOKE CREATE ON SCHEMA public FROM ${rwName}, ${workerName}`);

    writeLog('info', 'database roles ready', { users: roles.map((role) => role.user) });
  } finally {
    await client.end();
  }
}
