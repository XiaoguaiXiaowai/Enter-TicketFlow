import { Injectable } from '@nestjs/common';
import type { Prisma } from '@prisma/client';

export interface OutboxEventInput {
  tenantId: string;
  type: string;
  payload: Record<string, unknown>;
}

/**
 * I2 只负责与业务数据同事务落表；投递与重试在 I4 的 Worker 中实现。
 */
@Injectable()
export class OutboxService {
  async enqueue(tx: Prisma.TransactionClient, event: OutboxEventInput): Promise<void> {
    await tx.outboxEvent.create({
      data: {
        tenantId: event.tenantId,
        type: event.type,
        payload: event.payload as Prisma.InputJsonValue,
      },
    });
  }
}
