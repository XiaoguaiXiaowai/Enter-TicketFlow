import { existsSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';

import { Injectable, ServiceUnavailableException } from '@nestjs/common';
import type { HealthLiveResponse, HealthReadyResponse, MigrationsSummary } from '@ticket/shared';

import { PrismaService } from '../prisma/prisma.service';

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
  constructor(private readonly prisma: PrismaService) {}

  live(): HealthLiveResponse {
    return { status: 'ok', uptimeSeconds: Math.round(process.uptime()) };
  }

  async ready(): Promise<HealthReadyResponse> {
    const expected = expectedMigrations();

    try {
      await this.prisma.$queryRaw`SELECT 1`;
    } catch {
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
      checks: { migrations },
    };
  }
}
