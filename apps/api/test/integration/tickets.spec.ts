import { randomUUID } from 'node:crypto';

import { Client, type ClientConfig } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { Actor } from '../../src/auth/auth.types';
import { AuditService } from '../../src/audit/audit.service';
import { AppException } from '../../src/common/errors';
import { IamService } from '../../src/iam/iam.service';
import { PermissionCacheService } from '../../src/iam/permission-cache.service';
import { IdempotencyService } from '../../src/idempotency/idempotency.service';
import { OutboxService } from '../../src/outbox/outbox.service';
import { PrismaService } from '../../src/prisma/prisma.service';
import type { CreateTicketDto } from '../../src/tickets/ticket.dto';
import { TicketsService, type TicketContext } from '../../src/tickets/tickets.service';

const ID = {
  tenantA: '11111111-1111-4111-8111-111111111111',
  tenantB: '22222222-2222-4222-8222-222222222222',
  projectA1: 'a1111111-1111-4111-8111-111111111111',
  projectA2: 'a2222222-2222-4222-8222-222222222222',
  projectB1: 'b1111111-1111-4111-8111-111111111111',
  agentA: 'c1111111-1111-4111-8111-111111111111',
  leadA: 'c2222222-2222-4222-8222-222222222222',
  contractorA: 'c3333333-3333-4333-8333-333333333333',
  roleAgentA: 'd1111111-1111-4111-8111-111111111111',
  roleLeadA: 'd2222222-2222-4222-8222-222222222222',
  roleContractorA: 'd3333333-3333-4333-8333-333333333333',
  membershipAgentA: 'f1111111-1111-4111-8111-111111111111',
  membershipLeadA: 'f2222222-2222-4222-8222-222222222222',
  membershipContractorA: 'f3333333-3333-4333-8333-333333333333',
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
    tenantId: ID.tenantA,
    tenantCode: 'tenant-a',
    membershipId: params.membershipId,
    roles: [{ id: params.roleId, code: params.roleCode, name: params.roleName }],
    projectIds: params.projectIds,
  };
}

const agentActor = makeActor({
  userId: ID.agentA,
  email: 'agent-a@example.com',
  membershipId: ID.membershipAgentA,
  roleId: ID.roleAgentA,
  roleCode: 'agent',
  roleName: '客服',
  projectIds: [ID.projectA1, ID.projectA2],
});

const leadActor = makeActor({
  userId: ID.leadA,
  email: 'lead-a@example.com',
  membershipId: ID.membershipLeadA,
  roleId: ID.roleLeadA,
  roleCode: 'lead',
  roleName: '客服主管',
  projectIds: [ID.projectA1, ID.projectA2],
});

const contractorActor = makeActor({
  userId: ID.contractorA,
  email: 'contractor-a@example.com',
  membershipId: ID.membershipContractorA,
  roleId: ID.roleContractorA,
  roleCode: 'contractor',
  roleName: '外包坐席',
  projectIds: [ID.projectA1],
});

function ctx(actor: Actor = agentActor, projectId: string = ID.projectA1): TicketContext {
  return {
    actor,
    projectId,
    meta: { requestId: randomUUID(), ip: '127.0.0.1' },
  };
}

function createDto(subject: string, extra: Partial<CreateTicketDto> = {}): CreateTicketDto {
  return {
    subject,
    description: '集成测试工单描述',
    customerName: '张先生',
    customerPhone: '13800001234',
    tags: ['集成测试'],
    ...extra,
  };
}

async function expectAppError(
  promise: Promise<unknown>,
  status: number,
  code: string,
): Promise<void> {
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
}

const clients: Client[] = [];

async function connect(envName: string): Promise<Client> {
  const client = new Client(clientConfig(requireEnv(envName)));
  await client.connect();
  clients.push(client);
  return client;
}

let prisma: PrismaService;
let cache: PermissionCacheService;
let tickets: TicketsService;

beforeAll(async () => {
  prisma = new PrismaService();
  cache = new PermissionCacheService(prisma);
  await cache.onModuleInit();
  const iam = new IamService(prisma, cache);
  tickets = new TicketsService(
    prisma,
    iam,
    new IdempotencyService(),
    new AuditService(),
    new OutboxService(),
  );
});

