import { createHash } from 'node:crypto';

import { Injectable } from '@nestjs/common';
import type { Prisma } from '@prisma/client';

const TTL_HOURS = 24;

export type BeginResult =
  | { kind: 'reserved'; id: string }
  | { kind: 'replay'; statusCode: number; snapshot: unknown }
  | { kind: 'conflict' }
  | { kind: 'in_progress' };

export interface BeginParams {
  tenantId: string;
  key: string;
  endpoint: string;
  requestHash: string;
}

/**
 * 幂等键占位与业务写入必须在同一事务内。
 * 占位使用 INSERT ... ON CONFLICT DO NOTHING：并发同键请求会阻塞到第一个事务结束，
 * 提交后读到 COMPLETED 并回放快照，回滚后则由第二个请求插入成功。
 */
@Injectable()
export class IdempotencyService {
  hashRequest(parts: unknown): string {
    return createHash('sha256').update(JSON.stringify(parts)).digest('hex');
  }

  async begin(tx: Prisma.TransactionClient, params: BeginParams): Promise<BeginResult> {
    const reserved = await tx.$queryRaw<{ id: string }[]>`
      INSERT INTO "idempotency_keys" ("id", "tenant_id", "key", "endpoint", "request_hash", "status", "expires_at", "updated_at")
      VALUES (gen_random_uuid(), ${params.tenantId}::uuid, ${params.key}, ${params.endpoint}, ${params.requestHash}, 'PENDING', now() + interval '24 hours', now())
      ON CONFLICT ("tenant_id", "key") DO NOTHING
      RETURNING "id"
    `;
    const reservedRow = reserved[0];
    if (reservedRow !== undefined) {
      return { kind: 'reserved', id: reservedRow.id };
    }

    const existing = await tx.idempotencyKey.findFirst({
      where: { key: params.key },
    });
    if (existing === null) {
      // 唯一索引冲突后仍读不到记录，只能是并发删除；让客户端重试。
      return { kind: 'in_progress' };
    }

    if (existing.expiresAt.getTime() <= Date.now()) {
      await tx.$executeRaw`
        UPDATE "idempotency_keys"
           SET "endpoint" = ${params.endpoint},
               "request_hash" = ${params.requestHash},
               "status" = 'PENDING',
               "response_snapshot" = NULL,
               "status_code" = NULL,
               "expires_at" = now() + interval '24 hours',
               "updated_at" = now()
         WHERE "id" = ${existing.id}::uuid
      `;
      return { kind: 'reserved', id: existing.id };
    }

    if (existing.endpoint !== params.endpoint || existing.requestHash !== params.requestHash) {
      return { kind: 'conflict' };
    }
    if (existing.status === 'COMPLETED') {
      return {
        kind: 'replay',
        statusCode: existing.statusCode ?? 200,
        snapshot: existing.responseSnapshot,
      };
    }
    return { kind: 'in_progress' };
  }

  async complete(
    tx: Prisma.TransactionClient,
    id: string,
    statusCode: number,
    snapshot: unknown,
  ): Promise<void> {
    await tx.idempotencyKey.update({
      where: { id },
      data: {
        status: 'COMPLETED',
        statusCode,
        responseSnapshot: snapshot as Prisma.InputJsonValue,
      },
    });
  }
}

export { TTL_HOURS };
