import { randomUUID } from 'node:crypto';

import { Client, type ClientConfig } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { PasswordService } from '../../src/auth/password.service';
import { PermissionCacheService } from '../../src/iam/permission-cache.service';
import { PrismaService } from '../../src/prisma/prisma.service';

const ID = {
  tenantA: '11111111-1111-4111-8111-111111111111',
  tenantB: '22222222-2222-4222-8222-222222222222',
  projectA1: 'a1111111-1111-4111-8111-111111111111',
  projectB1: 'b1111111-1111-4111-8111-111111111111',
  roleAgentA: 'd1111111-1111-4111-8111-111111111111',
  membershipAgentA: 'f1111111-1111-4111-8111-111111111111',
  agentA: 'c1111111-1111-4111-8111-111111111111',
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

const clients: Client[] = [];

async function connect(envName: string): Promise<Client> {
  const client = new Client(clientConfig(requireEnv(envName)));
  await client.connect();
  clients.push(client);
  return client;
}

async function inTenant(
  client: Client,
  tenantId: string,
  work: () => Promise<void>,
): Promise<void> {
  await client.query('BEGIN');
  try {
    await client.query('SELECT set_config($1, $2, true)', ['app.tenant_id', tenantId]);
    await work();
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  }
}

/**
 * 在已开启的租户事务内用保存点探测约束冲突：
 * 直接让语句失败会把事务置为 aborted，后续断言都会得到 25P02。
 */
async function expectViolation(
  client: Client,
  code: string,
  sql: string,
  params: unknown[],
): Promise<void> {
  await client.query('SAVEPOINT probe');
  await expect(client.query(sql, params)).rejects.toMatchObject({ code });
  await client.query('ROLLBACK TO SAVEPOINT probe');
}

afterAll(async () => {
  await Promise.all(clients.map((client) => client.end().catch(() => undefined)));
});

describe('I1 行级安全与权限数据', () => {
  let rw: Client;
  let migrator: Client;

  beforeAll(async () => {
    rw = await connect('DATABASE_URL');
    migrator = await connect('MIGRATE_DATABASE_URL');
  });

  it('未设置租户上下文时读取业务表返回空集', async () => {
    const result = await rw.query<{ count: number }>('SELECT count(*)::int AS count FROM projects');
    expect(result.rows[0]?.count).toBe(0);
  });

  it('设置租户 A 后只能读到租户 A 的项目', async () => {
    await inTenant(rw, ID.tenantA, async () => {
      const visible = await rw.query<{ id: string }>('SELECT id FROM projects ORDER BY code');
      expect(visible.rowCount).toBe(2);
      expect(visible.rows.map((row) => row.id)).not.toContain(ID.projectB1);

      const crossTenant = await rw.query('SELECT id FROM projects WHERE id = $1', [
        ID.projectB1,
      ]);
      expect(crossTenant.rowCount).toBe(0);
    });
  });

  it('FORCE RLS 对表所有者同样生效', async () => {
    await inTenant(migrator, ID.tenantA, async () => {
      const visible = await migrator.query('SELECT id FROM projects WHERE id = $1', [
        ID.projectB1,
      ]);
      expect(visible.rowCount).toBe(0);
    });
  });

  it('写入与租户上下文不一致的行被拒绝', async () => {
    await rw.query('BEGIN');
    try {
      await rw.query('SELECT set_config($1, $2, true)', ['app.tenant_id', ID.tenantA]);
      await expect(
        rw.query(
          `INSERT INTO projects (id, tenant_id, code, name, updated_at)
           VALUES ($1, $2, 'BAD', '越权项目', now())`,
          [randomUUID(), ID.tenantB],
        ),
      ).rejects.toMatchObject({ code: '42501' });
    } finally {
      await rw.query('ROLLBACK').catch(() => undefined);
    }
  });

  it('所有含 tenant_id 的表都启用并强制 RLS', async () => {
    const result = await migrator.query<{
      relname: string;
      relrowsecurity: boolean;
      relforcerowsecurity: boolean;
    }>(
      `SELECT c.relname, c.relrowsecurity, c.relforcerowsecurity
         FROM pg_class c
         JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'public' AND c.relkind = 'r'
          AND EXISTS (
            SELECT 1 FROM information_schema.columns col
             WHERE col.table_schema = 'public'
               AND col.table_name = c.relname
               AND col.column_name = 'tenant_id'
          )`,
    );

    expect(result.rows.length).toBeGreaterThanOrEqual(8);
    for (const row of result.rows) {
      expect({ table: row.relname, rls: row.relrowsecurity }).toEqual({
        table: row.relname,
        rls: true,
      });
      expect({ table: row.relname, forced: row.relforcerowsecurity }).toEqual({
        table: row.relname,
        forced: true,
      });
    }
  });

  it('成员关系、角色授权与字段策略受唯一约束保护', async () => {
    await inTenant(migrator, ID.tenantA, async () => {
      await expectViolation(
        migrator,
        '23505',
        `INSERT INTO memberships (id, tenant_id, user_id, status, updated_at)
         VALUES ($1, $2, $3, 'ACTIVE', now())`,
        [randomUUID(), ID.tenantA, ID.agentA],
      );

      await expectViolation(
        migrator,
        '23505',
        `INSERT INTO membership_roles (id, tenant_id, membership_id, role_id)
         VALUES ($1, $2, $3, $4)`,
        [randomUUID(), ID.tenantA, ID.membershipAgentA, ID.roleAgentA],
      );

      await expectViolation(
        migrator,
        '23505',
        `INSERT INTO field_policies (id, tenant_id, role_id, resource, field, can_read, can_write, masked, updated_at)
         VALUES ($1, $2, $3, 'ticket', 'internalNote', true, true, false, now())`,
        [randomUUID(), ID.tenantA, ID.roleAgentA],
      );
    });
  });

  it('同一密码两次哈希结果不同且均为 Argon2id', async () => {
    const passwords = new PasswordService();
    const first = await passwords.hash('same-password');
    const second = await passwords.hash('same-password');

    expect(first).not.toBe(second);
    expect(first.startsWith('$argon2id$')).toBe(true);
    expect(second.startsWith('$argon2id$')).toBe(true);
    expect(await passwords.verify(first, 'same-password')).toBe(true);
    expect(await passwords.verify(first, 'wrong-password')).toBe(false);
  });
});

describe('I1 权限缓存变更后主动失效', () => {
  let prisma: PrismaService;

  beforeAll(() => {
    prisma = new PrismaService();
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  it('移除角色授权后，下一次求值即返回无权限（不等 TTL）', async () => {
    const cache = new PermissionCacheService(prisma);
    await cache.onModuleInit();

    try {
      expect(await cache.can(ID.tenantA, [ID.roleAgentA], 'ticket', 'read')).toBe(true);

      const admin = await connect('MIGRATE_DATABASE_URL');
      await inTenant(admin, ID.tenantA, async () => {
        await admin.query(
          `DELETE FROM role_permissions
            WHERE role_id = $1 AND resource = 'ticket' AND action = 'read'`,
          [ID.roleAgentA],
        );
      });

      await waitFor(async () => !(await cache.can(ID.tenantA, [ID.roleAgentA], 'ticket', 'read')));

      await inTenant(admin, ID.tenantA, async () => {
        await admin.query(
          `INSERT INTO role_permissions (id, tenant_id, role_id, resource, action)
           VALUES ($1, $2, $3, 'ticket', 'read')`,
          [randomUUID(), ID.tenantA, ID.roleAgentA],
        );
      });

      await waitFor(async () => cache.can(ID.tenantA, [ID.roleAgentA], 'ticket', 'read'));
    } finally {
      await cache.onModuleDestroy();
    }
  });
});

async function waitFor(predicate: () => Promise<boolean>, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error('condition not met before timeout');
}
