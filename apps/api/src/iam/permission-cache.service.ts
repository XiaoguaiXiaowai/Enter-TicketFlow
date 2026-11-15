import { Injectable, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import { Client } from 'pg';

import { writeLog } from '../common/logger';
import { getEnv } from '../config/runtime';
import { PrismaService } from '../prisma/prisma.service';
import { parseConnectionUrl } from '../scripts/db-connection';

export interface FieldRule {
  canRead: boolean;
  canWrite: boolean;
  masked: boolean;
}

export interface PolicySnapshot {
  permissions: Set<string>;
  fields: Map<string, Map<string, FieldRule>>;
}

const CACHE_TTL_MS = 60_000;

/**
 * 权限求值缓存：按 (租户, 角色集合) 缓存 60 秒。
 * 变更通过数据库 NOTIFY 主动失效，不等待 TTL 到期。
 */
@Injectable()
export class PermissionCacheService implements OnModuleInit, OnModuleDestroy {
  private readonly cache = new Map<string, { snapshot: PolicySnapshot; expiresAt: number }>();
  private listener: Client | null = null;

  constructor(private readonly prisma: PrismaService) {}

  async onModuleInit(): Promise<void> {
    await this.startListener();
  }

  async onModuleDestroy(): Promise<void> {
    const client = this.listener;
    this.listener = null;
    if (client !== null) {
      await client.end().catch(() => undefined);
    }
  }

  async snapshot(tenantId: string, roleIds: readonly string[]): Promise<PolicySnapshot> {
    const key = cacheKey(tenantId, roleIds);
    const cached = this.cache.get(key);
    if (cached !== undefined && cached.expiresAt > Date.now()) {
      return cached.snapshot;
    }

    const snapshot = await this.load(tenantId, roleIds);
    this.cache.set(key, { snapshot, expiresAt: Date.now() + CACHE_TTL_MS });
    return snapshot;
  }

  async can(
    tenantId: string,
    roleIds: readonly string[],
    resource: string,
    action: string,
  ): Promise<boolean> {
    const snapshot = await this.snapshot(tenantId, roleIds);
    return snapshot.permissions.has(`${resource}:${action}`);
  }

  async fields(
    tenantId: string,
    roleIds: readonly string[],
    resource: string,
  ): Promise<Map<string, FieldRule>> {
    const snapshot = await this.snapshot(tenantId, roleIds);
    return snapshot.fields.get(resource) ?? new Map();
  }

  invalidateTenant(tenantId: string): void {
    const prefix = `${tenantId}:`;
    for (const key of [...this.cache.keys()]) {
      if (key.startsWith(prefix)) {
        this.cache.delete(key);
      }
    }
  }

  /** 便于单元测试注入。 */
  clearAll(): void {
    this.cache.clear();
  }

  private async load(tenantId: string, roleIds: readonly string[]): Promise<PolicySnapshot> {
    const permissions = new Set<string>();
    const fields = new Map<string, Map<string, FieldRule>>();

    if (roleIds.length === 0) {
      return { permissions, fields };
    }

    const rows = await this.prisma.withTenant(tenantId, async (tx) => {
      const grants = await tx.rolePermission.findMany({
        where: { roleId: { in: [...roleIds] } },
        select: { resource: true, action: true },
      });
      const policies = await tx.fieldPolicy.findMany({
        where: { roleId: { in: [...roleIds] } },
        select: { resource: true, field: true, canRead: true, canWrite: true, masked: true },
      });
      return { grants, policies };
    });

    for (const grant of rows.grants) {
      permissions.add(`${grant.resource}:${grant.action}`);
    }

    for (const policy of rows.policies) {
      let byField = fields.get(policy.resource);
      if (byField === undefined) {
        byField = new Map();
        fields.set(policy.resource, byField);
      }
      const existing = byField.get(policy.field);
      if (existing === undefined) {
        byField.set(policy.field, {
          canRead: policy.canRead,
          canWrite: policy.canWrite,
          masked: policy.masked,
        });
        continue;
      }
      // 多角色取并集：任一角色可读即完整可读，仅当所有可读角色都要求脱敏才脱敏。
      const readers = existing.canRead ? 1 : 0;
      const maskedReaders = existing.canRead && existing.masked ? 1 : 0;
      const nextReaders = readers + (policy.canRead ? 1 : 0);
      const nextMaskedReaders = maskedReaders + (policy.canRead && policy.masked ? 1 : 0);
      byField.set(policy.field, {
        canRead: existing.canRead || policy.canRead,
        canWrite: existing.canWrite || policy.canWrite,
        masked: nextReaders > 0 && nextMaskedReaders === nextReaders,
      });
    }

    return { permissions, fields };
  }

  private async startListener(): Promise<void> {
    const env = getEnv();
    const target = parseConnectionUrl(env.DATABASE_URL);
    const client = new Client({
      host: target.host,
      port: target.port,
      database: target.database,
      user: target.user,
      password: target.password,
    });

    try {
      await client.connect();
      await client.query('LISTEN policy_changed');
      client.on('notification', (message) => {
        const tenantId = message.payload;
        if (typeof tenantId === 'string' && tenantId.length > 0) {
          this.invalidateTenant(tenantId);
        }
      });
      client.on('error', (error: unknown) => {
        writeLog('warn', 'policy cache listener error', {
          error: error instanceof Error ? error.message : String(error),
        });
      });
      this.listener = client;
    } catch (error: unknown) {
      await client.end().catch(() => undefined);
      writeLog('warn', 'policy cache listener unavailable', {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
}

function cacheKey(tenantId: string, roleIds: readonly string[]): string {
  return `${tenantId}:${[...roleIds].sort().join(',')}`;
}
