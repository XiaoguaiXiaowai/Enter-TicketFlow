import { type CanActivate, type ExecutionContext, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';

import { IamService } from '../iam/iam.service';
import { PROJECT_REQUIRED_KEY, PUBLIC_ROUTE_KEY } from '../common/decorators';
import { AppException } from '../common/errors';
import type { AuthenticatedRequest } from '../auth/auth.types';

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/**
 * 租户与项目上下文：租户来自服务端会话，不接受请求体或查询参数；
 * 请求头 X-Project-Id 只在声明 @RequireProject 的接口上强制要求。
 */
@Injectable()
export class ProjectGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
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
    const actor = request.actor;
    if (actor === undefined) {
      throw AppException.unauthorized();
    }

    const required =
      this.reflector.getAllAndOverride<boolean>(PROJECT_REQUIRED_KEY, [
        context.getHandler(),
        context.getClass(),
      ]) === true;

    const raw = request.headers['x-project-id'];
    const projectId = typeof raw === 'string' && raw.trim().length > 0 ? raw.trim() : undefined;

    if (projectId === undefined) {
      if (required) {
        throw new AppException(400, 'PROJECT_REQUIRED', '缺少 X-Project-Id 请求头');
      }
      return true;
    }

    if (!UUID_PATTERN.test(projectId)) {
      throw AppException.notFound('PROJECT_NOT_FOUND', '项目不存在');
    }

    await this.iam.assertProject(actor, projectId);
    request.projectId = projectId;
    return true;
  }
}
