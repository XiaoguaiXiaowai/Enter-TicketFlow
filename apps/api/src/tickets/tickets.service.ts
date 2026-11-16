import { Injectable } from '@nestjs/common';
import type { Prisma, Ticket as PrismaTicket, TicketMessage as PrismaTicketMessage } from '@prisma/client';

import {
  PERMISSION,
  RESOURCE,
  type AppendMessageResponse,
  type TicketAuditEntry,
  type TicketAuditResponse,
  type TicketDetailResponse,
  type TicketListQuery,
  type TicketListResponse,
  type TicketMessageResponse,
  type TicketResponse,
} from '@ticket/shared';

import type { Actor } from '../auth/auth.types';
import { AuditService } from '../audit/audit.service';
import { AppException } from '../common/errors';
import { IamService } from '../iam/iam.service';
import type { FieldRule } from '../iam/permission-cache.service';
import { projectTicket } from '../iam/projection';
import { IdempotencyService, type BeginResult } from '../idempotency/idempotency.service';
import { KnowledgeService } from '../knowledge/knowledge.service';
import { OutboxService } from '../outbox/outbox.service';
import { PrismaService } from '../prisma/prisma.service';
import type { AppendMessageDto, CreateTicketDto, UpdateTicketDto } from './ticket.dto';
import { TicketStateMachine } from './ticket-state-machine';

export interface RequestMeta {
  requestId: string;
  ip: string | null;
}

export interface TicketContext {
  actor: Actor;
  projectId: string;
  meta: RequestMeta;
}

