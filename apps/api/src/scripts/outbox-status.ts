import { PrismaClient } from '@prisma/client';

import { getEnv } from '../config/runtime';

interface StatusRow {
  status: string;
  count: number;
  oldest: Date | null;
}

/**
 * Outbox 运维查询：按租户汇总各状态数量与最老可投递时间，
 * 并提供 DEAD 事件样本用于人工补偿。
 * 用法：pnpm --filter @ticket/api outbox:status
 */
async function main(): Promise<void> {
  const env = getEnv();
  const prisma = new PrismaClient({ datasourceUrl: env.WORKER_DATABASE_URL });
  try {
    const tenants = await prisma.tenant.findMany({
      select: { id: true, code: true, status: true },
      orderBy: { code: 'asc' },
    });

    for (const tenant of tenants) {
      const rows = await prisma.$transaction(async (tx) => {
        await tx.$queryRaw`SELECT set_config('app.tenant_id', ${tenant.id}, true)`;
        return tx.$queryRaw<StatusRow[]>`
          SELECT status::text AS status, count(*)::int AS count, min(available_at) AS oldest
          FROM outbox_events
          GROUP BY status
          ORDER BY status
        `;
      });

      const summary = rows
        .map((row) => `${row.status}=${row.count}${row.oldest === null ? '' : `(oldest ${row.oldest.toISOString()})`}`)
        .join(' ');
      process.stdout.write(`tenant=${tenant.code} status=${tenant.status} ${summary === '' ? 'empty' : summary}\n`);

      const dead = await prisma.$transaction(async (tx) => {
        await tx.$queryRaw`SELECT set_config('app.tenant_id', ${tenant.id}, true)`;
        return tx.$queryRaw<Array<{ id: string; type: string; attempts: number; lastError: string | null }>>`
          SELECT id, type, attempts, last_error AS "lastError"
          FROM outbox_events
          WHERE status = 'DEAD'
          ORDER BY attempts DESC
          LIMIT 5
        `;
      });

      for (const event of dead) {
        process.stdout.write(
          `  dead id=${event.id} type=${event.type} attempts=${event.attempts} error=${event.lastError ?? 'none'}\n`,
        );
      }
    }
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
});