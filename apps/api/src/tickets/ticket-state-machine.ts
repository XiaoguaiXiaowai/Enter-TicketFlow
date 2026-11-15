import { PERMISSION, type TicketStatus } from '@ticket/shared';

import { AppException } from '../common/errors';

/**
 * 状态图是唯一事实来源：Controller 不接受直接写 status 之外的任何捷径。
 * 关闭动作额外要求 ticket:close，避免普通客服单方面结单。
 */
const TRANSITIONS: Record<TicketStatus, readonly TicketStatus[]> = {
  OPEN: ['PENDING', 'RESOLVED', 'CLOSED'],
  PENDING: ['OPEN', 'RESOLVED'],
  RESOLVED: ['OPEN', 'CLOSED'],
  CLOSED: [],
};

export class TicketStateMachine {
  static allowedTargets(from: TicketStatus): readonly TicketStatus[] {
    return TRANSITIONS[from];
  }

  static canTransition(from: TicketStatus, to: TicketStatus): boolean {
    return TRANSITIONS[from].includes(to);
  }

  static requiredPermission(to: TicketStatus): string {
    return to === 'CLOSED' ? PERMISSION.TICKET_CLOSE : PERMISSION.TICKET_UPDATE;
  }

  static requiredAction(to: TicketStatus): string {
    return to === 'CLOSED' ? 'close' : 'update';
  }

  static assertTransition(from: TicketStatus, to: TicketStatus): void {
    if (TicketStateMachine.canTransition(from, to)) {
      return;
    }
    throw new AppException(400, 'INVALID_TRANSITION', `非法状态迁移: ${from} → ${to}`, {
      from,
      to,
      allowed: TRANSITIONS[from],
    });
  }
}
