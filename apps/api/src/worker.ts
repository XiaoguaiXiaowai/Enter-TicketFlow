import 'reflect-metadata';

import { Module } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';

import { JsonLogger } from './common/json-logger';
import { writeLog } from './common/logger';
import { getEnv } from './config/runtime';
import { PrismaModule } from './prisma/prisma.module';

/**
 * I0 的 worker 只是编排占位：保持常驻并响应退出信号。
 * Outbox 投递与清理任务在 I4 接入。
 */
@Module({
  imports: [PrismaModule],
})
class WorkerModule {}

async function bootstrap(): Promise<void> {
  const env = getEnv();
  const app = await NestFactory.createApplicationContext(WorkerModule, {
    logger: new JsonLogger(),
  });

  writeLog('info', 'worker started', { nodeEnv: env.NODE_ENV });

  setInterval(() => {
    writeLog('debug', 'worker heartbeat', { uptimeSeconds: Math.round(process.uptime()) });
  }, 60_000);

  const shutdown = (signal: string): void => {
    writeLog('info', 'worker stopping', { signal });
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