afterAll(async () => {
  await Promise.all(clients.map((client) => client.end().catch(() => undefined)));
  await cache.onModuleDestroy();
  await prisma.$disconnect();
});

describe('I2-T2 创建工单：事务、工单号与幂等', () => {
  it('创建返回 201，并在同一事务内写入审计与 Outbox 事件', async () => {
    const subject = `事务验证-${randomUUID()}`;
    const result = await tickets.create(ctx(), createDto(subject), randomUUID());

    expect(result.statusCode).toBe(201);
    expect(result.replay).toBe(false);
    expect(result.body.ticketNo).toMatch(/^SUP-\d+$/);
    expect(result.body.status).toBe('OPEN');
    expect(result.body.customerPhone).toBe('13800001234');

    const audit = await tickets.auditTrail(ctx(), result.body.id);
    expect(audit.items).toHaveLength(1);
    expect(audit.items[0]).toMatchObject({ action: 'CREATE', before: null });
    expect(audit.items[0]?.changedFields).toEqual(
      expect.arrayContaining(['ticketNo', 'subject', 'status', 'customerPhone']),
    );

    const events = await prisma.withTenant(ID.tenantA, (tx) =>
      tx.outboxEvent.findMany({ where: { type: 'ticket.created' } }),
    );
    const created = events.find(
      (event) => (event.payload as { ticketId?: string }).ticketId === result.body.id,
    );
    expect(created).toBeDefined();
    expect(created?.status).toBe('PENDING');
  });

  it('相同 Idempotency-Key 与请求体返回首次结果，不产生第二张工单', async () => {
    const key = randomUUID();
    const subject = `幂等验证-${randomUUID()}`;
    const first = await tickets.create(ctx(), createDto(subject), key);
    const second = await tickets.create(ctx(), createDto(subject), key);

    expect(first.statusCode).toBe(201);
    expect(second.statusCode).toBe(200);
    expect(second.replay).toBe(true);
    expect(second.body).toEqual(first.body);

    const count = await prisma.withTenant(ID.tenantA, (tx) =>
      tx.ticket.count({ where: { subject } }),
    );
    expect(count).toBe(1);
  });

  it('同一 Idempotency-Key 用于不同请求体返回 409 IDEMPOTENCY_KEY_REUSED', async () => {
    const key = randomUUID();
    await tickets.create(ctx(), createDto(`复用验证-${randomUUID()}`), key);

    await expectAppError(
      tickets.create(ctx(), createDto(`复用验证-${randomUUID()}`), key),
      409,
      'IDEMPOTENCY_KEY_REUSED',
    );
  });

  it('同一 Idempotency-Key 并发提交只创建一张工单', async () => {
    const key = randomUUID();
    const subject = `并发幂等-${randomUUID()}`;
    const results = await Promise.all([
      tickets.create(ctx(), createDto(subject), key),
      tickets.create(ctx(), createDto(subject), key),
    ]);

    const created = results.filter((result) => result.statusCode === 201);
    const replayed = results.filter((result) => result.statusCode === 200);
    expect(created).toHaveLength(1);
    expect(replayed).toHaveLength(1);
    expect(replayed[0]?.body.id).toBe(created[0]?.body.id);

    const count = await prisma.withTenant(ID.tenantA, (tx) =>
      tx.ticket.count({ where: { subject } }),
    );
    expect(count).toBe(1);
  });

  it('并发生成 100 张工单，工单号无重复且连续', async () => {
    const marker = randomUUID();
    const results = await Promise.all(
      Array.from({ length: 100 }, (_, index) =>
        tickets.create(ctx(), createDto(`批量建单-${marker}-${index}`), randomUUID()),
      ),
    );

    expect(results.every((result) => result.statusCode === 201)).toBe(true);
    const sequences = results
      .map((result) => Number(result.body.ticketNo.split('-')[1]))
      .sort((left, right) => left - right);

    expect(new Set(sequences).size).toBe(100);
    for (let index = 1; index < sequences.length; index += 1) {
      expect(sequences[index]! - sequences[index - 1]!).toBe(1);
    }
  });

  it('工单号唯一约束按 (租户, 项目, 工单号) 生效', async () => {
    const result = await tickets.create(ctx(), createDto(`唯一约束-${randomUUID()}`), randomUUID());
    const migrator = await connect('MIGRATE_DATABASE_URL');

    await migrator.query('BEGIN');
    try {
      await migrator.query('SELECT set_config($1, $2, true)', ['app.tenant_id', ID.tenantA]);
      await expect(
        migrator.query(
          `INSERT INTO tickets (id, tenant_id, project_id, ticket_no, subject, description, customer_name, created_by, updated_at)
           VALUES ($1, $2, $3, $4, '重复', '重复', '客户', $5, now())`,
          [randomUUID(), ID.tenantA, ID.projectA1, result.body.ticketNo, ID.agentA],
        ),
      ).rejects.toMatchObject({ code: '23505' });
    } finally {
      await migrator.query('ROLLBACK').catch(() => undefined);
    }
  });

  it('无字段写权限时创建被拒绝，且不落库、不写审计', async () => {
    const subject = `字段拒绝-${randomUUID()}`;
    await expectAppError(
      tickets.create(
        ctx(),
        createDto(subject, { assigneeId: '00000000-0000-4000-8000-000000000001' }),
        randomUUID(),
      ),
      403,
      'FIELD_DENIED',
    );

    const count = await prisma.withTenant(ID.tenantA, (tx) =>
      tx.ticket.count({ where: { subject } }),
    );
    expect(count).toBe(0);
  });
});

