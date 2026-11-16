import { randomUUID } from 'node:crypto';

import { Client, type ClientConfig } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { Actor } from '../../src/auth/auth.types';
import { AuditService } from '../../src/audit/audit.service';
import { AppException } from '../../src/common/errors';
import type { CreateKbArticleDto } from '../../src/knowledge/knowledge.dto';
import { KnowledgeService, type KnowledgeContext } from '../../src/knowledge/knowledge.service';
import { PermissionCacheService } from '../../src/iam/permission-cache.service';
import { PrismaService } from '../../src/prisma/prisma.service';

const ID = {
  tenantA: '11111111-1111-4111-8111-111111111111',
  tenantB: '22222222-2222-4222-8222-222222222222',
  projectA1: 'a1111111-1111-4111-8111-111111111111',
  projectA2: 'a2222222-2222-4222-8222-222222222222',
  projectB1: 'b1111111-1111-4111-8111-111111111111',
  agentA: 'c1111111-1111-4111-8111-111111111111',
  leadA: 'c2222222-2222-4222-8222-222222222222',
  agentB: 'c4444444-4444-4444-8444-444444444444',
  roleAgentA: 'd1111111-1111-4111-8111-111111111111',
  roleLeadA: 'd2222222-2222-4222-8222-222222222222',
  roleAgentB: 'e1111111-1111-4111-8111-111111111111',
  membershipAgentA: 'f1111111-1111-4111-8111-111111111111',
  membershipLeadA: 'f2222222-2222-4222-8222-222222222222',
  membershipAgentB: 'f5555555-5555-4555-8555-555555555555',
  templateRefundA1: '9a111111-1111-4111-8111-111111111111',
  templateGreetingA2: '9a222222-2222-4222-8222-222222222222',
} as const;

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`${name} is required for integration tests`);
  }
  return value;
}

