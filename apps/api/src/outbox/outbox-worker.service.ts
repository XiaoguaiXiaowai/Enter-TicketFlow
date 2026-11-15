import { Injectable, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import type { OutboxStatus, Prisma } from '@prisma/client';

import { writeLog } from '../common/logger';
import { getEnv } from '../config/runtime';
import { MetricsService } from '../observability/metrics.service';
import { WorkerPrismaService } from '../prisma/worker-prisma.service';
import { OutboxDeliveryService } from './outbox-delivery.service';

const BASE_BACKOFF_SECONDS = 5;
const MAX_BACKOFF_SECONDS = 300;
const CLEANUP_INTERVAL_MS = 60 * 60 * 1000;

interface ClaimedRow {
  id: string;
  tenantId: string;
  type: string;
  payload: Prisma.JsonValue;
  attempts: number;
}

/** 指数退避：5s、10s、20s……上限 5 分钟。 */
export function outboxBackoffSeconds(attempts: number): number {
  const seconds = BASE_BACKOFF_SECONDS * 2 ** Math.max(0, attempts);
  return Math.min(seconds, MAX_BACKOFF_SECONDS);
}

/**
 * Outbox 投递循环：按租户逐批认领（事务内 FOR UPDATE SKIP LOCKED），
 * 通过 available_at 租约避免多实例重复投递；投递失败按指数退避重试，超过上限进入 DEAD。
 */
@Injectable()
export class OutboxWorkerService implements OnModuleInit, OnModuleDestroy {
  private stopped = true;
  private loopHandle: NodeJS.Timeout | null = null;
  private cleanupHandle: NodeJS.Timeout | null = null;

  constructor(
    private readonly prisma: WorkerPrismaService,
    private readonly delivery: OutboxDeliveryService,
    private readonly metrics: MetricsService,
  ) {}

  onModuleInit(): void {
    this.stopped = false;
    void this.runLoop();
    this.cleanupHandle = setInterval(() => void this.cleanupExpiredIdempotencyKeys(), CLEANUP_INTERVAL_MS);
    this.cleanupHandle.unref();
  }

  onModuleDestroy(): void {
    this.stopped = true;
    if (this.loopHandle !== null) {
      clearTimeout(this.loopHandle);
      this.loopHandle = null;
    }
    if (this.cleanupHandle !== null) {
      clearInterval(this.cleanupHandle);
      this.cleanupHandle = null;
    }
  }

  /** 处理一轮全部租户，返回本轮投递（成功或失败）的事件数。 */
  async dispatchOnce(): Promise<number> {
    const tenants = await this.prisma.tenant.findMany({
      where: { status: 'ACTIVE' },
      select: { id: true, code: true },
    });

    let processed = 0;
    for (const tenant of tenants) {
      const events = await this.claimEvents(tenant.id);
      for (const event of events) {
        await this.deliverOne(tenant.code, event);
        processed += 1;
      }
    }
    return processed;
  }

  async cleanupExpiredIdempotencyKeys(): Promise<number> {
    const tenants = await this.prisma.tenant.findMany({ select: { id: true } });
    let removed = 0;
    for (const tenant of tenants) {
      try {
        removed += await this.prisma.withTenant(tenant.id, (tx) =>
          tx.idempotencyKey.deleteMany({ where: { expiresAt: { lt: new Date() } } }),
        ).then((result) => result.count);
      } catch (error) {
        writeLog('warn', 'idempotency cleanup failed', {
          tenantId: tenant.id,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
    if (removed > 0) {
      writeLog('info', 'idempotency keys cleaned', { removed });
    }
    return removed;
  }

  private async runLoop(): Promise<void> {
    const interval = getEnv().OUTBOX_POLL_INTERVAL_MS;
    while (!this.stopped) {
      try {
        await this.dispatchOnce();
      } catch (error) {
        writeLog('warn', 'outbox dispatch round failed', {
          error: error instanceof Error ? error.message : String(error),
        });
      }
      if (this.stopped) {
        break;
      }
      await new Promise<void>((resolve) => {
        // 不 unref：轮询定时器是 worker 进程的主循环，unref 会让进程空闲时直接退出。
        this.loopHandle = setTimeout(resolve, interval);
      });
    }
  }

  private async claimEvents(tenantId: string): Promise<ClaimedRow[]> {
    const env = getEnv();
    return this.prisma.withTenant(tenantId, (tx) =>
      tx.$queryRaw<ClaimedRow[]>`
        UPDATE outbox_events
        SET available_at = now() + make_interval(secs => ${env.OUTBOX_LEASE_SECONDS}::int)
        WHERE id IN (
          SELECT id FROM outbox_events
          WHERE status = 'PENDING' AND available_at <= now()
          ORDER BY available_at
          LIMIT ${env.OUTBOX_BATCH_SIZE}::int
          FOR UPDATE SKIP LOCKED
        )
        RETURNING id, tenant_id AS "tenantId", type, payload, attempts
      `,
    );
  }

  private async deliverOne(tenantCode: string, event: ClaimedRow): Promise<void> {
    try {
      await this.delivery.deliver(event);
      await this.prisma.withTenant(event.tenantId, (tx) =>
        tx.outboxEvent.update({
          where: { id: event.id },
          data: { status: 'DELIVERED', lastError: null },
        }),
      );
      this.metrics.incCounter('outbox_delivered_total', { type: event.type });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const maxAttempts = getEnv().OUTBOX_MAX_ATTEMPTS;
      const attempts = event.attempts + 1;
      const status: OutboxStatus = attempts >= maxAttempts ? 'DEAD' : 'PENDING';
      const delay = outboxBackoffSeconds(attempts);

      await this.prisma.withTenant(event.tenantId, (tx) =>
        tx.outboxEvent.update({
          where: { id: event.id },
          data: {
            attempts,
            status,
            lastError: message.slice(0, 500),
            availableAt: new Date(Date.now() + delay * 1000),
          },
        }),
      );

      if (status === 'DEAD') {
        this.metrics.incCounter('outbox_dead_total', { type: event.type });
        writeLog('error', 'outbox event moved to dead', {
          eventId: event.id,
          tenant: tenantCode,
          type: event.type,
          attempts,
          error: message,
        });
      } else {
        this.metrics.incCounter('outbox_retry_total', { type: event.type });
        writeLog('warn', 'outbox delivery failed, retry scheduled', {
          eventId: event.id,
          tenant: tenantCode,
          type: event.type,
          attempts,
          retryInSeconds: delay,
          error: message,
        });
      }
    }
  }
}