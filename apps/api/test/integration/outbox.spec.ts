import { randomUUID } from 'node:crypto';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { getEnv } from '../../src/config/runtime';
import { MetricsService } from '../../src/observability/metrics.service';
import type { OutboxDeliveryService } from '../../src/outbox/outbox-delivery.service';
import { OutboxWorkerService } from '../../src/outbox/outbox-worker.service';
import { PrismaService } from '../../src/prisma/prisma.service';
import { WorkerPrismaService } from '../../src/prisma/worker-prisma.service';

/**
 * 使用独立测试租户：开发库里可能积压其他租户的历史事件，
 * 认领顺序按 available_at，共用租户会让断言依赖队列深度。
 */
const TEST_TENANT = randomUUID();
const TEST_TENANT_CODE = `outbox-test-${TEST_TENANT.slice(0, 8)}`;

interface DeliveredEvent {
  id: string;
  type: string;
  attempts: number;
}

function createDelivery(
  handler: (event: DeliveredEvent) => void = () => undefined,
): { delivery: OutboxDeliveryService; delivered: DeliveredEvent[] } {
  const delivered: DeliveredEvent[] = [];
  const delivery = {
    deliver: async (event: DeliveredEvent) => {
      delivered.push({ id: event.id, type: event.type, attempts: event.attempts });
      handler(event);
    },
  } as unknown as OutboxDeliveryService;
  return { delivery, delivered };
}

