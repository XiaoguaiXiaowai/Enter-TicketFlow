import {
  type CanActivate,
  type ExecutionContext,
  Injectable,
  ServiceUnavailableException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';

import { IamService } from '../iam/iam.service';
import { AppException } from '../common/errors';
import { PERMISSION_KEY, PUBLIC_ROUTE_KEY, type PermissionRequirement } from '../common/decorators';
import type { AuthenticatedRequest } from '../auth/auth.types';

/**
 * 权限求值：默认拒绝。未声明 @RequirePermission 的接口只要求已认证，
 * 所有写接口必须声明权限，缺少声明由 CI 脚本拦截。
 * 权限服务异常时拒绝请求，不存在“异常即放行”的分支。
 */
@Injectable()
export class PolicyGuard implements CanActivate {
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

    const requirement = this.reflector.getAllAndOverride<PermissionRequirement | undefined>(
      PERMISSION_KEY,
      [context.getHandler(), context.getClass()],
    );
    if (requirement === undefined) {
      return true;
    }

    const request = context.switchToHttp().getRequest<AuthenticatedRequest>();
    const actor = request.actor;
    if (actor === undefined) {
      throw AppException.unauthorized();
    }

    try {
      const allowed = await this.iam.can(actor, requirement.resource, requirement.action);
      if (!allowed) {
        throw AppException.forbidden(
          'FORBIDDEN',
          `缺少权限 ${requirement.resource}:${requirement.action}`,
          [{ permission: `${requirement.resource}:${requirement.action}` }],
        );
      }
      return true;
    } catch (error: unknown) {
      if (error instanceof AppException) {
        throw error;
      }
      throw new ServiceUnavailableException({
        code: 'POLICY_UNAVAILABLE',
        message: '权限服务不可用',
      });
    }
  }
}
