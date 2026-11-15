import { Injectable, Optional, type OnModuleDestroy } from '@nestjs/common';

import { writeLog } from '../common/logger';
import { getEnv } from '../config/runtime';
import { MetricsService } from '../observability/metrics.service';
import { TenantScopedClient } from './tenant-scoped-client';

const SLOW_QUERY_MS = 500;

/**
 * 连接按需建立：数据库不可用时进程仍能启动，
 * 由 /health/ready 返回 503，而不是让容器反复重启。
 * 慢查询只记录 SQL 指纹（不含参数值），用于定位 N+1 与缺索引。
 */
@Injectable()
export class PrismaService extends TenantScopedClient implements OnModuleDestroy {
  constructor(@Optional() private readonly metrics?: MetricsService) {
    super({ datasourceUrl: getEnv().DATABASE_URL, log: [{ emit: 'event', level: 'query' }] });
    const client = this as unknown as {
      $on: (event: 'query', callback: (event: { duration: number; query: string }) => void) => void;
    };
    client.$on('query', (event) => {
      if (event.duration < SLOW_QUERY_MS) {
        return;
      }
      this.metrics?.incCounter('db_slow_queries_total');
      writeLog('warn', 'slow query', {
        durationMs: event.duration,
        query: event.query.replace(/\s+/g, ' ').slice(0, 200),
      });
    });
  }

  async onModuleDestroy(): Promise<void> {
    try {
      await this.$disconnect();
    } catch (error: unknown) {
      writeLog('warn', 'failed to disconnect prisma', {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
}