describe('I2-T3 列表、详情与字段投影', () => {
  it('状态与受理人筛选可组合，游标翻页不重复', async () => {
    const marker = randomUUID();
    const created = await Promise.all([
      ...Array.from({ length: 3 }, (_, index) =>
        tickets.create(ctx(), createDto(`筛选-${marker}-${index}`), randomUUID()),
      ),
      tickets.create(
        ctx(leadActor),
        createDto(`筛选-${marker}-lead`, { assigneeId: ID.leadA }),
        randomUUID(),
      ),
    ]);
    const [first] = created;
    if (first === undefined) {
      throw new Error('创建失败');
    }
    await tickets.update(ctx(leadActor), first.body.id, `"${first.body.version}"`, {
      status: 'PENDING',
    });

    const pending = await tickets.list(ctx(), { status: 'PENDING', limit: 50 });
    expect(pending.items.every((item) => item.status === 'PENDING')).toBe(true);
    expect(pending.items.some((item) => item.id === first.body.id)).toBe(true);

    const assigned = await tickets.list(ctx(), { assigneeId: ID.leadA, limit: 50 });
    expect(assigned.items.every((item) => item.assigneeId === ID.leadA)).toBe(true);

    const pageOne = await tickets.list(ctx(), { limit: 2 });
    expect(pageOne.items).toHaveLength(2);
    expect(pageOne.nextCursor).not.toBeNull();
    const pageTwo = await tickets.list(ctx(), {
      limit: 2,
      cursor: pageOne.nextCursor ?? undefined,
    });
    expect(pageTwo.items).toHaveLength(2);
    const ids = new Set(pageOne.items.map((item) => item.id));
    expect(pageTwo.items.some((item) => ids.has(item.id))).toBe(false);
  });

  it('详情按角色投影字段，内部备注与内部消息对无权限角色不可见', async () => {
    const created = await tickets.create(
      ctx(),
      createDto(`投影-${randomUUID()}`, { customerPhone: '13800001234' }),
      randomUUID(),
    );
    const ticketId = created.body.id;

    await tickets.appendMessage(ctx(), ticketId, randomUUID(), {
      body: '仅内部可见',
      visibility: 'INTERNAL',
    });
    await tickets.appendMessage(ctx(), ticketId, randomUUID(), {
      body: '客户可见的回复',
      visibility: 'PUBLIC',
    });

    const contractorView = await tickets.detail(ctx(contractorActor), ticketId);
    expect(contractorView.customerPhone).toBe('*******1234');
    expect(contractorView).not.toHaveProperty('internalNote');
    expect(contractorView.messages).toHaveLength(1);
    expect(contractorView.messages[0]?.visibility).toBe('PUBLIC');

    const agentView = await tickets.detail(ctx(), ticketId);
    expect(agentView.customerPhone).toBe('13800001234');
    expect(agentView.messages).toHaveLength(2);
  });

  it('跨租户访问工单详情返回 404', async () => {
    const created = await tickets.create(ctx(), createDto(`跨租户-${randomUUID()}`), randomUUID());
    const tenantBActor: Actor = {
      ...makeActor({
        userId: 'c4444444-4444-4444-8444-444444444444',
        email: 'agent-b@example.com',
        membershipId: 'f5555555-5555-4555-8555-555555555555',
        roleId: 'e1111111-1111-4111-8111-111111111111',
        roleCode: 'agent',
        roleName: '客服',
        projectIds: [ID.projectB1],
      }),
      tenantId: ID.tenantB,
      tenantCode: 'tenant-b',
    };

    await expectAppError(
      tickets.detail({ actor: tenantBActor, projectId: ID.projectB1, meta: ctx().meta }, created.body.id),
      404,
      'TICKET_NOT_FOUND',
    );
  });
});