export interface MutationResult<T> {
  statusCode: number;
  replay: boolean;
  body: T;
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const DETAIL_MESSAGE_LIMIT = 50;
const AUDIT_LIMIT = 200;

@Injectable()
export class TicketsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly iam: IamService,
    private readonly idempotency: IdempotencyService,
    private readonly audit: AuditService,
    private readonly outbox: OutboxService,
    private readonly knowledge: KnowledgeService,
  ) {}

  async create(
    ctx: TicketContext,
    dto: CreateTicketDto,
    idempotencyKey: string,
  ): Promise<MutationResult<TicketResponse>> {
    const { actor, projectId, meta } = ctx;
    const rules = await this.iam.fieldPolicies(actor, RESOURCE.TICKET);
    assertSensitiveWrites(rules, dto, ['customerPhone', 'assigneeId']);

    const requestHash = this.idempotency.hashRequest({
      endpoint: 'POST /v1/tickets',
      tenantId: actor.tenantId,
      projectId,
      actorId: actor.userId,
      body: dto,
    });

    return this.prisma.withTenant(actor.tenantId, async (tx) => {
      const reservation = await this.idempotency.begin(tx, {
        tenantId: actor.tenantId,
        key: idempotencyKey,
        endpoint: 'POST /v1/tickets',
        requestHash,
      });

      const replay = replayResponse<TicketResponse>(reservation);
      if (replay !== null) {
        return replay;
      }
      const reservationId = requireReservation(reservation);

      const project = await tx.project.findFirst({
        where: { id: projectId },
        select: { id: true, code: true },
      });
      if (project === null) {
        throw AppException.notFound('PROJECT_NOT_FOUND', '项目不存在');
      }

      const ticketNo = await allocateTicketNo(tx, actor.tenantId, projectId, project.code);
      const row = await tx.ticket.create({
        data: {
          tenantId: actor.tenantId,
          projectId,
          ticketNo,
          subject: dto.subject,
          description: dto.description,
          priority: dto.priority ?? 'NORMAL',
          source: dto.source ?? 'WEB',
          customerName: dto.customerName,
          customerPhone: dto.customerPhone ?? null,
          assigneeId: dto.assigneeId ?? null,
          tags: dto.tags ?? [],
          createdBy: actor.userId,
        },
      });

      const after = auditSnapshot(row);
      await this.audit.record(tx, {
        tenantId: actor.tenantId,
        projectId,
        resource: RESOURCE.TICKET,
        resourceId: row.id,
        action: 'CREATE',
        actorId: actor.userId,
        requestId: meta.requestId,
        ip: meta.ip,
        before: null,
        after,
        changedFields: Object.keys(after),
      });

      await this.outbox.enqueue(tx, {
        tenantId: actor.tenantId,
        type: 'ticket.created',
        payload: {
          ticketId: row.id,
          ticketNo: row.ticketNo,
          projectId,
          subject: row.subject,
        },
      });

      const body = projectTicket(toTicketResponse(row), rules);
      await this.idempotency.complete(tx, reservationId, 201, body);
      return { statusCode: 201, replay: false, body };
    });
  }

  async list(ctx: TicketContext, query: TicketListQuery): Promise<TicketListResponse> {
    const { actor, projectId } = ctx;
    const rules = await this.iam.fieldPolicies(actor, RESOURCE.TICKET);
    const limit = query.limit ?? 20;
    const cursor = query.cursor === undefined ? null : decodeCursor(query.cursor);

    const rows = await this.prisma.withTenant(actor.tenantId, (tx) =>
      tx.ticket.findMany({
        where: {
          projectId,
          ...(query.status === undefined ? {} : { status: query.status }),
          ...(query.assigneeId === undefined ? {} : { assigneeId: query.assigneeId }),
          ...(cursor === null
            ? {}
            : {
                OR: [
                  { updatedAt: { lt: cursor.updatedAt } },
                  { updatedAt: cursor.updatedAt, id: { lt: cursor.id } },
                ],
              }),
        },
        orderBy: [{ updatedAt: 'desc' }, { id: 'desc' }],
        take: limit + 1,
      }),
    );

    const hasMore = rows.length > limit;
    const page = hasMore ? rows.slice(0, limit) : rows;
    const last = page[page.length - 1];

    return {
      items: page.map((row) => projectTicket(toTicketResponse(row), rules)),
      nextCursor: hasMore && last !== undefined ? encodeCursor(last) : null,
    };
  }

  async detail(ctx: TicketContext, id: string): Promise<TicketDetailResponse> {
    const { actor, projectId } = ctx;
    assertUuid(id);

    const rules = await this.iam.fieldPolicies(actor, RESOURCE.TICKET);
    const canReadInternal = await this.iam.can(actor, RESOURCE.TICKET, 'note');

    const data = await this.prisma.withTenant(actor.tenantId, async (tx) => {
      const row = await tx.ticket.findFirst({ where: { id, projectId } });
      if (row === null) {
        throw AppException.notFound('TICKET_NOT_FOUND', '工单不存在');
      }
      const messages = await tx.ticketMessage.findMany({
        where: {
          ticketId: row.id,
          ...(canReadInternal ? {} : { visibility: 'PUBLIC' }),
        },
        orderBy: { seq: 'asc' },
        take: DETAIL_MESSAGE_LIMIT,
      });
      return { row, messages };
    });

    return projectTicket(
      {
        ...toTicketResponse(data.row),
        messages: data.messages.map(toMessageResponse),
      },
      rules,
    );
  }

  async update(
    ctx: TicketContext,
    id: string,
    ifMatch: string | undefined,
    dto: UpdateTicketDto,
  ): Promise<TicketResponse> {
    const { actor, projectId, meta } = ctx;
    assertUuid(id);
    const expectedVersion = parseIfMatch(ifMatch);
    const rules = await this.iam.fieldPolicies(actor, RESOURCE.TICKET);
    assertSensitiveWrites(rules, dto, ['customerPhone', 'internalNote', 'refundAmount', 'assigneeId']);

    return this.prisma.withTenant(actor.tenantId, async (tx) => {
      const current = await tx.ticket.findFirst({ where: { id, projectId } });
      if (current === null) {
        throw AppException.notFound('TICKET_NOT_FOUND', '工单不存在');
      }

      if (dto.status !== undefined && dto.status !== current.status) {
        TicketStateMachine.assertTransition(current.status, dto.status);
        const required = TicketStateMachine.requiredPermission(dto.status);
        const allowed = await this.iam.can(
          actor,
          RESOURCE.TICKET,
          TicketStateMachine.requiredAction(dto.status),
        );
        if (!allowed) {
          throw AppException.forbidden(
            'FORBIDDEN',
            `缺少权限: ${required}`,
            { permission: required },
          );
        }
      }

      const data = buildUpdateData(current, dto);
      if (Object.keys(data).length === 0) {
        throw AppException.validation('至少提交一个可更新字段');
      }

      const result = await tx.ticket.updateMany({
        where: { id, projectId, version: expectedVersion },
        data: { ...data, version: { increment: 1 } },
      });

      if (result.count === 0) {
        const latest = await tx.ticket.findFirst({
          where: { id, projectId },
          select: { version: true },
        });
        if (latest === null) {
          throw AppException.notFound('TICKET_NOT_FOUND', '工单不存在');
        }
        throw AppException.conflict('VERSION_CONFLICT', '工单已被他人更新，请刷新后重试', {
          currentVersion: latest.version,
        });
      }

      const updated = await tx.ticket.findFirstOrThrow({ where: { id, projectId } });
      const changes = diffForAudit(current, updated, Object.keys(data));
      if (changes.changedFields.length > 0) {
        await this.audit.record(tx, {
          tenantId: actor.tenantId,
          projectId,
          resource: RESOURCE.TICKET,
          resourceId: id,
          action: 'UPDATE',
          actorId: actor.userId,
          requestId: meta.requestId,
          ip: meta.ip,
          before: changes.before,
          after: changes.after,
          changedFields: changes.changedFields,
        });
      }

      return projectTicket(toTicketResponse(updated), rules);
    });
  }

  async appendMessage(
    ctx: TicketContext,
    id: string,
    idempotencyKey: string,
    dto: AppendMessageDto,
  ): Promise<MutationResult<AppendMessageResponse>> {
    const { actor, projectId } = ctx;
    assertUuid(id);
    if (dto.templateId === undefined && dto.templateVariables !== undefined) {
      throw AppException.validation('templateVariables 需要与 templateId 同时提供');
    }

    const endpoint = `POST /v1/tickets/${id}/messages`;
    const requestHash = this.idempotency.hashRequest({
      endpoint,
      tenantId: actor.tenantId,
      projectId,
      actorId: actor.userId,
      body: dto,
    });

    return this.prisma.withTenant(actor.tenantId, async (tx) => {
      const reservation = await this.idempotency.begin(tx, {
        tenantId: actor.tenantId,
        key: idempotencyKey,
        endpoint,
        requestHash,
      });

      const replay = replayResponse<AppendMessageResponse>(reservation);
      if (replay !== null) {
        return replay;
      }
      const reservationId = requireReservation(reservation);

      const ticket = await tx.ticket.findFirst({
        where: { id, projectId },
        select: { id: true, status: true },
      });
      if (ticket === null) {
        throw AppException.notFound('TICKET_NOT_FOUND', '工单不存在');
      }
      if (ticket.status === 'CLOSED') {
        throw AppException.conflict('TICKET_CLOSED', '工单已关闭，不能追加消息');
      }
      if (dto.visibility === 'INTERNAL') {
        const canNote = await this.iam.can(actor, RESOURCE.TICKET, 'note');
        if (!canNote) {
          throw AppException.forbidden('FORBIDDEN', `缺少权限: ${PERMISSION.TICKET_NOTE}`, {
            permission: PERMISSION.TICKET_NOTE,
          });
        }
      }

      const messageBody =
        dto.templateId === undefined
          ? dto.body
          : await this.knowledge.renderForMessage(
              tx,
              projectId,
              dto.templateId,
              dto.templateVariables ?? {},
            );

      const seqRows = await tx.$queryRaw<{ message_seq: number }[]>`
        UPDATE "tickets"
           SET "message_seq" = "message_seq" + 1
         WHERE "id" = ${id}::uuid AND "project_id" = ${projectId}::uuid
         RETURNING "message_seq"
      `;
      const seq = seqRows[0]?.message_seq;
      if (seq === undefined) {
        throw AppException.notFound('TICKET_NOT_FOUND', '工单不存在');
      }

      const message = await tx.ticketMessage.create({
        data: {
          tenantId: actor.tenantId,
          ticketId: id,
          seq,
          visibility: dto.visibility,
          body: messageBody,
          authorId: actor.userId,
        },
      });

      await this.outbox.enqueue(tx, {
        tenantId: actor.tenantId,
        type: 'ticket.message.created',
        payload: {
          ticketId: id,
          messageId: message.id,
          seq: message.seq,
          visibility: message.visibility,
          projectId,
        },
      });

      const body: AppendMessageResponse = {
        id: message.id,
        seq: message.seq,
        visibility: message.visibility,
        createdAt: message.createdAt.toISOString(),
      };
      await this.idempotency.complete(tx, reservationId, 201, body);
      return { statusCode: 201, replay: false, body };
    });
  }

  async auditTrail(ctx: TicketContext, id: string): Promise<TicketAuditResponse> {
    const { actor, projectId } = ctx;
    assertUuid(id);

    return this.prisma.withTenant(actor.tenantId, async (tx) => {
      const ticket = await tx.ticket.findFirst({
        where: { id, projectId },
        select: { id: true, assigneeId: true, createdBy: true },
      });
      if (ticket === null) {
        throw AppException.notFound('TICKET_NOT_FOUND', '工单不存在');
      }

      const readAll = await this.iam.can(actor, RESOURCE.AUDIT, 'read_all');
      const handled = ticket.assigneeId === actor.userId || ticket.createdBy === actor.userId;
      if (!readAll && !handled) {
        throw AppException.forbidden('AUDIT_FORBIDDEN', '只能查看自己经手工单的审计记录');
      }

      const rows = await tx.auditLog.findMany({
        where: { resource: RESOURCE.TICKET, resourceId: id },
        orderBy: { createdAt: 'asc' },
        take: AUDIT_LIMIT,
      });

      return {
        items: rows.map(
          (row): TicketAuditEntry => ({
            id: row.id,
            action: row.action as TicketAuditEntry['action'],
            actorId: row.actorId,
            requestId: row.requestId,
            ip: row.ip,
            before: (row.before as Record<string, unknown> | null) ?? null,
            after: (row.after as Record<string, unknown> | null) ?? null,
            changedFields: row.changedFields,
            createdAt: row.createdAt.toISOString(),
          }),
        ),
      };
    });
  }
}

