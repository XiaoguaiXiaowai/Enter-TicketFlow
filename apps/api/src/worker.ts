import 'reflect-metadata';

import { Module } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';

import { JsonLogger } from './common/json-logger';
import { writeLog } from './common/logger';
import { getEnv } from './config/runtime';
import { ObservabilityModule } from './observability/observability.module';
import { OutboxWorkerModule } from './outbox/outbox-worker.module';

/**
 * Worker 负责 Outbox 投递与过期幂等键清理，使用独立的 app_worker 连接池。
 * 进程常驻，收到 SIGTERM/SIGINT 后停止认领并在途任务结束后退出。
 */
@Module({
  imports: [ObservabilityModule, OutboxWorkerModule],
})
class WorkerModule {}

async function bootstrap(): Promise<void> {
  const env = getEnv();
  const app = await NestFactory.createApplicationContext(WorkerModule, {
    logger: new JsonLogger(),
  });

  writeLog('info', 'worker started', { nodeEnv: env.NODE_ENV });

  const heartbeat = setInterval(() => {
    writeLog('debug', 'worker heartbeat', { uptimeSeconds: Math.round(process.uptime()) });
  }, 60_000);
  heartbeat.unref();

  const shutdown = (signal: string): void => {
    writeLog('info', 'worker stopping', { signal });
    clearInterval(heartbeat);
    void app.close().finally(() => process.exit(0));
  };

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

bootstrap().catch((error: unknown) => {
  writeLog('fatal', 'worker bootstrap failed', {
    error: error instanceof Error ? error.message : String(error),
    stack: error instanceof Error ? error.stack : undefined,
  });
  process.exit(1);
});