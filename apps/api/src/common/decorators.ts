import { SetMetadata } from '@nestjs/common';

export const PUBLIC_ROUTE_KEY = 'auth:public';
export const PERMISSION_KEY = 'auth:permission';
export const PROJECT_REQUIRED_KEY = 'auth:project-required';

export interface PermissionRequirement {
  resource: string;
  action: string;
}

/** 标记公开路由：跳过认证与权限求值。 */
export const Public = (): MethodDecorator & ClassDecorator => SetMetadata(PUBLIC_ROUTE_KEY, true);

/** 声明接口所需权限，由 PolicyGuard 求值；默认拒绝。 */
export const RequirePermission = (
  resource: string,
  action: string,
): MethodDecorator & ClassDecorator => SetMetadata(PERMISSION_KEY, { resource, action });

/** 标记依赖项目上下文的接口：缺少 X-Project-Id 时返回 400。 */
export const RequireProject = (): MethodDecorator & ClassDecorator =>
  SetMetadata(PROJECT_REQUIRED_KEY, true);
