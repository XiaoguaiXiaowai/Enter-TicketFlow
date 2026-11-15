import { describe, expect, it } from 'vitest';

import type { TicketResponse } from '@ticket/shared';

import type { FieldRule } from '../../src/iam/permission-cache.service';
import { maskPhone, projectTicket } from '../../src/iam/projection';

const SOURCE: TicketResponse = {
  id: '5f0c4a3e-2222-4a1f-9a1b-9d0c8a7b6e51',
  ticketNo: 'SUP-1',
  subject: '无法登录后台',
  description: '输入正确密码仍提示凭证错误',
  status: 'OPEN',
  priority: 'NORMAL',
  source: 'WEB',
  customerName: '张先生',
  tags: ['登录'],
  version: 1,
  createdAt: '2026-03-01T00:00:00.000Z',
  updatedAt: '2026-03-01T00:00:00.000Z',
  customerPhone: '13800001234',
  internalNote: '内部备注',
  refundAmount: 128.5,
  assigneeId: '00000000-0000-4000-8000-000000000001',
};

function rules(entries: Record<string, FieldRule>): Map<string, FieldRule> {
  return new Map(Object.entries(entries));
}

describe('字段投影', () => {
  it('外包坐席只看到脱敏手机号，内部备注与退款金额缺失', () => {
    const projected = projectTicket(
      SOURCE,
      rules({
        customerPhone: { canRead: true, canWrite: false, masked: true },
      }),
    );

    expect(projected.customerPhone).toBe('*******1234');
    expect(projected).not.toHaveProperty('internalNote');
    expect(projected).not.toHaveProperty('refundAmount');
    expect(projected.id).toBe(SOURCE.id);
    expect(projected.ticketNo).toBe('SUP-1');
  });

  it('客服看到完整字段，但退款金额不可写不影响读取', () => {
    const projected = projectTicket(
      SOURCE,
      rules({
        customerPhone: { canRead: true, canWrite: true, masked: false },
        internalNote: { canRead: true, canWrite: true, masked: false },
        refundAmount: { canRead: true, canWrite: false, masked: false },
      }),
    );

    expect(projected.customerPhone).toBe('13800001234');
    expect(projected.internalNote).toBe('内部备注');
    expect(projected.refundAmount).toBe(128.5);
    expect(projected).not.toHaveProperty('assigneeId');
  });

  it('未配置策略的敏感字段默认缺失，基字段保留', () => {
    const projected = projectTicket(SOURCE, rules({}));
    expect(projected).not.toHaveProperty('customerPhone');
    expect(projected).not.toHaveProperty('internalNote');
    expect(projected).not.toHaveProperty('refundAmount');
    expect(projected).not.toHaveProperty('assigneeId');
    expect(projected.subject).toBe('无法登录后台');
    expect(projected.status).toBe('OPEN');
  });

  it('详情响应中的 messages 不被投影丢弃', () => {
    const projected = projectTicket(
      {
        ...SOURCE,
        messages: [
          {
            id: '00000000-0000-4000-8000-000000000002',
            seq: 1,
            visibility: 'PUBLIC' as const,
            body: '已收到',
            authorId: '00000000-0000-4000-8000-000000000003',
            createdAt: '2026-03-01T00:00:00.000Z',
          },
        ],
      },
      rules({}),
    );

    expect(projected.messages).toHaveLength(1);
    expect(projected.messages[0]?.seq).toBe(1);
  });

  it('脱敏格式统一保留后四位', () => {
    expect(maskPhone('13800001234')).toBe('*******1234');
    expect(maskPhone('1234')).toBe('****');
  });
});
