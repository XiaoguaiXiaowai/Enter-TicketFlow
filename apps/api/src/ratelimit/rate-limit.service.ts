import { Injectable, type OnModuleDestroy } from '@nestjs/common';

import { getEnv } from '../config/runtime';
import { MetricsService } from '../observability/metrics.service';
import { RedisService } from '../redis/redis.service';

export interface RateLimitDecision {
  allowed: boolean;
  limit: number;
  remaining: number;
  retryAfterSeconds: number;
  degraded: boolean;
}

interface MemoryCounter {
  count: number;
  resetAt: number;
}

/**
 * 固定窗口限流：Redis 计数失败时退化为进程内计数（多副本下不精确，但不会放行到底）。
 * 登录失败按账号维度累计：共享出口 IP 的整楼用户不会因他人失败被一起锁定。
 */
@Injectable()
export class RateLimitService implements OnModuleDestroy {
  private readonly memory = new Map<string, MemoryCounter>();
  private readonly cleanup = setInterval(() => this.pruneMemory(), 60_000);

  constructor(
    private readonly redis: RedisService,
    private readonly metrics: MetricsService,
  ) {
    this.cleanup.unref();
  }

  onModuleDestroy(): void {
    clearInterval(this.cleanup);
  }

  async consume(key: string, limit: number, windowSeconds: number): Promise<RateLimitDecision> {
    const redisResult = await this.redis.execute(async (client) => {
      const count = await client.incr(key);
      if (count === 1) {
        await client.expire(key, windowSeconds);
      }
      const ttl = await client.ttl(key);
      return { count, ttl: ttl > 0 ? ttl : windowSeconds };
    });

    if (redisResult !== null) {
      return this.decide(redisResult.count, redisResult.ttl, limit, false);
    }

    this.metrics.incCounter('rate_limit_fallback_total');
    const counter = this.consumeMemory(key, windowSeconds);
    return this.decide(counter.count, Math.ceil((counter.resetAt - Date.now()) / 1000), limit, true);
  }

  /** 登录前置检查：返回剩余锁定秒数，0 表示未锁定。 */
  async loginLockRemainingSeconds(email: string): Promise<number> {
    const { maxAttempts } = this.loginConfig();
    const key = this.loginKey(email);
    const redisResult = await this.redis.execute(async (client) => {
      const count = Number((await client.get(key)) ?? 0);
      const ttl = await client.ttl(key);
      return { count, ttl: ttl > 0 ? ttl : 0 };
    });

    let sample = redisResult;
    if (sample === null) {
      const entry = this.memory.get(key);
      sample =
        entry === undefined || entry.resetAt <= Date.now()
          ? { count: 0, ttl: 0 }
          : { count: entry.count, ttl: Math.ceil((entry.resetAt - Date.now()) / 1000) };
    }

    return sample.count >= maxAttempts && sample.ttl > 0 ? sample.ttl : 0;
  }

  async recordLoginFailure(email: string): Promise<void> {
    const { lockSeconds } = this.loginConfig();
    this.metrics.incCounter('auth_login_failures_total');
    const key = this.loginKey(email);
    const redisResult = await this.redis.execute(async (client) => {
      const count = await client.incr(key);
      if (count === 1) {
        await client.expire(key, lockSeconds);
      }
      return true;
    });
    if (redisResult === null) {
      this.consumeMemory(key, lockSeconds);
    }
  }

  async clearLoginFailures(email: string): Promise<void> {
    const key = this.loginKey(email);
    const redisResult = await this.redis.execute(async (client) => {
      await client.del(key);
      return true;
    });
    if (redisResult === null) {
      this.memory.delete(key);
    }
  }

  private loginConfig(): { maxAttempts: number; lockSeconds: number } {
    const env = getEnv();
    return {
      maxAttempts: env.RATE_LIMIT_LOGIN_MAX_ATTEMPTS,
      lockSeconds: env.RATE_LIMIT_LOGIN_LOCK_SECONDS,
    };
  }

  private loginKey(email: string): string {
    return `rl:login:account:${email.trim().toLowerCase()}`;
  }

  private decide(
    count: number,
    retryAfterSeconds: number,
    limit: number,
    degraded: boolean,
  ): RateLimitDecision {
    return {
      allowed: count <= limit,
      limit,
      remaining: Math.max(0, limit - count),
      retryAfterSeconds: Math.max(1, retryAfterSeconds),
      degraded,
    };
  }

  private consumeMemory(key: string, windowSeconds: number): MemoryCounter {
    const now = Date.now();
    const current = this.memory.get(key);
    if (current === undefined || current.resetAt <= now) {
      const fresh = { count: 1, resetAt: now + windowSeconds * 1000 };
      this.memory.set(key, fresh);
      return fresh;
    }
    current.count += 1;
    return current;
  }

  private pruneMemory(): void {
    const now = Date.now();
    for (const [key, entry] of this.memory) {
      if (entry.resetAt <= now) {
        this.memory.delete(key);
      }
    }
  }
}