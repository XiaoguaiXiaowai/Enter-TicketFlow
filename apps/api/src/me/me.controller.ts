import { Controller, Get, Req } from '@nestjs/common';
import { ApiBearerAuth, ApiOkResponse, ApiOperation, ApiTags, ApiUnauthorizedResponse } from '@nestjs/swagger';

import type { MePermissionsResponse } from '@ticket/shared';
import type { AuthenticatedRequest } from '../auth/auth.types';
import { AppException } from '../common/errors';
import { IamService } from '../iam/iam.service';

@ApiTags('当前用户')
@Controller('v1/me')
export class MeController {
  constructor(private readonly iam: IamService) {}

  @Get('permissions')
  @ApiBearerAuth()
  @ApiOperation({ summary: '当前会话的权限摘要：角色、动作权限、字段策略与可访问项目' })
  @ApiOkResponse({ description: '权限摘要' })
  @ApiUnauthorizedResponse({ description: '未认证' })
  async permissions(@Req() req: AuthenticatedRequest): Promise<MePermissionsResponse> {
    const actor = req.actor;
    if (actor === undefined) {
      throw AppException.unauthorized();
    }

    const [tenant, projects, permissions, fields] = await Promise.all([
      this.iam.tenantSummary(actor),
      this.iam.projects(actor),
      this.iam.permissions(actor),
      this.iam.fieldSummaries(actor),
    ]);

    return {
      user: { id: actor.userId, email: actor.email },
      tenant,
      membership: { id: actor.membershipId, status: 'ACTIVE' },
      roles: actor.roles.map((role) => ({ code: role.code, name: role.name })),
      permissions,
      fields,
      projects,
    };
  }
}
