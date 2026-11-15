import { type CanActivate, type ExecutionContext, HttpStatus, Injectable } from '@nestjs/common';
import type { Request, Response } from 'express';

import type { AuthenticatedRequest } from '../auth/auth.types';
import { AppException } from '../common/errors';
import { getEnv } from '../config/runtime';
import { MetricsService } from '../observability/metrics.service';
import { RateLimitService } from './rate-limit.service';

const LOGIN_PATH_SUFFIX = '/v1/auth/login';

/**
 * 全局限流：登录按账号锁定，其余接口按租户+用户（匿名按 IP）读写分桶。
 * 作为最后一个守卫执行，因此已认证请求可以拿到 actor。
 */
@Injectable()
export class RateLimitGuard implements CanActivate {
  constructor(
    private readonly rateLimit: RateLimitService,
    private readonly metrics: MetricsService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const env = getEnv();
    if (!env.RATE_LIMIT_ENABLED) {
      return true;
    }

    const request = context.switchToHttp().getRequest<AuthenticatedRequest>();
    const response = context.switchToHttp().getResponse<Response>();

    if (this.isLogin(request)) {
      return this.checkLogin(request, response);
    }

    const isRead = ['GET', 'HEAD', 'OPTIONS'].includes(request.method);
    const limit = isRead ? env.RATE_LIMIT_READ_PER_MINUTE : env.RATE_LIMIT_WRITE_PER_MINUTE;
    const scope = isRead ? 'read' : 'write';
    const decision = await this.rateLimit.consume(
      `rl:${scope}:${this.actorKey(request)}`,
      limit,
      60,
    );

    response.setHeader('x-ratelimit-limit', String(decision.limit));
    response.setHeader('x-ratelimit-remaining', String(decision.remaining));
    if (decision.degraded) {
      response.setHeader('x-ratelimit-degraded', 'in-process');
    }

    if (!decision.allowed) {
      this.metrics.incCounter('rate_limit_rejected_total', { scope });
      response.setHeader('retry-after', String(decision.retryAfterSeconds));
      throw new AppException(
        HttpStatus.TOO_MANY_REQUESTS,
        'RATE_LIMITED',
        '请求过于频繁，请稍后再试',
        { retryAfterSeconds: decision.retryAfterSeconds },
      );
    }
    return true;
  }

  private async checkLogin(
    request: AuthenticatedRequest,
    response: Response,
  ): Promise<boolean> {
    const email = this.readEmail(request);
    const lockedSeconds = await this.rateLimit.loginLockRemainingSeconds(email);
    if (lockedSeconds > 0) {
      this.metrics.incCounter('rate_limit_rejected_total', { scope: 'login' });
      response.setHeader('retry-after', String(lockedSeconds));
      throw new AppException(
        HttpStatus.TOO_MANY_REQUESTS,
        'AUTH_LOGIN_LOCKED',
        '登录失败次数过多，请稍后再试',
        { retryAfterSeconds: lockedSeconds },
      );
    }
    return true;
  }

  private isLogin(request: Request): boolean {
    const path = request.originalUrl.split('?')[0] ?? '';
    return request.method === 'POST' && path.endsWith(LOGIN_PATH_SUFFIX);
  }

  private readEmail(request: AuthenticatedRequest): string {
    const body: unknown = request.body;
    if (typeof body === 'object' && body !== null && 'email' in body) {
      const email = (body as { email?: unknown }).email;
      if (typeof email === 'string') {
        return email;
      }
    }
    return 'unknown';
  }

  private actorKey(request: AuthenticatedRequest): string {
    if (request.actor !== undefined) {
      return `${request.actor.tenantId}:${request.actor.userId}`;
    }
    return `ip:${request.ip ?? 'unknown'}`;
  }
}