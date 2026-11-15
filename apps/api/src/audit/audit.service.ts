import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';

import type { AuditAction } from '@ticket/shared';

export interface AuditEntry {
  tenantId: string;
  projectId: string | null;
  resource: string;
  resourceId: string;
  action: AuditAction;
  actorId: string;
  requestId: string;
  ip: string | null;
  before: Record<string, unknown> | null;
  after: Record<string, unknown> | null;
  changedFields: string[];
}

/**
 * 审计只追加，且必须与业务写入使用同一事务客户端：
 * 业务回滚时审计一并回滚，不会留下"变更已发生但审计不可查"或相反的情况。
 */
@Injectable()
export class AuditService {
  async record(tx: Prisma.TransactionClient, entry: AuditEntry): Promise<void> {
    await tx.auditLog.create({
      data: {
        tenantId: entry.tenantId,
        projectId: entry.projectId,
        resource: entry.resource,
        resourceId: entry.resourceId,
        action: entry.action,
        actorId: entry.actorId,
        requestId: entry.requestId,
        ip: entry.ip,
        before: (entry.before ?? Prisma.JsonNull) as Prisma.InputJsonValue,
        after: (entry.after ?? Prisma.JsonNull) as Prisma.InputJsonValue,
        changedFields: entry.changedFields,
      },
    });
  }
}
