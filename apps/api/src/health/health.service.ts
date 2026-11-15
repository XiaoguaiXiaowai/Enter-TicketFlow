import { existsSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';

import { Injectable, ServiceUnavailableException } from '@nestjs/common';
import type { HealthLiveResponse, HealthReadyResponse, MigrationsSummary } from '@ticket/shared';

import { MetricsService } from '../observability/metrics.service';
import { PrismaService } from '../prisma/prisma.service';
import { RedisService } from '../redis/redis.service';

interface MigrationRow {
  migration_name: string;
  finished_at: Date | null;
  rolled_back_at: Date | null;
}

function migrationsDir(): string {
  const candidates = [
    resolve(process.cwd(), 'prisma/migrations'),
    resolve(__dirname, '../../prisma/migrations'),
    resolve(__dirname, '../../../prisma/migrations'),
  ];

  return (
    candidates.find((candidate) => existsSync(candidate)) ??
    resolve(process.cwd(), 'prisma/migrations')
  );
}

function expectedMigrations(): string[] {
  return readdirSync(migrationsDir(), { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
}

@Injectable()
export class HealthService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly redis: RedisService,
    private readonly metrics: MetricsService,
  ) {}

  live(): HealthLiveResponse {
    return { status: 'ok', uptimeSeconds: Math.round(process.uptime()) };
  }

  async ready(): Promise<HealthReadyResponse> {
    const expected = expectedMigrations();

    // 主动探活：Redis 故障只标记降级，不阻塞就绪判定。
    await this.redis.execute((client) => client.ping());

    try {
      await this.prisma.$queryRaw`SELECT 1`;
    } catch {
      this.metrics.incCounter('health_ready_failures_total', { reason: 'database' });
      throw new ServiceUnavailableException({
        code: 'NOT_READY',
        message: 'database is not ready',
        details: { database: 'down' },
      });
    }

    let rows: MigrationRow[] = [];
    try {
      rows = await this.prisma.$queryRaw<MigrationRow[]>`
        SELECT migration_name, finished_at, rolled_back_at
        FROM _prisma_migrations
        ORDER BY started_at ASC
      `;
    } catch {
      // 数据库可连接但从未执行过迁移（表不存在），按全部待执行处理。
      rows = [];
    }

    const applied = rows
      .filter((row) => row.finished_at !== null && row.rolled_back_at === null)
      .map((row) => row.migration_name);

    const migrations: MigrationsSummary = {
      applied: applied.length,
      expected: expected.length,
      pending: expected.filter((name) => !applied.includes(name)),
    };

    if (migrations.pending.length > 0) {
      this.metrics.incCounter('health_ready_failures_total', { reason: 'migrations' });
      throw new ServiceUnavailableException({
        code: 'NOT_READY',
        message: 'database migrations are not applied',
        details: { migrations },
      });
    }

    return {
      status: 'ok',
      database: 'up',
      migrationVersion: applied[applied.length - 1] ?? 'none',
      // Redis 只用于限流等可降级能力：不可用时仍返回 200，但显式暴露状态。
      checks: { migrations, redis: this.redis.componentState === 'connected' ? 'up' : 'degraded' },
    };
  }
}
