import { Module } from '@nestjs/common';
import { APP_FILTER, APP_GUARD } from '@nestjs/core';

import { AuthGuard } from './auth/auth.guard';
import { AuthModule } from './auth/auth.module';
import { PolicyGuard } from './auth/policy.guard';
import { ProjectGuard } from './auth/project.guard';
import { AllExceptionsFilter } from './common/all-exceptions.filter';
import { HealthModule } from './health/health.module';
import { IamModule } from './iam/iam.module';
import { KnowledgeModule } from './knowledge/knowledge.module';
import { MeModule } from './me/me.module';
import { ObservabilityModule } from './observability/observability.module';
import { PrismaModule } from './prisma/prisma.module';
import { RateLimitGuard } from './ratelimit/rate-limit.guard';
import { RateLimitModule } from './ratelimit/rate-limit.module';
import { RedisModule } from './redis/redis.module';
import { TicketsModule } from './tickets/tickets.module';

@Module({
  imports: [
    ObservabilityModule,
    RedisModule,
    RateLimitModule,
    PrismaModule,
    IamModule,
    AuthModule,
    MeModule,
    TicketsModule,
    KnowledgeModule,
    HealthModule,
  ],
  providers: [
    { provide: APP_FILTER, useClass: AllExceptionsFilter },
    // 顺序即执行顺序：认证 → 租户/项目上下文 → 权限求值 → 限流
    { provide: APP_GUARD, useClass: AuthGuard },
    { provide: APP_GUARD, useClass: ProjectGuard },
    { provide: APP_GUARD, useClass: PolicyGuard },
    { provide: APP_GUARD, useClass: RateLimitGuard },
  ],
})
export class AppModule {}
