import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';

import { writeLog } from '../common/logger';
import { getEnv } from '../config/runtime';
import { applyDbGrants } from './apply-db-grants';
import { bootstrapDbRoles } from './bootstrap-db-roles';

function prismaBin(): string {
  const candidates = [
    resolve(process.cwd(), 'node_modules/.bin/prisma'),
    resolve(__dirname, '../../node_modules/.bin/prisma'),
    resolve(__dirname, '../../../../node_modules/.bin/prisma'),
  ];
  const found = candidates.find((candidate) => existsSync(candidate));
  if (!found) {
    throw new Error(`prisma CLI not found, looked in: ${candidates.join(', ')}`);
  }
  return found;
}

/**
 * 一次性的数据库准备任务：建角色 -> 执行迁移 -> 授权。
 * 由 compose 的 migrate 服务调用，也可在 CI 中直接执行。
 */
async function main(): Promise<void> {
  const env = getEnv();

  writeLog('info', 'preparing database roles');
  await bootstrapDbRoles();

  writeLog('info', 'applying migrations');
  const result = spawnSync(prismaBin(), ['migrate', 'deploy'], {
    stdio: 'inherit',
    env: { ...process.env, DATABASE_URL: env.MIGRATE_DATABASE_URL },
  });
  if (result.status !== 0) {
    throw new Error(`prisma migrate deploy failed with exit code ${result.status ?? 'unknown'}`);
  }

  writeLog('info', 'applying runtime grants');
  await applyDbGrants();

  writeLog('info', 'database preparation completed');
}

main().catch((error: unknown) => {
  writeLog('fatal', 'database preparation failed', {
    error: error instanceof Error ? error.message : String(error),
  });
  process.exit(1);
});
