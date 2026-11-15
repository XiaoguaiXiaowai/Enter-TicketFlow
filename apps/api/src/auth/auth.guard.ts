import { type CanActivate, type ExecutionContext, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';

import { IamService } from '../iam/iam.service';
import { TokenService } from '../auth/token.service';
import { PUBLIC_ROUTE_KEY } from '../common/decorators';
import { AppException } from '../common/errors';
import type { AuthenticatedRequest } from '../auth/auth.types';

/**
 * 认证：校验 JWT 签名、过期时间、会话版本号，并加载成员关系。
 * 任何校验失败都返回 401，不区分原因，避免泄露会话状态。
 */
@Injectable()
export class AuthGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly tokens: TokenService,
    private readonly iam: IamService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const isPublic = this.reflector.getAllAndOverride<boolean>(PUBLIC_ROUTE_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (isPublic === true) {
      return true;
    }

    const request = context.switchToHttp().getRequest<AuthenticatedRequest>();
    const header = request.headers.authorization;
    if (typeof header !== 'string' || !header.startsWith('Bearer ')) {
      throw AppException.unauthorized();
    }

    const claims = this.tokens.verifyAccessToken(header.slice('Bearer '.length).trim());
    if (claims === null) {
      throw AppException.unauthorized('TOKEN_INVALID', '访问令牌无效或已过期');
    }

    const actor = await this.iam.loadActor(claims);
    if (actor === null) {
      throw AppException.unauthorized('SESSION_INVALID', '会话已撤销或已过期');
    }

    request.actor = actor;
    return true;
  }
}
