import { HttpStatus, Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';

import {
  AUDIT_RESOURCE,
  type KbArticleListQuery,
  type KbArticleListResponse,
  type KbArticleResponse,
  type KbArticleVersionResponse,
  type PublishKbArticleResponse,
  type RenderReplyTemplateResponse,
  type ReplyTemplateListResponse,
} from '@ticket/shared';

import type { Actor } from '../auth/auth.types';
import { AuditService } from '../audit/audit.service';
import { AppException } from '../common/errors';
import { sanitizeRichText } from '../common/rich-text';
import { PrismaService } from '../prisma/prisma.service';
import type { CreateKbArticleDto, PublishKbArticleDto, UpdateKbArticleDto } from './knowledge.dto';

export interface RequestMeta {
  requestId: string;
  ip: string | null;
}

export interface KnowledgeContext {
  actor: Actor;
  projectId: string;
  meta: RequestMeta;
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const DEFAULT_LIMIT = 20;
const SNIPPET_RADIUS = 40;

interface KbSearchRow {
  id: string;
  slug: string;
  version: number;
  published_version_id: string;
  updated_at: Date;
  version_id: string;
  version_no: number;
  title: string;
  body: string;
}

interface LockedArticle {
  id: string;
  version: number;
  published_version_id: string | null;
  archived_at: Date | null;
}

@Injectable()
export class KnowledgeService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  /**
   * 检索只命中已发布版本：草稿、归档文章与未发布的文章都不会出现。
   * 关键词为空时按 article.updatedAt 倒序返回，便于客服浏览最近更新。
   */
  async list(ctx: KnowledgeContext, query: KbArticleListQuery): Promise<KbArticleListResponse> {
    const { actor, projectId } = ctx;
    const limit = Math.min(query.limit ?? DEFAULT_LIMIT, 50);
    const q = (query.q ?? '').trim();
    const cursor = query.cursor === undefined ? null : decodeCursor(query.cursor);
    const pattern = `%${escapeLike(q)}%`;

    const searchClause =
      q === ''
        ? Prisma.empty
        : Prisma.sql`AND (v.title ILIKE ${pattern} OR v.body ILIKE ${pattern})`;
    const cursorClause =
      cursor === null
        ? Prisma.empty
        : Prisma.sql`AND (a.updated_at < ${cursor.updatedAt}
                         OR (a.updated_at = ${cursor.updatedAt} AND a.id < ${cursor.id}::uuid))`;

    const rows = await this.prisma.withTenant(actor.tenantId, (tx) =>
      tx.$queryRaw<KbSearchRow[]>`
        SELECT a.id,
               a.slug,
               a.version,
               a.published_version_id,
               a.updated_at,
               v.id     AS version_id,
               v.version_no,
               v.title,
               v.body
          FROM kb_articles a
          JOIN kb_article_versions v ON v.id = a.published_version_id
         WHERE a.tenant_id = ${actor.tenantId}::uuid
           AND a.project_id = ${projectId}::uuid
           AND a.archived_at IS NULL
           ${searchClause}
           ${cursorClause}
         ORDER BY a.updated_at DESC, a.id DESC
         LIMIT ${limit + 1}
      `,
    );

    const hasMore = rows.length > limit;
    const page = hasMore ? rows.slice(0, limit) : rows;
    const last = page[page.length - 1];

    return {
      items: page.map((row) => ({
        id: row.id,
        slug: row.slug,
        title: row.title,
        status: 'PUBLISHED',
        version: row.version,
        versionNo: row.version_no,
        publishedVersionId: row.published_version_id,
        updatedAt: row.updated_at.toISOString(),
        snippet: buildSnippet(row.body, q),
      })),
      nextCursor: hasMore && last !== undefined ? encodeCursor(last) : null,
    };
  }

  async create(ctx: KnowledgeContext, dto: CreateKbArticleDto): Promise<KbArticleResponse> {
    const { actor, projectId, meta } = ctx;

    try {
      return await this.prisma.withTenant(actor.tenantId, async (tx) => {
        const existing = await tx.kbArticle.findFirst({
          where: { projectId, slug: dto.slug },
          select: { id: true },
        });
        if (existing !== null) {
          throw AppException.conflict('SLUG_TAKEN', '该项目下已存在相同 slug 的文章');
        }

        const article = await tx.kbArticle.create({
          data: { tenantId: actor.tenantId, projectId, slug: dto.slug },
        });
        const version = await tx.kbArticleVersion.create({
          data: {
            tenantId: actor.tenantId,
            articleId: article.id,
            versionNo: 1,
            title: dto.title,
            body: sanitizeRichText(dto.body),
            status: 'DRAFT',
            authorId: actor.userId,
          },
        });

        await this.audit.record(tx, {
          tenantId: actor.tenantId,
          projectId,
          resource: AUDIT_RESOURCE.KB_ARTICLE,
          resourceId: article.id,
          action: 'CREATE',
          actorId: actor.userId,
          requestId: meta.requestId,
          ip: meta.ip,
          before: null,
          after: { slug: article.slug, versionNo: 1, status: 'DRAFT' },
          changedFields: ['slug', 'versionNo', 'status'],
        });

        return toArticleResponse(article, [version]);
      });
    } catch (error: unknown) {
      if (isUniqueViolation(error)) {
        throw AppException.conflict('SLUG_TAKEN', '该项目下已存在相同 slug 的文章');
      }
      throw error;
    }
  }

  async detail(ctx: KnowledgeContext, id: string): Promise<KbArticleResponse> {
    const { actor, projectId } = ctx;
    assertUuid(id);

    const data = await this.prisma.withTenant(actor.tenantId, async (tx) => {
      const article = await tx.kbArticle.findFirst({ where: { id, projectId } });
      if (article === null) {
        throw AppException.notFound('KB_ARTICLE_NOT_FOUND', '知识库文章不存在');
      }
      const versions = await tx.kbArticleVersion.findMany({
        where: { articleId: article.id },
        orderBy: { versionNo: 'desc' },
      });
      return { article, versions };
    });

    return toArticleResponse(data.article, data.versions);
  }

  /** 编辑产生新版本草稿；已发布版本保持不动，线上内容不受影响。 */
  async update(
    ctx: KnowledgeContext,
    id: string,
    dto: UpdateKbArticleDto,
  ): Promise<KbArticleResponse> {
    const { actor, projectId, meta } = ctx;
    assertUuid(id);

    return this.prisma.withTenant(actor.tenantId, async (tx) => {
      const article = await lockArticle(tx, id, projectId);
      if (article.archived_at !== null) {
        throw AppException.conflict('KB_ARCHIVED', '文章已归档，不能继续编辑');
      }

      const latest = await tx.kbArticleVersion.findFirst({
        where: { articleId: id },
        orderBy: { versionNo: 'desc' },
      });
      if (latest === null) {
        throw AppException.notFound('VERSION_NOT_FOUND', '文章版本不存在');
      }

      const nextVersionNo = latest.versionNo + 1;
      await tx.kbArticleVersion.create({
        data: {
          tenantId: actor.tenantId,
          articleId: id,
          versionNo: nextVersionNo,
          title: dto.title,
          body: sanitizeRichText(dto.body),
          status: 'DRAFT',
          authorId: actor.userId,
        },
      });
      const updated = await tx.kbArticle.update({
        where: { id },
        data: { version: { increment: 1 } },
      });

      await this.audit.record(tx, {
        tenantId: actor.tenantId,
        projectId,
        resource: AUDIT_RESOURCE.KB_ARTICLE,
        resourceId: id,
        action: 'UPDATE',
        actorId: actor.userId,
        requestId: meta.requestId,
        ip: meta.ip,
        before: { version: article.version, latestVersionNo: latest.versionNo },
        after: { version: updated.version, latestVersionNo: nextVersionNo, status: 'DRAFT' },
        changedFields: ['version', 'title', 'body'],
      });

      const versions = await tx.kbArticleVersion.findMany({
        where: { articleId: id },
        orderBy: { versionNo: 'desc' },
      });
      return toArticleResponse(updated, versions);
    });
  }

  /**
   * 发布只允许当前最新版本：更早的草稿返回 409，避免用旧内容覆盖新内容。
   * 重复发布同一版本保持幂等（200），不重复写审计。
   */
  async publish(
    ctx: KnowledgeContext,
    id: string,
    dto: PublishKbArticleDto,
  ): Promise<PublishKbArticleResponse> {
    const { actor, projectId, meta } = ctx;
    assertUuid(id);

    return this.prisma.withTenant(actor.tenantId, async (tx) => {
      const article = await lockArticle(tx, id, projectId);
      if (article.archived_at !== null) {
        throw AppException.conflict('KB_ARCHIVED', '文章已归档，不能发布');
      }

      const target = await tx.kbArticleVersion.findFirst({
        where: { articleId: id, versionNo: dto.versionNo },
      });
      if (target === null) {
        throw AppException.notFound('VERSION_NOT_FOUND', '指定版本不存在');
      }
      if (article.published_version_id === target.id) {
        return {
          id: article.id,
          publishedVersionId: target.id,
          version: article.version,
          versionNo: target.versionNo,
        };
      }
      if (target.status !== 'DRAFT') {
        throw AppException.conflict('VERSION_CONFLICT', '该版本不是草稿，不能发布', {
          requestedVersionNo: dto.versionNo,
        });
      }

      const latest = await tx.kbArticleVersion.findFirst({
        where: { articleId: id },
        orderBy: { versionNo: 'desc' },
      });
      if (latest !== null && latest.versionNo !== target.versionNo) {
        throw AppException.conflict('VERSION_CONFLICT', '只能发布最新版本，请先合并较新的草稿', {
          requestedVersionNo: dto.versionNo,
          currentVersionNo: latest.versionNo,
        });
      }
      if (target.body.trim() === '') {
        throw AppException.unprocessable('EMPTY_BODY', '正文为空，不能发布');
      }

      await tx.kbArticleVersion.updateMany({
        where: { articleId: id, status: 'PUBLISHED', NOT: { id: target.id } },
        data: { status: 'ARCHIVED' },
      });
      const published = await tx.kbArticleVersion.update({
        where: { id: target.id },
        data: { status: 'PUBLISHED', publishedAt: new Date() },
      });
      const updated = await tx.kbArticle.update({
        where: { id },
        data: { publishedVersionId: published.id, version: { increment: 1 } },
      });

      await this.audit.record(tx, {
        tenantId: actor.tenantId,
        projectId,
        resource: AUDIT_RESOURCE.KB_ARTICLE,
        resourceId: id,
        action: 'PUBLISH',
        actorId: actor.userId,
        requestId: meta.requestId,
        ip: meta.ip,
        before: { publishedVersionId: article.published_version_id },
        after: {
          publishedVersionId: published.id,
          versionNo: published.versionNo,
          ...(dto.comment === undefined ? {} : { comment: dto.comment }),
        },
        changedFields: ['publishedVersionId', 'version'],
      });

      return {
        id: updated.id,
        publishedVersionId: published.id,
        version: updated.version,
        versionNo: published.versionNo,
      };
    });
  }

  /** 归档不物理删除：发布版本保留可回溯，检索与模板列表不再返回该文章。 */
  async archive(ctx: KnowledgeContext, id: string): Promise<{ id: string; archivedAt: string }> {
    const { actor, projectId, meta } = ctx;
    assertUuid(id);

    return this.prisma.withTenant(actor.tenantId, async (tx) => {
      const article = await tx.kbArticle.findFirst({ where: { id, projectId } });
      if (article === null) {
        throw AppException.notFound('KB_ARTICLE_NOT_FOUND', '知识库文章不存在');
      }
      if (article.archivedAt !== null) {
        return { id: article.id, archivedAt: article.archivedAt.toISOString() };
      }

      const archivedAt = new Date();
      await tx.kbArticle.update({
        where: { id },
        data: { archivedAt, version: { increment: 1 } },
      });
      await tx.kbArticleVersion.updateMany({
        where: { articleId: id, status: 'DRAFT' },
        data: { status: 'ARCHIVED' },
      });

      await this.audit.record(tx, {
        tenantId: actor.tenantId,
        projectId,
        resource: AUDIT_RESOURCE.KB_ARTICLE,
        resourceId: id,
        action: 'ARCHIVE',
        actorId: actor.userId,
        requestId: meta.requestId,
        ip: meta.ip,
        before: { archivedAt: null },
        after: { archivedAt: archivedAt.toISOString() },
        changedFields: ['archivedAt'],
      });

      return { id, archivedAt: archivedAt.toISOString() };
    });
  }

  async listTemplates(ctx: KnowledgeContext): Promise<ReplyTemplateListResponse> {
    const { actor, projectId } = ctx;
    const rows = await this.prisma.withTenant(actor.tenantId, (tx) =>
      tx.replyTemplate.findMany({
        where: { projectId, archivedAt: null },
        orderBy: [{ updatedAt: 'desc' }, { name: 'asc' }],
      }),
    );

    return {
      items: rows.map((row) => ({
        id: row.id,
        name: row.name,
        body: row.body,
        variables: variablesOf(row.variables),
        version: row.version,
        updatedAt: row.updatedAt.toISOString(),
      })),
    };
  }

  /**
   * 渲染无副作用：结果只作为响应返回，不回写模板。
   * 未声明变量、缺少必填变量都以 400 拒绝，避免产生半句话回复。
   */
  async renderTemplate(
    ctx: KnowledgeContext,
    id: string,
    variables: Record<string, unknown>,
  ): Promise<RenderReplyTemplateResponse> {
    assertUuid(id);
    const { actor, projectId } = ctx;

    const template = await this.prisma.withTenant(actor.tenantId, (tx) =>
      tx.replyTemplate.findFirst({ where: { id, projectId, archivedAt: null } }),
    );
    if (template === null) {
      throw AppException.notFound('TEMPLATE_NOT_FOUND', '回复模板不存在');
    }

    const declared = variablesOf(template.variables);
    const entries = Object.entries(variables);
    const nonString = entries.filter(([, value]) => typeof value !== 'string');
    if (nonString.length > 0) {
      throw AppException.validation(
        '变量值必须是字符串',
        nonString.map(([variable]) => ({ field: `variables.${variable}`, reason: 'NOT_STRING' })),
      );
    }
    const values = Object.fromEntries(entries) as Record<string, string>;

    const undeclared = Object.keys(values).filter((name) => !declared.includes(name));
    if (undeclared.length > 0) {
      throw new AppException(
        HttpStatus.BAD_REQUEST,
        'VARIABLE_NOT_ALLOWED',
        `模板未声明变量: ${undeclared.join(', ')}`,
        undeclared.map((variable) => ({ variable, reason: 'NOT_DECLARED' })),
      );
    }

    const missing = declared.filter(
      (name) => values[name] === undefined || values[name].trim() === '',
    );
    if (missing.length > 0) {
      throw new AppException(
        HttpStatus.BAD_REQUEST,
        'VARIABLE_NOT_ALLOWED',
        `缺少必填变量: ${missing.join(', ')}`,
        missing.map((variable) => ({ variable, reason: 'MISSING' })),
      );
    }

    return {
      templateId: template.id,
      body: sanitizeRichText(renderTemplateBody(template.body, declared, values)),
      missingVariables: [],
    };
  }
}

export function renderTemplateBody(
  template: string,
  declared: readonly string[],
  values: Record<string, string>,
): string {
  let body = template;
  for (const name of declared) {
    body = body.split(`{{${name}}}`).join(escapeHtml(values[name] ?? ''));
  }
  return body;
}

export function buildSnippet(body: string, keyword: string): string | null {
  if (keyword === '') {
    return null;
  }
  const index = body.toLowerCase().indexOf(keyword.toLowerCase());
  if (index < 0) {
    return body.length <= SNIPPET_RADIUS * 2 ? body : `${body.slice(0, SNIPPET_RADIUS * 2)}…`;
  }
  const start = Math.max(0, index - SNIPPET_RADIUS);
  const end = Math.min(body.length, index + keyword.length + SNIPPET_RADIUS);
  return `${start > 0 ? '…' : ''}${body.slice(start, end)}${end < body.length ? '…' : ''}`;
}

export function escapeHtml(value: string): string {
  return value
    .replace(/&/gu, '&amp;')
    .replace(/</gu, '&lt;')
    .replace(/>/gu, '&gt;')
    .replace(/"/gu, '&quot;')
    .replace(/'/gu, '&#39;');
}

function variablesOf(raw: Prisma.JsonValue): string[] {
  if (!Array.isArray(raw)) {
    return [];
  }
  return raw.filter((item): item is string => typeof item === 'string');
}

function toArticleResponse(
  article: {
    id: string;
    slug: string;
    version: number;
    publishedVersionId: string | null;
    archivedAt: Date | null;
    createdAt: Date;
    updatedAt: Date;
  },
  versions: {
    id: string;
    versionNo: number;
    title: string;
    body: string;
    status: 'DRAFT' | 'PUBLISHED' | 'ARCHIVED';
    authorId: string;
    publishedAt: Date | null;
    createdAt: Date;
  }[],
): KbArticleResponse {
  const mapped: KbArticleVersionResponse[] = versions.map((version) => ({
    id: version.id,
    versionNo: version.versionNo,
    title: version.title,
    body: version.body,
    status: version.status,
    authorId: version.authorId,
    publishedAt: version.publishedAt === null ? null : version.publishedAt.toISOString(),
    createdAt: version.createdAt.toISOString(),
  }));

  return {
    id: article.id,
    slug: article.slug,
    version: article.version,
    publishedVersionId: article.publishedVersionId,
    archivedAt: article.archivedAt === null ? null : article.archivedAt.toISOString(),
    createdAt: article.createdAt.toISOString(),
    updatedAt: article.updatedAt.toISOString(),
    versions: mapped,
  };
}

async function lockArticle(
  tx: Prisma.TransactionClient,
  id: string,
  projectId: string,
): Promise<LockedArticle> {
  const rows = await tx.$queryRaw<LockedArticle[]>`
    SELECT id, version, published_version_id, archived_at
      FROM kb_articles
     WHERE id = ${id}::uuid AND project_id = ${projectId}::uuid
     FOR UPDATE
  `;
  const row = rows[0];
  if (row === undefined) {
    throw AppException.notFound('KB_ARTICLE_NOT_FOUND', '知识库文章不存在');
  }
  return row;
}

function assertUuid(id: string): void {
  if (!UUID_PATTERN.test(id)) {
    throw AppException.validation('知识库 ID 格式不合法');
  }
}

function isUniqueViolation(error: unknown): boolean {
  return (
    error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002'
  );
}

function escapeLike(value: string): string {
  return value.replace(/[\\%_]/gu, '\\$&');
}

interface Cursor {
  updatedAt: Date;
  id: string;
}

function encodeCursor(row: KbSearchRow): string {
  return Buffer.from(`${row.updated_at.toISOString()}|${row.id}`, 'utf8').toString('base64url');
}

function decodeCursor(raw: string): Cursor {
  let decoded: string;
  try {
    decoded = Buffer.from(raw, 'base64url').toString('utf8');
  } catch {
    throw AppException.validation('cursor 不合法');
  }
  const separator = decoded.lastIndexOf('|');
  const iso = decoded.slice(0, separator);
  const id = decoded.slice(separator + 1);
  const updatedAt = new Date(iso);
  if (separator < 0 || Number.isNaN(updatedAt.getTime()) || !UUID_PATTERN.test(id)) {
    throw AppException.validation('cursor 不合法');
  }
  return { updatedAt, id };
}