async function allocateTicketNo(
  tx: Prisma.TransactionClient,
  tenantId: string,
  projectId: string,
  projectCode: string,
): Promise<string> {
  const rows = await tx.$queryRaw<{ next_value: number }[]>`
    INSERT INTO "ticket_counters" ("tenant_id", "project_id", "next_value", "updated_at")
    VALUES (${tenantId}::uuid, ${projectId}::uuid, 2, now())
    ON CONFLICT ("tenant_id", "project_id")
    DO UPDATE SET "next_value" = "ticket_counters"."next_value" + 1, "updated_at" = now()
    RETURNING "next_value" - 1 AS "next_value"
  `;
  const sequence = rows[0]?.next_value;
  if (sequence === undefined) {
    throw new Error('无法分配工单号');
  }
  return `${projectCode}-${sequence}`;
}

function toTicketResponse(row: PrismaTicket): TicketResponse {
  return {
    id: row.id,
    ticketNo: row.ticketNo,
    subject: row.subject,
    description: row.description,
    status: row.status,
    priority: row.priority,
    source: row.source,
    customerName: row.customerName,
    tags: row.tags,
    version: row.version,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    ...(row.customerPhone === null ? {} : { customerPhone: row.customerPhone }),
    ...(row.internalNote === null ? {} : { internalNote: row.internalNote }),
    ...(row.refundAmount === null ? {} : { refundAmount: Number(row.refundAmount) }),
    ...(row.assigneeId === null ? {} : { assigneeId: row.assigneeId }),
  };
}

