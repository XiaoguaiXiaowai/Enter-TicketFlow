import { beforeAll, describe, expect, it, vi } from 'vitest';

import { MetricsService } from '../../src/observability/metrics.service';
import { RateLimitService } from '../../src/ratelimit/rate-limit.service';
import type { RedisService } from '../../src/redis/redis.service';

// 限流服务在锁定判定时读取 env，这里补齐必需键，保证单测不依赖仓库根目录的 .env。
const REQUIRED_ENV: Record<string, string> = {
  NODE_ENV: 'test',
  API_PORT: '3000',
  LOG_LEVEL: 'error',
  POSTGRES_DB: 'ticket',
  POSTGRES_SUPERUSER: 'postgres',
  POSTGRES_SUPERUSER_PASSWORD: 'postgres',
  DATABASE_URL: 'postgresql://app_rw:pw@localhost:5432/ticket',
  MIGRATE_DATABASE_URL: 'postgresql://app_migrator:pw@localhost:5432/ticket',
  WORKER_DATABASE_URL: 'postgresql://app_worker:pw@localhost:5432/ticket',
  REDIS_URL: 'redis://localhost:6379',
  JWT_SECRET: 'unit_test_secret_0123456789abcdef0123456789',
  SEED_DEFAULT_PASSWORD: 'unit_test_password',
  RATE_LIMIT_LOGIN_MAX_ATTEMPTS: '5',
  RATE_LIMIT_LOGIN_LOCK_SECONDS: '600',
};

beforeAll(() => {
  for (const [key, value] of Object.entries(REQUIRED_ENV)) {
    process.env[key] = value;
  }
});

interface FakeClient {
  incr(key: string): Promise<number>;
  get(key: string): Promise<string | null>;
  expire(key: string, seconds: number): Promise<number>;
  ttl(key: string): Promise<number>;
  del(...keys: string[]): Promise<number>;
}

function createFakeRedis(): { redis: RedisService; client: FakeClient } {
  const store = new Map<string, { value: number; ttl: number }>();
  const client: FakeClient = {
    async incr(key) {
      const entry = store.get(key) ?? { value: 0, ttl: 0 };
      entry.value += 1;
      store.set(key, entry);
      return entry.value;
    },
    async get(key) {
      const entry = store.get(key);
      return entry === undefined ? null : String(entry.value);
    },
    async expire(key, seconds) {
      const entry = store.get(key);
      if (entry !== undefined) {
        entry.ttl = seconds;
      }
      return 1;
    },
    async ttl(key) {
      return store.get(key)?.ttl ?? -2;
    },
    async del(...keys) {
      let removed = 0;
      for (const key of keys) {
        if (store.delete(key)) {
          removed += 1;
        }
      }
      return removed;
    },
  };

  const redis = {
    execute: <T>(fn: (redisClient: FakeClient) => Promise<T>): Promise<T | null> => fn(client),
  } as unknown as RedisService;

  return { redis, client };
}

function createUnavailableRedis(): { redis: RedisService; execute: ReturnType<typeof vi.fn> } {
  const execute = vi.fn(async () => null);
  return { redis: { execute } as unknown as RedisService, execute };
}

describe('固定窗口限流', () => {
  it('Redis 可用时按窗口计数并返回剩余额度', async () => {
    const { redis } = createFakeRedis();
    const metrics = new MetricsService();
    const service = new RateLimitService(redis, metrics);

    const first = await service.consume('rl:read:tenant:user', 2, 60);
    const second = await service.consume('rl:read:tenant:user', 2, 60);
    const third = await service.consume('rl:read:tenant:user', 2, 60);

    expect([first.allowed, second.allowed, third.allowed]).toEqual([true, true, false]);
    expect(third.remaining).toBe(0);
    expect(third.degraded).toBe(false);
    expect(third.retryAfterSeconds).toBe(60);
    service.onModuleDestroy();
  });

  it('Redis 不可用时回落进程内计数且标记降级', async () => {
    const { redis, execute } = createUnavailableRedis();
    const metrics = new MetricsService();
    const service = new RateLimitService(redis, metrics);

    const decisions = [];
    for (let index = 0; index < 4; index += 1) {
      decisions.push(await service.consume('rl:write:tenant:user', 3, 60));
    }

    expect(decisions.slice(0, 3).every((decision) => decision.allowed)).toBe(true);
    expect(decisions[3]?.allowed).toBe(false);
    expect(decisions[3]?.degraded).toBe(true);
    expect(execute).toHaveBeenCalledTimes(4);
    expect(metrics.counterValue('rate_limit_fallback_total')).toBe(4);
    service.onModuleDestroy();
  });
});

describe('登录失败锁定', () => {
  it('达到阈值后锁定账号，成功登录可清除计数', async () => {
    const { redis } = createFakeRedis();
    const service = new RateLimitService(redis, new MetricsService());

    for (let index = 0; index < 5; index += 1) {
      await service.recordLoginFailure('agent-a@example.com');
    }

    expect(await service.loginLockRemainingSeconds('AGENT-A@example.com ')).toBeGreaterThan(0);
    expect(await service.loginLockRemainingSeconds('agent-b@example.com')).toBe(0);

    await service.clearLoginFailures('agent-a@example.com');
    expect(await service.loginLockRemainingSeconds('agent-a@example.com')).toBe(0);
    service.onModuleDestroy();
  });

  it('Redis 不可用时同样在进程内锁定账号', async () => {
    const { redis } = createUnavailableRedis();
    const service = new RateLimitService(redis, new MetricsService());

    for (let index = 0; index < 5; index += 1) {
      await service.recordLoginFailure('lock-me@example.com');
    }

    expect(await service.loginLockRemainingSeconds('lock-me@example.com')).toBeGreaterThan(0);
    await service.clearLoginFailures('lock-me@example.com');
    expect(await service.loginLockRemainingSeconds('lock-me@example.com')).toBe(0);
    service.onModuleDestroy();
  });
});