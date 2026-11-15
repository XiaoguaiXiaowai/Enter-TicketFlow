import { describe, expect, it } from 'vitest';

import { AppException } from '../../src/common/errors';
import { TicketStateMachine } from '../../src/tickets/ticket-state-machine';

describe('工单状态机', () => {
  it('允许 OPEN → PENDING → RESOLVED → CLOSED', () => {
    expect(TicketStateMachine.canTransition('OPEN', 'PENDING')).toBe(true);
    expect(TicketStateMachine.canTransition('PENDING', 'RESOLVED')).toBe(true);
    expect(TicketStateMachine.canTransition('RESOLVED', 'CLOSED')).toBe(true);
  });

  it('关闭状态是终态', () => {
    expect(TicketStateMachine.allowedTargets('CLOSED')).toEqual([]);
    expect(TicketStateMachine.canTransition('CLOSED', 'OPEN')).toBe(false);
  });

  it('绕过中间态或倒退到已关闭之外的状态会被拒绝', () => {
    expect(TicketStateMachine.canTransition('PENDING', 'CLOSED')).toBe(false);
    expect(TicketStateMachine.canTransition('RESOLVED', 'PENDING')).toBe(false);
  });

  it('关闭动作要求 ticket:close，其余迁移要求 ticket:update', () => {
    expect(TicketStateMachine.requiredPermission('CLOSED')).toBe('ticket:close');
    expect(TicketStateMachine.requiredPermission('PENDING')).toBe('ticket:update');
  });

  it('非法迁移抛出 400 INVALID_TRANSITION 并带上可选目标', () => {
    try {
      TicketStateMachine.assertTransition('PENDING', 'CLOSED');
      throw new Error('应当抛出异常');
    } catch (error) {
      expect(error).toBeInstanceOf(AppException);
      const exception = error as AppException;
      expect(exception.getStatus()).toBe(400);
      expect(exception.getResponse()).toMatchObject({
        code: 'INVALID_TRANSITION',
        details: { from: 'PENDING', to: 'CLOSED', allowed: ['OPEN', 'RESOLVED'] },
      });
    }
  });
});
