import {
  Body,
  Controller,
  Get,
  Headers,
  HttpCode,
  Param,
  Patch,
  Post,
  Query,
  Req,
  Res,
} from '@nestjs/common';
import {
  ApiBadRequestResponse,
  ApiBearerAuth,
  ApiConflictResponse,
  ApiCreatedResponse,
  ApiForbiddenResponse,
  ApiHeader,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiPreconditionFailedResponse,
  ApiTags,
} from '@nestjs/swagger';
import type { Response } from 'express';

import {
  RESOURCE,
  type AppendMessageResponse,
  type TicketAuditResponse,
  type TicketDetailResponse,
  type TicketListResponse,
  type TicketResponse,
} from '@ticket/shared';
import type { AuthenticatedRequest } from '../auth/auth.types';
import { RequirePermission, RequireProject } from '../common/decorators';
import { AppException } from '../common/errors';
import { getRequestContext } from '../common/request-context';
import {
  AppendMessageDto,
  CreateTicketDto,
  ListTicketsQueryDto,
  UpdateTicketDto,
} from './ticket.dto';
import { TicketsService, type TicketContext } from './tickets.service';

@ApiTags('工单')
@ApiBearerAuth()
@Controller('v1/tickets')
export class TicketsController {
  constructor(private readonly tickets: TicketsService) {}

  @Get()
  @RequireProject()
  @RequirePermission(RESOURCE.TICKET, 'list')
  @ApiOperation({ summary: '工单列表（游标分页，按 updatedAt 倒序）' })
  @ApiOkResponse({ description: '按字段策略投影后的工单列表' })
  @ApiForbiddenResponse({ description: '缺少 ticket:list 或项目访问权' })
  async list(
    @Query() query: ListTicketsQueryDto,
    @Req() req: AuthenticatedRequest,
  ): Promise<TicketListResponse> {
    return this.tickets.list(contextOf(req), query);
  }

  @Post()
  @RequireProject()
  @RequirePermission(RESOURCE.TICKET, 'create')
  @HttpCode(201)
  @ApiHeader({
    name: 'Idempotency-Key',
    required: true,
    description: '客户端生成，24 小时内同键同体返回首次结果',
  })
  @ApiOperation({ summary: '创建工单（同事务写入审计与 Outbox）' })
  @ApiCreatedResponse({ description: '创建成功' })
  @ApiOkResponse({ description: '幂等重放，响应与首次一致' })
  @ApiConflictResponse({ description: '幂等键被复用或并发请求仍在处理中' })
  async create(
    @Body() dto: CreateTicketDto,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Req() req: AuthenticatedRequest,
    @Res({ passthrough: true }) res: Response,
  ): Promise<TicketResponse> {
    const result = await this.tickets.create(
      contextOf(req),
      dto,
      requireIdempotencyKey(idempotencyKey),
    );
    res.status(result.statusCode);
    if (result.replay) {
      res.setHeader('Idempotent-Replay', 'true');
    }
    return result.body;
  }

  @Get(':id')
  @RequireProject()
  @RequirePermission(RESOURCE.TICKET, 'read')
  @ApiOperation({ summary: '工单详情（含最近 50 条当前角色可见的消息）' })
  @ApiOkResponse({ description: '按字段策略投影后的工单与消息' })
  @ApiNotFoundResponse({ description: '工单不存在（含跨租户）' })
  async detail(
    @Param('id') id: string,
    @Req() req: AuthenticatedRequest,
  ): Promise<TicketDetailResponse> {
    return this.tickets.detail(contextOf(req), id);
  }

  @Patch(':id')
  @RequireProject()
  @RequirePermission(RESOURCE.TICKET, 'update')
  @ApiHeader({
    name: 'If-Match',
    required: true,
    description: '工单版本号；与服务端不一致返回 409',
  })
  @ApiOperation({ summary: '更新工单（状态机 + 乐观锁 + 字段写权限）' })
  @ApiOkResponse({ description: '更新成功，返回新版本' })
  @ApiPreconditionFailedResponse({ description: '缺少 If-Match' })
  @ApiConflictResponse({ description: '版本冲突' })
  @ApiBadRequestResponse({ description: '非法状态迁移或未声明字段' })
  async update(
    @Param('id') id: string,
    @Body() dto: UpdateTicketDto,
    @Headers('if-match') ifMatch: string | undefined,
    @Req() req: AuthenticatedRequest,
  ): Promise<TicketResponse> {
    return this.tickets.update(contextOf(req), id, ifMatch, dto);
  }

  @Post(':id/messages')
  @RequireProject()
  @RequirePermission(RESOURCE.TICKET, 'reply')
  @HttpCode(201)
  @ApiHeader({ name: 'Idempotency-Key', required: true })
  @ApiOperation({ summary: '追加消息（公开回复或内部备注）' })
  @ApiCreatedResponse({ description: '消息已追加，seq 从 1 连续递增' })
  @ApiConflictResponse({ description: '工单已关闭或幂等键复用' })
  @ApiForbiddenResponse({ description: '内部备注需要 ticket:note' })
  async appendMessage(
    @Param('id') id: string,
    @Body() dto: AppendMessageDto,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Req() req: AuthenticatedRequest,
    @Res({ passthrough: true }) res: Response,
  ): Promise<AppendMessageResponse> {
    const result = await this.tickets.appendMessage(
      contextOf(req),
      id,
      requireIdempotencyKey(idempotencyKey),
      dto,
    );
    res.status(result.statusCode);
    if (result.replay) {
      res.setHeader('Idempotent-Replay', 'true');
    }
    return result.body;
  }

  @Get(':id/audit')
  @RequireProject()
  @RequirePermission(RESOURCE.AUDIT, 'read')
  @ApiOperation({ summary: '审计记录（普通客服仅限自己经手的工单）' })
  @ApiOkResponse({ description: '按时间正序返回创建与变更记录' })
  @ApiForbiddenResponse({ description: '无权查看该工单审计' })
  async audit(
    @Param('id') id: string,
    @Req() req: AuthenticatedRequest,
  ): Promise<TicketAuditResponse> {
    return this.tickets.auditTrail(contextOf(req), id);
  }
}

function contextOf(req: AuthenticatedRequest): TicketContext {
  const actor = req.actor;
  if (actor === undefined) {
    throw AppException.unauthorized();
  }
  if (req.projectId === undefined) {
    throw AppException.validation('缺少 X-Project-Id');
  }
  return {
    actor,
    projectId: req.projectId,
    meta: {
      requestId: getRequestContext()?.requestId ?? '-',
      ip: normalizeIp(req.ip),
    },
  };
}

function normalizeIp(ip: string | undefined): string | null {
  if (ip === undefined || ip === '') {
    return null;
  }
  return ip;
}

function requireIdempotencyKey(key: string | undefined): string {
  if (key === undefined || key.trim() === '') {
    throw new AppException(400, 'IDEMPOTENCY_KEY_REQUIRED', '缺少 Idempotency-Key 请求头');
  }
  return key.trim();
}
