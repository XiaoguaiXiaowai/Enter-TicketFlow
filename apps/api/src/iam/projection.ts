import type { TicketResponse } from '@ticket/shared';
import { TICKET_SENSITIVE_FIELDS } from '@ticket/shared';

import type { FieldRule } from './permission-cache.service';

/**
 * 字段投影：只输出策略允许读取的字段；脱敏字段统一走同一套格式。
 * 未配置策略 = 不可读，属于默认拒绝。基字段（ticketNo、subject 等）不受字段策略影响。
 */
export function projectTicket<T extends TicketResponse>(
  source: T,
  rules: Map<string, FieldRule>,
): T {
  const result = { ...source } as unknown as Record<string, unknown>;
  const values = source as unknown as Record<string, unknown>;

  for (const field of TICKET_SENSITIVE_FIELDS) {
    delete result[field];
  }

  for (const field of TICKET_SENSITIVE_FIELDS) {
    const rule = rules.get(field);
    if (rule === undefined || !rule.canRead) {
      continue;
    }
    const value = values[field];
    if (value === undefined || value === null) {
      continue;
    }
    result[field] = rule.masked ? maskValue(field, value) : value;
  }

  return result as unknown as T;
}

export function maskPhone(value: string): string {
  const digits = value.replace(/\D/gu, '');
  if (digits.length <= 4) {
    return '****';
  }
  return `${'*'.repeat(digits.length - 4)}${digits.slice(-4)}`;
}

function maskValue(field: string, value: unknown): string | number {
  if (field === 'customerPhone' && typeof value === 'string') {
    return maskPhone(value);
  }
  return '***';
}
