import { PrismaClient } from '@prisma/client';

import { getEnv } from '../src/config/runtime';

/**
 * Seed 框架。I0 没有任何业务数据，脚本只验证连接与执行链路。
 * 后续迭代的种子数据必须使用 upsert 或 ON CONFLICT DO NOTHING 保持可重复执行。
 */
async function main(): Promise<void> {
  const prisma = new PrismaClient({ datasourceUrl: getEnv().MIGRATE_DATABASE_URL });

  try {
    await prisma.$queryRaw`SELECT 1`;
    process.stdout.write(
      `${JSON.stringify({ level: 'info', message: 'seed completed: no baseline data in I0' })}\n`,
    );
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((error: unknown) => {
  process.stderr.write(
    `${JSON.stringify({
      level: 'error',
      message: 'seed failed',
      error: error instanceof Error ? error.message : String(error),
    })}\n`,
  );
  process.exit(1);
});
