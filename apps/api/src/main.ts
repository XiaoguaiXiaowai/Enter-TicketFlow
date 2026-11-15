import 'reflect-metadata';

import { ValidationPipe } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import cookieParser from 'cookie-parser';

import { API_PREFIX } from '@ticket/shared';
import { AppModule } from './app.module';
import { accessLogMiddleware } from './common/access-log.middleware';
import { JsonLogger } from './common/json-logger';
import { writeLog } from './common/logger';
import { requestContextMiddleware } from './common/request-context';
import { securityHeadersMiddleware } from './common/security-headers';
import { validationPipeOptions } from './common/validation';
import { getEnv } from './config/runtime';
import { createHttpMetricsMiddleware } from './observability/http-metrics.middleware';
import { MetricsService } from './observability/metrics.service';

async function bootstrap(): Promise<void> {
  const env = getEnv();

  const app = await NestFactory.create(AppModule, { logger: new JsonLogger() });
  // 只信任 nginx 这一跳，避免客户端自带的 X-Forwarded-For 伪造来源 IP 绕过限流。
  app.getHttpAdapter().getInstance().set('trust proxy', 1);
  app.use(requestContextMiddleware);
  // 访问日志注册为中间件而不是拦截器：守卫拒绝（401/403/429）也要留下带 requestId 的记录。
  app.use(accessLogMiddleware);
  app.use(securityHeadersMiddleware);
  // 指标中间件先于路由注册，守卫拒绝也能被统计。
  app.use(createHttpMetricsMiddleware(app.get(MetricsService)));
  app.use(cookieParser());
  app.useGlobalPipes(new ValidationPipe(validationPipeOptions()));
  app.setGlobalPrefix(API_PREFIX);
  app.enableShutdownHooks();

  const openapi = new DocumentBuilder()
    .setTitle('企业客服工单平台 API')
    .setDescription('统一错误结构、认证、租户与权限接口')
    .setVersion('1.0')
    .addBearerAuth()
    .addCookieAuth('refresh_token')
    .build();
  const document = SwaggerModule.createDocument(app, openapi);
  SwaggerModule.setup('api/docs', app, document, { jsonDocumentUrl: 'api/docs-json' });

  await app.listen(env.API_PORT, '0.0.0.0');

  writeLog('info', 'api started', {
    port: env.API_PORT,
    nodeEnv: env.NODE_ENV,
    configKeys: ['DATABASE_URL', 'REDIS_URL', 'JWT_SECRET'],
  });
}

bootstrap().catch((error: unknown) => {
  writeLog('fatal', 'api bootstrap failed', {
    error: error instanceof Error ? error.message : String(error),
    stack: error instanceof Error ? error.stack : undefined,
  });
  process.exit(1);
});
