import { Injectable } from '@nestjs/common';

import type { AccessTokenClaims, Actor } from '../auth/auth.types';
import { AppException } from '../common/errors';
import { PrismaService } from '../prisma/prisma.service';
import { PermissionCacheService, type FieldRule } from './permission-cache.service';

export interface AuthenticatedSession {
  actor: Actor;
}

@Injectable()
export class IamService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly cache: PermissionCacheService,
  ) {}

  /**
   * 校验 JWT 之后加载会话、成员关系与角色。
   * 会话版本不一致、已撤销、已过期、成员被禁用都返回 null（统一表现为 401）。
   */
  async loadActor(claims: AccessTokenClaims): Promise<Actor | null> {
    const data = await this.prisma.withTenant(claims.tid, async (tx) => {
      const session = await tx.session.findFirst({
        where: { id: claims.sid, tenantId: claims.tid },
      });
      if (session === null) {
        return null;
      }
      const user = await tx.user.findUnique({ where: { id: claims.sub } });
      const membership = await tx.membership.findUnique({
        where: { tenantId_userId: { tenantId: claims.tid, userId: claims.sub } },
        include: {
          roles: { include: { role: true } },
          projects: { select: { projectId: true } },
        },
      });
      const tenant = await tx.tenant.findUnique({ where: { id: claims.tid } });
      return { session, user, membership, tenant };
    });

    if (data === null) {
      return null;
    }

    const { session, user, membership, tenant } = data;
    const now = new Date();

    if (
      user === null ||
      tenant === null ||
      tenant.status !== 'ACTIVE' ||
      membership === null ||
      membership.status !== 'ACTIVE'
    ) {
      return null;
    }
    if (session.revokedAt !== null || session.expiresAt.getTime() <= now.getTime()) {
      return null;
    }
    if (session.tokenVersion !== claims.sv) {
      return null;
    }

    return {
      userId: user.id,
      email: user.email,
      sessionId: session.id,
      tenantId: tenant.id,
      tenantCode: tenant.code,
      membershipId: membership.id,
      roles: membership.roles.map(({ role }) => ({
        id: role.id,
        code: role.code,
        name: role.name,
      })),
      projectIds: membership.projects.map((row) => row.projectId),
    };
  }

  /**
   * 校验项目上下文：
   * - 项目在本租户不存在（含跨租户）：404，不暴露存在性
   * - 项目存在但未被授予当前成员：403
   */
  async assertProject(actor: Actor, projectId: string): Promise<void> {
    const project = await this.prisma.withTenant(actor.tenantId, (tx) =>
      tx.project.findFirst({ where: { id: projectId }, select: { id: true } }),
    );

    if (project === null) {
      throw AppException.notFound('PROJECT_NOT_FOUND', '项目不存在');
    }
    if (!actor.projectIds.includes(projectId)) {
      throw AppException.forbidden('PROJECT_FORBIDDEN', '无该项目访问权限');
    }
  }

  async can(actor: Actor, resource: string, action: string): Promise<boolean> {
    const roleIds = actor.roles.map((role) => role.id);
    return this.cache.can(actor.tenantId, roleIds, resource, action);
  }

  async fieldPolicies(actor: Actor, resource: string): Promise<Map<string, FieldRule>> {
    const roleIds = actor.roles.map((role) => role.id);
    return this.cache.fields(actor.tenantId, roleIds, resource);
  }

  async permissions(actor: Actor): Promise<{ resource: string; action: string }[]> {
    const roleIds = actor.roles.map((role) => role.id);
    const snapshot = await this.cache.snapshot(actor.tenantId, roleIds);
    return [...snapshot.permissions]
      .map((entry) => {
        const [resource = '', action = ''] = entry.split(':');
        return { resource, action };
      })
      .sort((left, right) => `${left.resource}:${left.action}`.localeCompare(`${right.resource}:${right.action}`));
  }

  async fieldSummaries(
    actor: Actor,
  ): Promise<{ resource: string; field: string; canRead: boolean; canWrite: boolean; masked: boolean }[]> {
    const roleIds = actor.roles.map((role) => role.id);
    const snapshot = await this.cache.snapshot(actor.tenantId, roleIds);
    const result: {
      resource: string;
      field: string;
      canRead: boolean;
      canWrite: boolean;
      masked: boolean;
    }[] = [];

    for (const [resource, fields] of snapshot.fields) {
      for (const [field, rule] of fields) {
        result.push({ resource, field, ...rule });
      }
    }

    return result.sort((left, right) =>
      `${left.resource}.${left.field}`.localeCompare(`${right.resource}.${right.field}`),
    );
  }

  async projects(
    actor: Actor,
  ): Promise<{ id: string; code: string; name: string }[]> {
    if (actor.projectIds.length === 0) {
      return [];
    }
    return this.prisma.withTenant(actor.tenantId, (tx) =>
      tx.project.findMany({
        where: { id: { in: actor.projectIds } },
        select: { id: true, code: true, name: true },
        orderBy: { code: 'asc' },
      }),
    );
  }

  async tenantSummary(
    actor: Actor,
  ): Promise<{ id: string; code: string; name: string }> {
    const tenant = await this.prisma.tenant.findUniqueOrThrow({
      where: { id: actor.tenantId },
      select: { id: true, code: true, name: true },
    });
    return tenant;
  }
}
