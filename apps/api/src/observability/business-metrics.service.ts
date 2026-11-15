import { Injectable, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';

import { writeLog } from '../common/logger';
import { getEnv } from '../config/runtime';
import { PrismaService } from '../prisma/prisma.service';
import { MetricsService } from './metrics.service';

interface ConnectionStats {
  active: number;
  max: number;
}

/**
 * 业务指标采集：每 METRICS_INTERVAL_SECONDS 采样一次。
 * 含 tenant_id 的表受 RLS 约束，因此按租户逐个设置上下文再聚合。
 */
@Injectable()
export class BusinessMetricsService implements OnModuleInit, OnModuleDestroy {
  private timer: NodeJS.Timeout | null = null;
  private collecting = false;

  constructor(
    private readonly prisma: PrismaService,
    private readonly metrics: MetricsService,
  ) {}

  onModuleInit(): void {
    const interval = getEnv().METRICS_INTERVAL_SECONDS * 1000;
    this.timer = setInterval(() => void this.collect(), interval);
    this.timer.unref();
    void this.collect();
  }

  onModuleDestroy(): void {
    if (this.timer !== null) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  async collect(): Promise<void> {
    if (this.collecting) {
      return;
    }
    this.collecting = true;
    try {
      await this.collectConnections();
      await this.collectTenantMetrics();
    } catch (error) {
      writeLog('warn', 'business metrics collection failed', {
        error: error instanceof Error ? error.message : String(error),
      });
    } finally {
      this.collecting = false;
    }
  }

  private async collectConnections(): Promise<void> {
    const rows = await this.prisma.$queryRaw<ConnectionStats[]>`
      SELECT
        (SELECT count(*)::int FROM pg_stat_activity WHERE datname = current_database()) AS active,
        current_setting('max_connections')::int AS max
    `;
    const stats = rows[0];
    if (stats === undefined) {
      return;
    }
    this.metrics.setGauge('db_connections', { state: 'active' }, stats.active);
    this.metrics.setGauge('db_connections_max', {}, stats.max);
  }

  private async collectTenantMetrics(): Promise<void> {
    const tenants = await this.prisma.tenant.findMany({
      where: { status: 'ACTIVE' },
      select: { id: true, code: true },
    });

    for (const tenant of tenants) {
      try {
        const counts = await this.prisma.withTenant(tenant.id, async (tx) => {
          const [pendingEvents, pendingKeys, openTickets] = await Promise.all([
            tx.outboxEvent.count({ where: { status: 'PENDING' } }),
            tx.idempotencyKey.count({ where: { status: 'PENDING' } }),
            tx.ticket.count({ where: { status: { not: 'CLOSED' } } }),
          ]);
          return { pendingEvents, pendingKeys, openTickets };
        });

        this.metrics.setGauge('outbox_pending_events', { tenant: tenant.code }, counts.pendingEvents);
        this.metrics.setGauge(
          'idempotency_pending_keys',
          { tenant: tenant.code },
          counts.pendingKeys,
        );
        this.metrics.setGauge('open_tickets', { tenant: tenant.code }, counts.openTickets);
      } catch (error) {
        writeLog('warn', 'tenant metrics collection failed', {
          tenant: tenant.code,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
  }
}