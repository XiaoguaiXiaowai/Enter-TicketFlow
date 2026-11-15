import { Injectable, type OnModuleDestroy } from '@nestjs/common';
import Redis from 'ioredis';

import { writeLog } from '../common/logger';
import { getEnv } from '../config/runtime';
import { MetricsService } from '../observability/metrics.service';

type RedisState = 'connected' | 'degraded';

/**
 * Redis 访问层：命令失败不向上抛错，统一返回 null 由调用方走降级路径。
 * 降级与恢复只在状态切换时记录日志与指标，避免故障期间刷屏。
 */
@Injectable()
export class RedisService implements OnModuleDestroy {
  private client: Redis | null = null;
  private connecting: Promise<unknown> | null = null;
  private state: RedisState = 'connected';

  constructor(private readonly metrics: MetricsService) {}

  get componentState(): RedisState {
    return this.state;
  }

  async execute<T>(operation: (client: Redis) => Promise<T>): Promise<T | null> {
    const client = this.getClient();
    try {
      if (client.status === 'wait') {
        this.connecting ??= client.connect().finally(() => {
          this.connecting = null;
        });
        await this.connecting;
      }
      const result = await operation(client);
      this.markConnected();
      return result;
    } catch (error) {
      this.markDegraded(error);
      return null;
    }
  }

  async onModuleDestroy(): Promise<void> {
    if (this.client !== null) {
      await this.client.quit().catch(() => undefined);
      this.client = null;
    }
  }

  private getClient(): Redis {
    if (this.client === null) {
      const env = getEnv();
      const client = new Redis(env.REDIS_URL, {
        lazyConnect: true,
        enableOfflineQueue: false,
        maxRetriesPerRequest: 1,
        connectTimeout: env.REDIS_COMMAND_TIMEOUT_MS,
        commandTimeout: env.REDIS_COMMAND_TIMEOUT_MS,
        retryStrategy: (times) => Math.min(times * 500, 5000),
      });
      client.on('error', (error: unknown) => this.markDegraded(error));
      client.on('ready', () => this.markConnected());
      this.client = client;
    }
    return this.client;
  }

  private markConnected(): void {
    this.metrics.setGauge('redis_state', {}, 1);
    if (this.state === 'degraded') {
      this.state = 'connected';
      writeLog('info', 'redis recovered', {});
    }
  }

  private markDegraded(error: unknown): void {
    this.metrics.setGauge('redis_state', {}, 0);
    if (this.state === 'degraded') {
      return;
    }
    this.state = 'degraded';
    this.metrics.incCounter('redis_degraded_total');
    writeLog('warn', 'redis degraded, falling back to in-process strategy', {
      error: error instanceof Error ? error.message : String(error),
    });
  }
}