function clientConfig(rawUrl: string): ClientConfig {
  const url = new URL(rawUrl);
  return {
    host: url.hostname,
    port: Number(url.port === '' ? 5432 : url.port),
    database: decodeURIComponent(url.pathname.replace(/^\//, '')),
    user: decodeURIComponent(url.username),
    password: decodeURIComponent(url.password),
  };
}

function makeActor(params: {
  tenantId?: string;
  tenantCode?: string;
  userId: string;
  email: string;
  membershipId: string;
  roleId: string;
  roleCode: string;
  roleName: string;
  projectIds: string[];
}): Actor {
  return {
    userId: params.userId,
    email: params.email,
    sessionId: randomUUID(),
    tenantId: params.tenantId ?? ID.tenantA,
    tenantCode: params.tenantCode ?? 'tenant-a',
    membershipId: params.membershipId,
    roles: [{ id: params.roleId, code: params.roleCode, name: params.roleName }],
    projectIds: params.projectIds,
  };
}

const leadActor = makeActor({
  userId: ID.leadA,
  email: 'lead-a@example.com',
  membershipId: ID.membershipLeadA,
  roleId: ID.roleLeadA,
  roleCode: 'lead',
  roleName: '客服主管',
  projectIds: [ID.projectA1, ID.projectA2],
});

const tenantBActor = makeActor({
  tenantId: ID.tenantB,
  tenantCode: 'tenant-b',
  userId: ID.agentB,
  email: 'agent-b@example.com',
  membershipId: ID.membershipAgentB,
  roleId: ID.roleAgentB,
  roleCode: 'agent',
  roleName: '客服',
  projectIds: [ID.projectB1],
});

function ctx(
  actor: Actor = leadActor,
  projectId: string = ID.projectA1,
): KnowledgeContext {
  return {
    actor,
    projectId,
    meta: { requestId: randomUUID(), ip: '127.0.0.1' },
  };
}

function createDto(
  slug: string,
  title: string,
  body: string,
): CreateKbArticleDto {
  return { slug, title, body };
}

async function expectAppError(
  promise: Promise<unknown>,
  status: number,
  code: string,
): Promise<AppException> {
  let caught: unknown;
  try {
    await promise;
  } catch (error) {
    caught = error;
  }
  expect(caught).toBeInstanceOf(AppException);
  const exception = caught as AppException;
  expect(exception.getStatus()).toBe(status);
  expect((exception.getResponse() as { code: string }).code).toBe(code);
  return exception;
}

let prisma: PrismaService;
let cache: PermissionCacheService;
let knowledge: KnowledgeService;
let client: Client;

beforeAll(async () => {
  prisma = new PrismaService();
  cache = new PermissionCacheService(prisma);
  await cache.onModuleInit();
  knowledge = new KnowledgeService(prisma, new AuditService());

  client = new Client(clientConfig(requireEnv('DATABASE_URL')));
  await client.connect();
});

afterAll(async () => {
  await client.end().catch(() => undefined);
  await cache.onModuleDestroy();
  await prisma.$disconnect();
});

describe('I3-T1/T2 文章草稿、版本与发布', () => {
  it('草稿不进入检索；发布后可检索，审计记录发布动作', async () => {
    const suffix = randomUUID().slice(0, 8);
    const keyword = `退款政策-${suffix}`;
    const created = await knowledge.create(
      ctx(),
      createDto(`refund-${suffix}`, `${keyword}说明`, '自签收之日起 7 天内可申请退款。'),
    );

    expect(created.version).toBe(1);
    expect(created.versions).toHaveLength(1);
    expect(created.versions[0]?.status).toBe('DRAFT');

    const before = await knowledge.list(ctx(), { q: keyword });
    expect(before.items).toHaveLength(0);

    const published = await knowledge.publish(ctx(), created.id, { versionNo: 1 });
    expect(published.versionNo).toBe(1);
    expect(published.version).toBe(2);

    const after = await knowledge.list(ctx(), { q: keyword });
    expect(after.items).toHaveLength(1);
    expect(after.items[0]?.id).toBe(created.id);
    expect(after.items[0]?.status).toBe('PUBLISHED');
    expect(after.items[0]?.snippet).toContain('退款');

    const detail = await knowledge.detail(ctx(), created.id);
    expect(detail.versions).toHaveLength(1);
    expect(detail.versions[0]?.status).toBe('PUBLISHED');
    expect(detail.versions[0]?.publishedAt).not.toBeNull();

    const audits = await prisma.withTenant(ID.tenantA, (tx) =>
      tx.auditLog.findMany({
        where: { resource: 'kb_article', resourceId: created.id },
        orderBy: { createdAt: 'asc' },
        select: { action: true },
      }),
    );
    expect(audits.map((row) => row.action)).toEqual(['CREATE', 'PUBLISH']);
  });

  it('编辑生成新草稿，线上检索保持旧版本；发布后切换且历史版本可查', async () => {
    const suffix = randomUUID().slice(0, 8);
    const oldKeyword = `旧条款-${suffix}`;
    const newKeyword = `新条款-${suffix}`;
    const created = await knowledge.create(
      ctx(),
      createDto(`edit-${suffix}`, `编辑验证 ${suffix}`, `${oldKeyword}：7 天无理由退货。`),
    );
    await knowledge.publish(ctx(), created.id, { versionNo: 1 });

    const edited = await knowledge.update(ctx(), created.id, {
      title: `编辑验证 ${suffix}`,
      body: `${newKeyword}：15 天无理由退货。`,
    });
    expect(edited.versions).toHaveLength(2);
    expect(edited.versions[0]?.versionNo).toBe(2);
    expect(edited.versions[0]?.status).toBe('DRAFT');

    const stillOld = await knowledge.list(ctx(), { q: oldKeyword });
    expect(stillOld.items[0]?.id).toBe(created.id);
    const notYetNew = await knowledge.list(ctx(), { q: newKeyword });
    expect(notYetNew.items).toHaveLength(0);

    await knowledge.publish(ctx(), created.id, { versionNo: 2 });

    const nowNew = await knowledge.list(ctx(), { q: newKeyword });
    expect(nowNew.items[0]?.id).toBe(created.id);
    const oldGone = await knowledge.list(ctx(), { q: oldKeyword });
    expect(oldGone.items).toHaveLength(0);

    const detail = await knowledge.detail(ctx(), created.id);
    expect(detail.versions.map((version) => version.versionNo)).toEqual([2, 1]);
    expect(detail.versions[0]?.status).toBe('PUBLISHED');
    expect(detail.versions[1]?.status).toBe('ARCHIVED');
    expect(detail.publishedVersionId).toBe(detail.versions[0]?.id);
  });

  it('重复发布同一版本幂等，且不重复写审计', async () => {
    const suffix = randomUUID().slice(0, 8);
    const created = await knowledge.create(
      ctx(),
      createDto(`idem-${suffix}`, `幂等 ${suffix}`, '幂等发布验证正文。'),
    );
    const first = await knowledge.publish(ctx(), created.id, { versionNo: 1 });
    const second = await knowledge.publish(ctx(), created.id, { versionNo: 1 });

    expect(second.publishedVersionId).toBe(first.publishedVersionId);
    expect(second.version).toBe(first.version);

    const publishAudits = await prisma.withTenant(ID.tenantA, (tx) =>
      tx.auditLog.count({
        where: { resource: 'kb_article', resourceId: created.id, action: 'PUBLISH' },
      }),
    );
    expect(publishAudits).toBe(1);
  });

  it('发布较旧版本返回 409 VERSION_CONFLICT', async () => {
    const suffix = randomUUID().slice(0, 8);
    const created = await knowledge.create(
      ctx(),
      createDto(`stale-${suffix}`, `并发 ${suffix}`, '第一版正文。'),
    );
    await knowledge.update(ctx(), created.id, { title: `并发 ${suffix}`, body: '第二版正文。' });

    const error = await expectAppError(
      knowledge.publish(ctx(), created.id, { versionNo: 1 }),
      409,
      'VERSION_CONFLICT',
    );
    expect((error.getResponse() as { details?: { currentVersionNo?: number } }).details).toEqual({
      requestedVersionNo: 1,
      currentVersionNo: 2,
    });
  });

  it('正文为空时发布返回 422 EMPTY_BODY', async () => {
    const suffix = randomUUID().slice(0, 8);
    const created = await knowledge.create(
      ctx(),
      createDto(`empty-${suffix}`, `空正文 ${suffix}`, '   '),
    );
    await expectAppError(
      knowledge.publish(ctx(), created.id, { versionNo: 1 }),
      422,
      'EMPTY_BODY',
    );
  });

  it('项目内 slug 唯一，不同项目可复用', async () => {
    const slug = `dup-${randomUUID().slice(0, 8)}`;
    await knowledge.create(ctx(), createDto(slug, '重复 slug', '正文'));
    await expectAppError(
      knowledge.create(ctx(), createDto(slug, '重复 slug', '正文')),
      409,
      'SLUG_TAKEN',
    );

    const other = await knowledge.create(
      ctx(leadActor, ID.projectA2),
      createDto(slug, '另一个项目', '正文'),
    );
    expect(other.slug).toBe(slug);
  });

  it('归档只打标记：检索消失，历史版本仍可查询', async () => {
    const suffix = randomUUID().slice(0, 8);
    const keyword = `归档-${suffix}`;
    const created = await knowledge.create(
      ctx(),
      createDto(`archive-${suffix}`, `${keyword}标题`, `${keyword}正文内容。`),
    );
    await knowledge.publish(ctx(), created.id, { versionNo: 1 });

    const archived = await knowledge.archive(ctx(), created.id);
    expect(archived.archivedAt).not.toBe('');

    const found = await knowledge.list(ctx(), { q: keyword });
    expect(found.items).toHaveLength(0);

    const detail = await knowledge.detail(ctx(), created.id);
    expect(detail.archivedAt).not.toBeNull();
    expect(detail.versions).toHaveLength(1);
    expect(detail.versions[0]?.status).toBe('PUBLISHED');
  });
});

describe('I3-T3 检索与项目/租户隔离', () => {
  it('标题与正文均命中，中文短语部分匹配返回含关键词的片段', async () => {
    const suffix = randomUUID().slice(0, 8);
    const titleKeyword = `售后政策${suffix}`;
    const bodyKeyword = `签收之日起${suffix}`;
    const created = await knowledge.create(
      ctx(),
      createDto(`search-${suffix}`, `${titleKeyword}说明`, `${bodyKeyword} 天内可申请退款。`),
    );
    await knowledge.publish(ctx(), created.id, { versionNo: 1 });

    const byTitle = await knowledge.list(ctx(), { q: titleKeyword });
    expect(byTitle.items[0]?.id).toBe(created.id);

    const byBody = await knowledge.list(ctx(), { q: bodyKeyword });
    expect(byBody.items[0]?.id).toBe(created.id);
    expect(byBody.items[0]?.snippet).toContain(bodyKeyword);
    expect(typeof byBody.items[0]?.score).toBe('number');
  });

  it('空关键词按更新时间倒序返回已发布列表，游标翻页不重复', async () => {
    const suffix = randomUUID().slice(0, 8);
    const projectCtx = ctx(leadActor, ID.projectA2);
    const ids: string[] = [];
    for (let index = 0; index < 3; index += 1) {
      const article = await knowledge.create(
        projectCtx,
        createDto(`order-${suffix}-${index}`, `排序 ${suffix}-${index}`, '排序测试正文'),
      );
      await knowledge.publish(projectCtx, article.id, { versionNo: 1 });
      ids.push(article.id);
      await new Promise((resolve) => setTimeout(resolve, 5));
    }

    const firstPage = await knowledge.list(projectCtx, { limit: 2 });
    expect(firstPage.items).toHaveLength(2);
    expect(firstPage.items[0]?.id).toBe(ids[2]);
    expect(firstPage.nextCursor).not.toBeNull();

    const secondPage = await knowledge.list(projectCtx, {
      limit: 2,
      ...(firstPage.nextCursor === null ? {} : { cursor: firstPage.nextCursor }),
    });
    const firstIds = firstPage.items.map((item) => item.id);
    for (const item of secondPage.items) {
      expect(firstIds).not.toContain(item.id);
    }
  });

  it('检索走 pg_trgm GIN 索引', async () => {
    await client.query('BEGIN');
    await client.query("SELECT set_config('app.tenant_id', $1, true)", [ID.tenantA]);
    await client.query('SET LOCAL enable_seqscan = off');
    const plan = await client.query<Record<string, string>>(
      `EXPLAIN
       SELECT a.id
         FROM kb_articles a
         JOIN kb_article_versions v ON v.id = a.published_version_id
        WHERE a.tenant_id = $1::uuid
          AND a.project_id = $2::uuid
          AND a.archived_at IS NULL
          AND (v.title ILIKE $3 OR v.body ILIKE $3)
        ORDER BY a.updated_at DESC, a.id DESC
        LIMIT 21`,
      [ID.tenantA, ID.projectA1, '%退款%'],
    );
    await client.query('ROLLBACK');
    const text = plan.rows.map((row) => row['QUERY PLAN'] ?? '').join('\n');
    expect(text).toMatch(/Bitmap Index Scan|Index Scan/);
  });

  it('草稿与归档文章不会出现在其他项目的检索中', async () => {
    const suffix = randomUUID().slice(0, 8);
    const keyword = `隔离-${suffix}`;
    await knowledge.create(
      ctx(leadActor, ID.projectA1),
      createDto(`isolation-${suffix}`, `${keyword}标题`, `${keyword}正文`),
    );

    const otherProject = await knowledge.list(ctx(leadActor, ID.projectA2), { q: keyword });
    expect(otherProject.items).toHaveLength(0);
  });

  it('租户 B 无法检索或读取租户 A 的文章', async () => {
    const suffix = randomUUID().slice(0, 8);
    const keyword = `租户隔离-${suffix}`;
    const article = await knowledge.create(
      ctx(),
      createDto(`tenant-${suffix}`, `${keyword}标题`, `${keyword}正文`),
    );
    await knowledge.publish(ctx(), article.id, { versionNo: 1 });

    const tenantBList = await knowledge.list(ctx(tenantBActor, ID.projectB1), { q: keyword });
    expect(tenantBList.items).toHaveLength(0);
    await expectAppError(
      knowledge.detail(ctx(tenantBActor, ID.projectB1), article.id),
      404,
      'KB_ARTICLE_NOT_FOUND',
    );
  });
});

describe('I3-T4 回复模板与变量渲染', () => {
  it('按项目列出租户内模板', async () => {
    const projectA1 = await knowledge.listTemplates(ctx());
    expect(projectA1.items.map((item) => item.id)).toContain(ID.templateRefundA1);
    expect(projectA1.items.map((item) => item.id)).not.toContain(ID.templateGreetingA2);
  });

  it('渲染替换已声明变量并转义 HTML', async () => {
    const rendered = await knowledge.renderTemplate(ctx(), ID.templateRefundA1, {
      customer_name: '<b>张先生</b>',
      order_no: 'SO-1024',
    });
    expect(rendered.body).toContain('&lt;b&gt;张先生&lt;/b&gt;');
    expect(rendered.body).not.toContain('<b>');
    expect(rendered.body).toContain('SO-1024');
  });

  it('传入未声明变量返回 400 VARIABLE_NOT_ALLOWED 并指出变量名', async () => {
    const error = await expectAppError(
      knowledge.renderTemplate(ctx(), ID.templateRefundA1, {
        customer_name: '张先生',
        order_no: 'SO-1024',
        extra: '非法变量',
      }),
      400,
      'VARIABLE_NOT_ALLOWED',
    );
    expect((error.getResponse() as { details?: unknown }).details).toEqual([
      { variable: 'extra', reason: 'NOT_DECLARED' },
    ]);
  });

  it('缺少必填变量返回 400 并列出缺失项', async () => {
    const error = await expectAppError(
      knowledge.renderTemplate(ctx(), ID.templateRefundA1, { customer_name: '张先生' }),
      400,
      'VARIABLE_NOT_ALLOWED',
    );
    expect((error.getResponse() as { details?: unknown }).details).toEqual([
      { variable: 'order_no', reason: 'MISSING' },
    ]);
  });

  it('模板渲染无副作用：不回写模板内容与版本', async () => {
    const before = await knowledge.listTemplates(ctx());
    await knowledge.renderTemplate(ctx(), ID.templateRefundA1, {
      customer_name: '张先生',
      order_no: 'SO-1024',
    });
    const after = await knowledge.listTemplates(ctx());
    expect(after).toEqual(before);
  });

  it('租户 B 无法渲染租户 A 的模板', async () => {
    await expectAppError(
      knowledge.renderTemplate(ctx(tenantBActor, ID.projectB1), ID.templateRefundA1, {
        customer_name: '张先生',
        order_no: 'SO-1024',
      }),
      404,
      'TEMPLATE_NOT_FOUND',
    );
  });
});
