import { readdirSync } from 'node:fs';
import { resolve } from 'node:path';

import { Client, type ClientConfig } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

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

function expectedMigrations(): string[] {
  return readdirSync(resolve(process.cwd(), 'prisma/migrations'), { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
}

const clients: Client[] = [];

async function connect(envName: string): Promise<Client> {
  const client = new Client(clientConfig(requireEnv(envName)));
  await client.connect();
  clients.push(client);
  return client;
}

afterAll(async () => {
  await Promise.all(clients.map((client) => client.end().catch(() => undefined)));
});

describe('数据库迁移与角色隔离', () => {
  let rw: Client;
  let migrator: Client;
  let worker: Client;

  beforeAll(async () => {
    rw = await connect('DATABASE_URL');
    migrator = await connect('MIGRATE_DATABASE_URL');
    worker = await connect('WORKER_DATABASE_URL');
  });

  it('迁移全部执行完成', async () => {
    const result = await migrator.query<{ migration_name: string }>(
      'SELECT migration_name FROM _prisma_migrations WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL',
    );
    const applied = result.rows.map((row) => row.migration_name).sort();
    expect(applied).toEqual(expectedMigrations());
  });

  it('三个角色均可连接', async () => {
    for (const client of [rw, migrator, worker]) {
      const result = await client.query<{ ok: number }>('SELECT 1 AS ok');
      expect(result.rows[0]?.ok).toBe(1);
    }
  });

  it('app_rw 执行 DDL 被拒绝', async () => {
    await expect(
      rw.query('CREATE TABLE i0_ddl_probe (id integer PRIMARY KEY)'),
    ).rejects.toMatchObject({ code: '42501' });
  });

  it('app_rw 无超级用户与绕过 RLS 权限', async () => {
    const result = await rw.query<{ rolsuper: boolean; rolbypassrls: boolean }>(
      'SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user',
    );
    expect(result.rows[0]).toEqual({ rolsuper: false, rolbypassrls: false });
  });
});
