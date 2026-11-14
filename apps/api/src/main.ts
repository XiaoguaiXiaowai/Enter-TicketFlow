import 'reflect-metadata';

import { NestFactory } from '@nestjs/core';

import { API_PREFIX } from '@ticket/shared';
import { AppModule } from './app.module';
import { JsonLogger } from './common/json-logger';
import { writeLog } from './common/logger';
import { requestContextMiddleware } from './common/request-context';
import { getEnv } from './config/runtime';

async function bootstrap(): Promise<void> {
  const env = getEnv();

  const app = await NestFactory.create(AppModule, { logger: new JsonLogger() });
  app.use(requestContextMiddleware);
  app.setGlobalPrefix(API_PREFIX);
  app.enableShutdownHooks();
  await app.listen(env.API_PORT, '0.0.0.0');

  writeLog('info', 'api started', {
    port: env.API_PORT,
    nodeEnv: env.NODE_ENV,
    configKeys: ['DATABASE_URL', 'REDIS_URL'],
  });
}

bootstrap().catch((error: unknown) => {
  writeLog('fatal', 'api bootstrap failed', {
    error: error instanceof Error ? error.message : String(error),
    stack: error instanceof Error ? error.stack : undefined,
  });
  process.exit(1);
});