describe('I4 Outbox 投递链路', () => {
  let prisma: PrismaService;
  let workerPrisma: WorkerPrismaService;
  let worker: OutboxWorkerService;
  let metrics: MetricsService;
  const createdEventIds: string[] = [];
  const createdKeyIds: string[] = [];

  async function createEvent(
    overrides: { attempts?: number; status?: 'PENDING' | 'DELIVERED' | 'DEAD' } = {},
  ): Promise<string> {
    const id = randomUUID();
    createdEventIds.push(id);
    await prisma.withTenant(TEST_TENANT, (tx) =>
      tx.outboxEvent.create({
        data: {
          id,
          tenantId: TEST_TENANT,
          type: 'ticket.created',
          payload: { ticketId: randomUUID() },
          attempts: overrides.attempts ?? 0,
          status: overrides.status ?? 'PENDING',
        },
      }),
    );
    return id;
  }

  beforeAll(async () => {
    metrics = new MetricsService();
    prisma = new PrismaService(metrics);
    workerPrisma = new WorkerPrismaService();
    await prisma.tenant.create({
      data: { id: TEST_TENANT, code: TEST_TENANT_CODE, name: TEST_TENANT_CODE, status: 'ACTIVE' },
    });
  });

  afterAll(async () => {
    if (createdEventIds.length > 0) {
      await prisma.withTenant(TEST_TENANT, (tx) =>
        tx.outboxEvent.deleteMany({ where: { id: { in: createdEventIds } } }),
      );
    }
    if (createdKeyIds.length > 0) {
      await prisma.withTenant(TEST_TENANT, (tx) =>
        tx.idempotencyKey.deleteMany({ where: { id: { in: createdKeyIds } } }),
      );
    }
    await prisma.tenant.delete({ where: { id: TEST_TENANT } });
    await prisma.$disconnect();
    await workerPrisma.$disconnect();
  });

  it('投递成功后标记 DELIVERED 并清空错误', async () => {
    const eventId = await createEvent();
    const { delivery, delivered } = createDelivery();
    worker = new OutboxWorkerService(workerPrisma, delivery, metrics);

    await worker.dispatchOnce();

    const row = await prisma.withTenant(TEST_TENANT, (tx) =>
      tx.outboxEvent.findUniqueOrThrow({ where: { id: eventId } }),
    );
    expect(row.status).toBe('DELIVERED');
    expect(row.lastError).toBeNull();
    expect(delivered.filter((event) => event.id === eventId)).toHaveLength(1);
    expect(metrics.counterValue('outbox_delivered_total', { type: 'ticket.created' })).toBeGreaterThan(0);
  });

  it('投递失败时按指数退避重试，不阻塞后续事件', async () => {
    const eventId = await createEvent();
    const { delivery } = createDelivery(() => {
      throw new Error('downstream 502');
    });
    worker = new OutboxWorkerService(workerPrisma, delivery, metrics);

    const before = Date.now();
    await worker.dispatchOnce();

    const row = await prisma.withTenant(TEST_TENANT, (tx) =>
      tx.outboxEvent.findUniqueOrThrow({ where: { id: eventId } }),
    );
    expect(row.status).toBe('PENDING');
    expect(row.attempts).toBe(1);
    expect(row.lastError).toContain('downstream 502');
    // 首次失败退避 5 秒（outboxBackoffSeconds(1) = 10s，允许时钟抖动）
    expect(row.availableAt.getTime()).toBeGreaterThan(before + 1_000);
    expect(metrics.counterValue('outbox_retry_total', { type: 'ticket.created' })).toBeGreaterThan(0);
  });

  it('达到最大尝试次数后进入 DEAD 死信', async () => {
    const maxAttempts = getEnv().OUTBOX_MAX_ATTEMPTS;
    const eventId = await createEvent({ attempts: maxAttempts - 1 });
    const { delivery } = createDelivery(() => {
      throw new Error('downstream timeout');
    });
    worker = new OutboxWorkerService(workerPrisma, delivery, metrics);

    await worker.dispatchOnce();

    const row = await prisma.withTenant(TEST_TENANT, (tx) =>
      tx.outboxEvent.findUniqueOrThrow({ where: { id: eventId } }),
    );
    expect(row.status).toBe('DEAD');
    expect(row.attempts).toBe(maxAttempts);
    expect(metrics.counterValue('outbox_dead_total', { type: 'ticket.created' })).toBeGreaterThan(0);
  });

  it('两个 Worker 并发认领时同一事件只投递一次', async () => {
    const eventIds = await Promise.all([createEvent(), createEvent(), createEvent()]);
    const seen: string[] = [];
    const delivery = {
      deliver: async (event: DeliveredEvent) => {
        seen.push(event.id);
        await new Promise((resolve) => setTimeout(resolve, 20));
      },
    } as unknown as OutboxDeliveryService;

    const workerA = new OutboxWorkerService(workerPrisma, delivery, new MetricsService());
    const workerB = new OutboxWorkerService(workerPrisma, delivery, new MetricsService());
    await Promise.all([workerA.dispatchOnce(), workerB.dispatchOnce()]);

    for (const eventId of eventIds) {
      expect(seen.filter((id) => id === eventId)).toHaveLength(1);
    }
    expect(new Set(seen).size).toBe(seen.length);
  });

  it('清理过期的幂等键，保留未过期记录', async () => {
    const expiredId = randomUUID();
    const activeId = randomUUID();
    createdKeyIds.push(expiredId, activeId);
    await prisma.withTenant(TEST_TENANT, async (tx) => {
      await tx.idempotencyKey.createMany({
        data: [
          {
            id: expiredId,
            tenantId: TEST_TENANT,
            key: `expired-${expiredId}`,
            endpoint: 'POST /v1/tickets',
            requestHash: 'hash-expired',
            expiresAt: new Date(Date.now() - 60_000),
          },
          {
            id: activeId,
            tenantId: TEST_TENANT,
            key: `active-${activeId}`,
            endpoint: 'POST /v1/tickets',
            requestHash: 'hash-active',
            expiresAt: new Date(Date.now() + 3_600_000),
          },
        ],
      });
    });

    worker = new OutboxWorkerService(workerPrisma, createDelivery().delivery, metrics);
    await worker.cleanupExpiredIdempotencyKeys();

    const remaining = await prisma.withTenant(TEST_TENANT, (tx) =>
      tx.idempotencyKey.findMany({ where: { id: { in: [expiredId, activeId] } } }),
    );
    expect(remaining.map((row) => row.id)).toEqual([activeId]);
  });
});