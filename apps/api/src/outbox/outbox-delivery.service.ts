import { Injectable } from '@nestjs/common';
import type { Prisma } from '@prisma/client';

import { writeLog } from '../common/logger';
import { getEnv } from '../config/runtime';

export interface OutboxDeliveryEvent {
  id: string;
  tenantId: string;
  type: string;
  payload: Prisma.JsonValue;
  attempts: number;
}

/**
 * 投递适配器：配置 OUTBOX_WEBHOOK_URL 时以 HTTP 通知下游，否则仅记录日志。
 * 超时与幂等由下游按事件 id 兜底，这里只保证失败可见。
 */
@Injectable()
export class OutboxDeliveryService {
  async deliver(event: OutboxDeliveryEvent): Promise<void> {
    const url = getEnv().OUTBOX_WEBHOOK_URL;
    if (url === undefined) {
      writeLog('debug', 'outbox event dispatched', { eventId: event.id, type: event.type });
      return;
    }

    const response = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-event-type': event.type },
      body: JSON.stringify({
        id: event.id,
        tenantId: event.tenantId,
        type: event.type,
        payload: event.payload,
      }),
      signal: AbortSignal.timeout(3_000),
    });

    if (!response.ok) {
      throw new Error(`webhook responded with ${response.status}`);
    }
  }
}