function toMessageResponse(row: PrismaTicketMessage): TicketMessageResponse {
  return {
    id: row.id,
    seq: row.seq,
    visibility: row.visibility,
    body: row.body,
    authorId: row.authorId,
    createdAt: row.createdAt.toISOString(),
  };
}

function assertSensitiveWrites(
  rules: Map<string, FieldRule>,
  dto: object,
  fields: string[],
): void {
  const values = dto as Record<string, unknown>;
  const denied = fields.filter((field) => {
    const value = values[field];
    return value !== undefined && rules.get(field)?.canWrite !== true;
  });
  if (denied.length > 0) {
    throw AppException.forbidden('FIELD_DENIED', `字段不可写: ${denied.join(', ')}`, {
      fields: denied.map((field) => ({ field })),
    });
  }
}

function assertUuid(id: string): void {
  if (!UUID_PATTERN.test(id)) {
    throw AppException.validation('工单 ID 格式不合法');
  }
}

function parseIfMatch(header: string | undefined): number {
  if (header === undefined || header.trim() === '') {
    throw AppException.preconditionRequired();
  }
  const raw = header.trim().replace(/^W\//u, '').replace(/^"|"$/gu, '');
  if (!/^\d+$/u.test(raw)) {
    throw AppException.preconditionRequired('IF_MATCH_INVALID', 'If-Match 必须是工单版本号');
  }
  return Number(raw);
}

function buildUpdateData(
  current: PrismaTicket,
  dto: UpdateTicketDto,
): Prisma.TicketUpdateManyMutationInput {
  const data: Prisma.TicketUpdateManyMutationInput = {};

  if (dto.status !== undefined && dto.status !== current.status) {
    data.status = dto.status;
  }
  if (dto.priority !== undefined) {
    data.priority = dto.priority;
  }
  if (dto.assigneeId !== undefined) {
    data.assigneeId = dto.assigneeId;
  }
  if (dto.tags !== undefined) {
    data.tags = dto.tags;
  }
  if (dto.internalNote !== undefined) {
    data.internalNote = dto.internalNote;
  }
  if (dto.refundAmount !== undefined) {
    data.refundAmount = dto.refundAmount;
  }
  if (dto.customerPhone !== undefined) {
    data.customerPhone = dto.customerPhone;
  }

  return data;
}

function auditSnapshot(row: PrismaTicket): Record<string, unknown> {
  return {
    ticketNo: row.ticketNo,
    subject: row.subject,
    description: row.description,
    status: row.status,
    priority: row.priority,
    source: row.source,
    customerName: row.customerName,
    customerPhone: row.customerPhone,
    assigneeId: row.assigneeId,
    tags: row.tags,
  };
}

function diffForAudit(
  before: PrismaTicket,
  after: PrismaTicket,
  fields: string[],
): {
  before: Record<string, unknown>;
  after: Record<string, unknown>;
  changedFields: string[];
} {
  const beforeValues: Record<string, unknown> = {};
  const afterValues: Record<string, unknown> = {};
  const changedFields: string[] = [];
  const beforeRecord = before as unknown as Record<string, unknown>;
  const afterRecord = after as unknown as Record<string, unknown>;

  for (const field of fields) {
    const beforeValue = normalizeAuditValue(beforeRecord[field]);
    const afterValue = normalizeAuditValue(afterRecord[field]);
    if (JSON.stringify(beforeValue) === JSON.stringify(afterValue)) {
      continue;
    }
    changedFields.push(field);
    beforeValues[field] = beforeValue;
    afterValues[field] = afterValue;
  }

  return { before: beforeValues, after: afterValues, changedFields };
}

function normalizeAuditValue(value: unknown): unknown {
  if (value !== null && typeof value === 'object' && 'toNumber' in value) {
    return Number((value as { toNumber: () => number }).toNumber());
  }
  return value;
}

interface Cursor {
  updatedAt: Date;
  id: string;
}

function encodeCursor(row: PrismaTicket): string {
  return Buffer.from(`${row.updatedAt.toISOString()}|${row.id}`, 'utf8').toString('base64url');
}

function decodeCursor(raw: string): Cursor {
  let decoded: string;
  try {
    decoded = Buffer.from(raw, 'base64url').toString('utf8');
  } catch {
    throw AppException.validation('cursor 不合法');
  }
  const separator = decoded.lastIndexOf('|');
  const iso = decoded.slice(0, separator);
  const id = decoded.slice(separator + 1);
  const updatedAt = new Date(iso);
  if (separator < 0 || Number.isNaN(updatedAt.getTime()) || !UUID_PATTERN.test(id)) {
    throw AppException.validation('cursor 不合法');
  }
  return { updatedAt, id };
}

function replayResponse<T>(reservation: BeginResult): MutationResult<T> | null {
  if (reservation.kind === 'replay') {
    return { statusCode: 200, replay: true, body: reservation.snapshot as T };
  }
  if (reservation.kind === 'conflict') {
    throw AppException.conflict('IDEMPOTENCY_KEY_REUSED', '同一 Idempotency-Key 不能用于不同的请求体');
  }
  if (reservation.kind === 'in_progress') {
    throw AppException.conflict('IDEMPOTENCY_IN_PROGRESS', '相同 Idempotency-Key 的请求正在处理中，请稍后重试');
  }
  return null;
}

function requireReservation(reservation: BeginResult): string {
  if (reservation.kind !== 'reserved') {
    throw new Error('幂等键未成功占位');
  }
  return reservation.id;
}
