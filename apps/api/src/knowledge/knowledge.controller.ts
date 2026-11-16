import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  Patch,
  Post,
  Query,
  Req,
} from '@nestjs/common';
import {
  ApiBadRequestResponse,
  ApiBearerAuth,
  ApiConflictResponse,
  ApiCreatedResponse,
  ApiForbiddenResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
  ApiUnprocessableEntityResponse,
} from '@nestjs/swagger';

import {
  RESOURCE,
  type KbArticleListResponse,
  type KbArticleResponse,
  type PublishKbArticleResponse,
  type RenderReplyTemplateResponse,
  type ReplyTemplateListResponse,
} from '@ticket/shared';
import type { AuthenticatedRequest } from '../auth/auth.types';
import { RequirePermission, RequireProject } from '../common/decorators';
import { AppException } from '../common/errors';
import { getRequestContext } from '../common/request-context';
import {
  CreateKbArticleDto,
  ListKbArticlesQueryDto,
  PublishKbArticleDto,
  RenderReplyTemplateDto,
  UpdateKbArticleDto,
} from './knowledge.dto';
import { KnowledgeService, type KnowledgeContext } from './knowledge.service';

@ApiTags('知识库')
@ApiBearerAuth()
@Controller('v1/kb/articles')
export class KnowledgeController {
  constructor(private readonly knowledge: KnowledgeService) {}

  @Get()
  @RequireProject()
  @RequirePermission(RESOURCE.KB, 'read')
  @ApiOperation({ summary: '检索已发布文章（游标分页，返回高亮片段）' })
  @ApiOkResponse({ description: '命中标题或正文的已发布文章' })
  @ApiForbiddenResponse({ description: '缺少 kb:read 或项目访问权' })
  async list(
    @Query() query: ListKbArticlesQueryDto,
    @Req() req: AuthenticatedRequest,
  ): Promise<KbArticleListResponse> {
    return this.knowledge.list(contextOf(req), query);
  }

  @Post()
  @RequireProject()
  @RequirePermission(RESOURCE.KB, 'write')
  @HttpCode(201)
  @ApiOperation({ summary: '新建知识库草稿（v1，未发布前不可检索）' })
  @ApiCreatedResponse({ description: '草稿创建成功' })
  @ApiConflictResponse({ description: '项目内 slug 重复' })
  async create(
    @Body() dto: CreateKbArticleDto,
    @Req() req: AuthenticatedRequest,
  ): Promise<KbArticleResponse> {
    return this.knowledge.create(contextOf(req), dto);
  }

  @Get(':id')
  @RequireProject()
  @RequirePermission(RESOURCE.KB, 'read')
  @ApiOperation({ summary: '文章详情与历史版本' })
  @ApiOkResponse({ description: '按版本号倒序返回全部版本' })
  @ApiNotFoundResponse({ description: '文章不存在或不属于当前项目' })
  async detail(
    @Param('id') id: string,
    @Req() req: AuthenticatedRequest,
  ): Promise<KbArticleResponse> {
    return this.knowledge.detail(contextOf(req), id);
  }

  @Patch(':id')
  @RequireProject()
  @RequirePermission(RESOURCE.KB, 'write')
  @ApiOperation({ summary: '编辑产生新草稿版本，已发布版本保持不变' })
  @ApiOkResponse({ description: '返回包含新草稿版本的文章详情' })
  @ApiConflictResponse({ description: '文章已归档' })
  async update(
    @Param('id') id: string,
    @Body() dto: UpdateKbArticleDto,
    @Req() req: AuthenticatedRequest,
  ): Promise<KbArticleResponse> {
    return this.knowledge.update(contextOf(req), id, dto);
  }

  @Post(':id/publish')
  @RequireProject()
  @RequirePermission(RESOURCE.KB, 'publish')
  @HttpCode(200)
  @ApiOperation({ summary: '发布最新版本（重复发布同一版本幂等）' })
  @ApiOkResponse({ description: '发布成功或幂等重放' })
  @ApiConflictResponse({ description: '目标不是最新版本或文章已归档' })
  @ApiUnprocessableEntityResponse({ description: '正文为空' })
  async publish(
    @Param('id') id: string,
    @Body() dto: PublishKbArticleDto,
    @Req() req: AuthenticatedRequest,
  ): Promise<PublishKbArticleResponse> {
    return this.knowledge.publish(contextOf(req), id, dto);
  }

  @Delete(':id')
  @RequireProject()
  @RequirePermission(RESOURCE.KB, 'write')
  @ApiOperation({ summary: '归档文章（保留已发布版本，不物理删除）' })
  @ApiOkResponse({ description: '归档成功' })
  async archive(
    @Param('id') id: string,
    @Req() req: AuthenticatedRequest,
  ): Promise<{ id: string; archivedAt: string }> {
    return this.knowledge.archive(contextOf(req), id);
  }
}

@ApiTags('知识库')
@ApiBearerAuth()
@Controller('v1/reply-templates')
export class ReplyTemplatesController {
  constructor(private readonly knowledge: KnowledgeService) {}

  @Get()
  @RequireProject()
  @RequirePermission(RESOURCE.TEMPLATE, 'use')
  @ApiOperation({ summary: '当前项目的回复模板列表' })
  @ApiOkResponse({ description: '按更新时间倒序返回模板与变量声明' })
  async list(@Req() req: AuthenticatedRequest): Promise<ReplyTemplateListResponse> {
    return this.knowledge.listTemplates(contextOf(req));
  }

  @Post(':id/render')
  @RequireProject()
  @RequirePermission(RESOURCE.TEMPLATE, 'use')
  @HttpCode(200)
  @ApiOperation({ summary: '渲染回复模板（无副作用，变量值 HTML 转义）' })
  @ApiOkResponse({ description: '渲染后的正文' })
  @ApiBadRequestResponse({ description: '变量未声明、缺失或类型不合法' })
  @ApiNotFoundResponse({ description: '模板不存在或不属于当前项目' })
  async render(
    @Param('id') id: string,
    @Body() dto: RenderReplyTemplateDto,
    @Req() req: AuthenticatedRequest,
  ): Promise<RenderReplyTemplateResponse> {
    return this.knowledge.renderTemplate(contextOf(req), id, dto.variables);
  }
}

function contextOf(req: AuthenticatedRequest): KnowledgeContext {
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
      ip: req.ip === undefined || req.ip === '' ? null : req.ip,
    },
  };
}