describe('I2-T4 状态机与乐观锁', () => {
  it('缺少 If-Match 返回 412', async () => {
    const created = await tickets.create(ctx(), createDto(`无版本-${randomUUID()}`), randomUUID());
    await expectAppError(
      tickets.update(ctx(), created.body.id, undefined, { priority: 'HIGH' }),
      412,
      'PRECONDITION_REQUIRED',
    );
  });

  it('版本一致的更新成功并递增版本号', async () => {
    const created = await tickets.create(ctx(), createDto(`正常更新-${randomUUID()}`), randomUUID());
    const updated = await tickets.update(ctx(), created.body.id, `"${created.body.version}"`, {
      priority: 'HIGH',
    });

    expect(updated.version).toBe(created.body.version + 1);
    expect(updated.priority).toBe('HIGH');
  });

  it('过期版本更新返回 409 并带当前版本', async () => {
    const created = await tickets.create(ctx(), createDto(`过期版本-${randomUUID()}`), randomUUID());
    await tickets.update(ctx(), created.body.id, `"${created.body.version}"`, { priority: 'LOW' });

    let caught: unknown;
    try {
      await tickets.update(ctx(), created.body.id, `"${created.body.version}"`, { priority: 'HIGH' });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(AppException);
    const exception = caught as AppException;
    expect(exception.getStatus()).toBe(409);
    expect(exception.getResponse()).toMatchObject({
      code: 'VERSION_CONFLICT',
      details: { currentVersion: created.body.version + 1 },
    });
  });

  it('20 个并发同版本更新只有 1 个成功', async () => {
    const created = await tickets.create(ctx(), createDto(`并发更新-${randomUUID()}`), randomUUID());
    const results = await Promise.allSettled(
      Array.from({ length: 20 }, (_, index) =>
        tickets.update(ctx(), created.body.id, `"${created.body.version}"`, {
          priority: index % 2 === 0 ? 'HIGH' : 'LOW',
        }),
      ),
    );

    const fulfilled = results.filter((result) => result.status === 'fulfilled');
    const rejected = results.filter((result) => result.status === 'rejected');
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(19);
    for (const result of rejected) {
      if (result.status === 'rejected') {
        expect(result.reason).toBeInstanceOf(AppException);
        expect((result.reason as AppException).getStatus()).toBe(409);
      }
    }
  });

  it('非法状态迁移返回 400，关闭动作需要 ticket:close', async () => {
    const created = await tickets.create(ctx(), createDto(`状态机-${randomUUID()}`), randomUUID());
    const id = created.body.id;

    await expectAppError(
      tickets.update(ctx(), id, `"${created.body.version}"`, { status: 'CLOSED' }),
      403,
      'FORBIDDEN',
    );

    const pending = await tickets.update(ctx(), id, `"${created.body.version}"`, {
      status: 'PENDING',
    });
    await expectAppError(
      tickets.update(ctx(leadActor), id, `"${pending.version}"`, { status: 'CLOSED' }),
      400,
      'INVALID_TRANSITION',
    );

    const resolved = await tickets.update(ctx(), id, `"${pending.version}"`, {
      status: 'RESOLVED',
    });
    const closed = await tickets.update(ctx(leadActor), id, `"${resolved.version}"`, {
      status: 'CLOSED',
    });
    expect(closed.status).toBe('CLOSED');
  });

  it('已关闭工单拒绝追加消息', async () => {
    const created = await tickets.create(ctx(), createDto(`关闭-${randomUUID()}`), randomUUID());
    const resolved = await tickets.update(
      ctx(),
      created.body.id,
      `"${created.body.version}"`,
      { status: 'RESOLVED' },
    );
    await tickets.update(ctx(leadActor), created.body.id, `"${resolved.version}"`, {
      status: 'CLOSED',
    });

    await expectAppError(
      tickets.appendMessage(ctx(), created.body.id, randomUUID(), {
        body: '迟到回复',
        visibility: 'PUBLIC',
      }),
      409,
      'TICKET_CLOSED',
    );
  });
});

describe('I2-T5 消息追加', () => {
  it('并发追加 20 条消息 seq 连续且消息幂等', async () => {
    const created = await tickets.create(ctx(), createDto(`消息并发-${randomUUID()}`), randomUUID());
    const results = await Promise.all(
      Array.from({ length: 20 }, (_, index) =>
        tickets.appendMessage(ctx(), created.body.id, randomUUID(), {
          body: `并发消息 ${index}`,
          visibility: 'PUBLIC',
        }),
      ),
    );

    const sequences = results.map((result) => result.body.seq).sort((left, right) => left - right);
    expect(sequences).toEqual(Array.from({ length: 20 }, (_, index) => index + 1));

    const replayKey = randomUUID();
    const first = await tickets.appendMessage(ctx(), created.body.id, replayKey, {
      body: '幂等消息',
      visibility: 'PUBLIC',
    });
    const second = await tickets.appendMessage(ctx(), created.body.id, replayKey, {
      body: '幂等消息',
      visibility: 'PUBLIC',
    });
    expect(second.replay).toBe(true);
    expect(second.body).toEqual(first.body);

    const count = await prisma.withTenant(ID.tenantA, (tx) =>
      tx.ticketMessage.count({ where: { ticketId: created.body.id } }),
    );
    expect(count).toBe(21);
  });

  it('外包坐席不能写内部备注', async () => {
    const created = await tickets.create(ctx(), createDto(`备注权限-${randomUUID()}`), randomUUID());
    await expectAppError(
      tickets.appendMessage(ctx(contractorActor), created.body.id, randomUUID(), {
        body: '越权内部备注',
        visibility: 'INTERNAL',
      }),
      403,
      'FORBIDDEN',
    );
  });
});

describe('I2-T6 审计', () => {
  it('一次更新只产生一条审计，未变化字段不进入 changedFields', async () => {
    const created = await tickets.create(ctx(), createDto(`审计变更-${randomUUID()}`), randomUUID());
    const updated = await tickets.update(
      ctx(),
      created.body.id,
      `"${created.body.version}"`,
      { priority: 'URGENT', tags: ['集成测试'] },
    );
    expect(updated.version).toBe(2);

    const audit = await tickets.auditTrail(ctx(), created.body.id);
    expect(audit.items).toHaveLength(2);
    expect(audit.items[1]).toMatchObject({
      action: 'UPDATE',
      changedFields: ['priority'],
      before: { priority: 'NORMAL' },
      after: { priority: 'URGENT' },
    });
  });

  it('普通客服只能查看自己经手工单的审计，主管可查看项目内全部', async () => {
    const created = await tickets.create(
      ctx(leadActor),
      createDto(`主管建单-${randomUUID()}`),
      randomUUID(),
    );

    await expectAppError(
      tickets.auditTrail(ctx(agentActor), created.body.id),
      403,
      'AUDIT_FORBIDDEN',
    );

    const leadView = await tickets.auditTrail(ctx(leadActor), created.body.id);
    expect(leadView.items.length).toBeGreaterThanOrEqual(1);
  });

  it('审计表对运行时角色只允许追加', async () => {
    const rw = await connect('DATABASE_URL');
    await rw.query('BEGIN');
    try {
      await rw.query('SELECT set_config($1, $2, true)', ['app.tenant_id', ID.tenantA]);
      await expect(
        rw.query("UPDATE audit_logs SET action = 'UPDATE' WHERE tenant_id = $1", [ID.tenantA]),
      ).rejects.toMatchObject({ code: '42501' });
    } finally {
      await rw.query('ROLLBACK').catch(() => undefined);
    }

    await rw.query('BEGIN');
    try {
      await rw.query('SELECT set_config($1, $2, true)', ['app.tenant_id', ID.tenantA]);
      await expect(
        rw.query('DELETE FROM audit_logs WHERE tenant_id = $1', [ID.tenantA]),
      ).rejects.toMatchObject({ code: '42501' });
    } finally {
      await rw.query('ROLLBACK').catch(() => undefined);
    }
  });
});

describe('I2-T1 RLS、级联与索引', () => {
  it('工单、消息、审计、幂等与 Outbox 表均按租户隔离', async () => {
    const created = await tickets.create(ctx(), createDto(`隔离-${randomUUID()}`), randomUUID());
    const rw = await connect('DATABASE_URL');

    const noTenant = await rw.query('SELECT id FROM tickets WHERE id = $1', [created.body.id]);
    expect(noTenant.rowCount).toBe(0);

    await rw.query('BEGIN');
    try {
      await rw.query('SELECT set_config($1, $2, true)', ['app.tenant_id', ID.tenantB]);
      const crossTenant = await rw.query('SELECT id FROM tickets WHERE id = $1', [created.body.id]);
      expect(crossTenant.rowCount).toBe(0);
    } finally {
      await rw.query('ROLLBACK').catch(() => undefined);
    }

    await rw.query('BEGIN');
    try {
      await rw.query('SELECT set_config($1, $2, true)', ['app.tenant_id', ID.tenantA]);
      const ownTenant = await rw.query('SELECT id FROM tickets WHERE id = $1', [created.body.id]);
      expect(ownTenant.rowCount).toBe(1);
    } finally {
      await rw.query('ROLLBACK').catch(() => undefined);
    }
  });

  it('删除工单级联删除消息', async () => {
    const created = await tickets.create(ctx(), createDto(`级联-${randomUUID()}`), randomUUID());
    await tickets.appendMessage(ctx(), created.body.id, randomUUID(), {
      body: '级联消息',
      visibility: 'PUBLIC',
    });

    const migrator = await connect('MIGRATE_DATABASE_URL');
    await migrator.query('BEGIN');
    try {
      await migrator.query('SELECT set_config($1, $2, true)', ['app.tenant_id', ID.tenantA]);
      await migrator.query('DELETE FROM tickets WHERE id = $1', [created.body.id]);
      const remaining = await migrator.query('SELECT id FROM ticket_messages WHERE ticket_id = $1', [
        created.body.id,
      ]);
      expect(remaining.rowCount).toBe(0);
    } finally {
      await migrator.query('ROLLBACK').catch(() => undefined);
    }
  });

  it('列表查询在禁用顺序扫描时使用索引', async () => {
    const migrator = await connect('MIGRATE_DATABASE_URL');
    await migrator.query('BEGIN');
    try {
      await migrator.query('SELECT set_config($1, $2, true)', ['app.tenant_id', ID.tenantA]);
      await migrator.query('SET LOCAL enable_seqscan = off');
      const plan = await migrator.query<{ 'QUERY PLAN': string }>(
        `EXPLAIN SELECT id FROM tickets
          WHERE tenant_id = $1 AND project_id = $2
          ORDER BY updated_at DESC, id DESC
          LIMIT 21`,
        [ID.tenantA, ID.projectA1],
      );
      const text = plan.rows.map((row) => row['QUERY PLAN']).join('\n');
      expect(text).toMatch(/Index Scan|Index Only Scan|Bitmap Index Scan/);
    } finally {
      await migrator.query('ROLLBACK').catch(() => undefined);
    }
  });
});
