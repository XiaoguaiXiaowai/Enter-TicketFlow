import { Module } from '@nestjs/common';
import { APP_FILTER, APP_GUARD, APP_INTERCEPTOR } from '@nestjs/core';

import { AuthGuard } from './auth/auth.guard';
import { AuthModule } from './auth/auth.module';
import { PolicyGuard } from './auth/policy.guard';
import { ProjectGuard } from './auth/project.guard';
import { AccessLogInterceptor } from './common/access-log.interceptor';
import { AllExceptionsFilter } from './common/all-exceptions.filter';
import { HealthModule } from './health/health.module';
import { IamModule } from './iam/iam.module';
import { MeModule } from './me/me.module';
import { PrismaModule } from './prisma/prisma.module';
import { TicketsModule } from './tickets/tickets.module';

@Module({
  imports: [PrismaModule, IamModule, AuthModule, MeModule, TicketsModule, HealthModule],
  providers: [
    { provide: APP_FILTER, useClass: AllExceptionsFilter },
    { provide: APP_INTERCEPTOR, useClass: AccessLogInterceptor },
    // 顺序即执行顺序：认证 → 租户/项目上下文 → 权限求值
    { provide: APP_GUARD, useClass: AuthGuard },
    { provide: APP_GUARD, useClass: ProjectGuard },
    { provide: APP_GUARD, useClass: PolicyGuard },
  ],
})
export class AppModule {}
