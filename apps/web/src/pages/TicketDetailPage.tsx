import { useCallback, useEffect, useRef, useState } from 'react';
import { Link, useParams, useSearchParams } from 'react-router-dom';

import type {
  MessageVisibility,
  TicketAuditEntry,
  TicketDetailResponse,
  TicketPriority,
  TicketStatus,
  UpdateTicketRequest,
} from '@ticket/shared';
import { useAuth } from '../auth/AuthContext';
import {
  ApiError,
  appendTicketMessage,
  fetchTicket,
  fetchTicketAudit,
  newIdempotencyKey,
  updateTicket,
} from '../lib/api';

const STATUS_LABELS: Record<TicketStatus, string> = {
  OPEN: '待处理',
  PENDING: '处理中',
  RESOLVED: '已解决',
  CLOSED: '已关闭',
};

const STATUS_TRANSITIONS: Record<TicketStatus, TicketStatus[]> = {
  OPEN: ['PENDING', 'RESOLVED', 'CLOSED'],
  PENDING: ['OPEN', 'RESOLVED'],
  RESOLVED: ['OPEN', 'CLOSED'],
  CLOSED: [],
};

const PRIORITIES: TicketPriority[] = ['LOW', 'NORMAL', 'HIGH', 'URGENT'];

type LoadState =
  | { kind: 'loading' }
  | { kind: 'ready'; ticket: TicketDetailResponse }
  | { kind: 'error'; status: number; code: string };

interface Drafts {
  status: TicketStatus;
  priority: TicketPriority;
  tags: string;
  refund: string;
  note: string;
}

function draftsOf(ticket: TicketDetailResponse): Drafts {
  return {
    status: ticket.status,
    priority: ticket.priority,
    tags: ticket.tags.join(','),
    refund: ticket.refundAmount === undefined ? '' : String(ticket.refundAmount),
    note: ticket.internalNote ?? '',
  };
}

function parseTags(raw: string): string[] {
  return raw
    .split(/[,，]/u)
    .map((tag) => tag.trim())
    .filter((tag) => tag !== '');
}

export function TicketDetailPage() {
  const { ticketId = '' } = useParams<{ ticketId: string }>();
  const [searchParams] = useSearchParams();
  const {
    session,
    projectId,
    hasPermission,
    canWriteField,
  } = useAuth();
  const effectiveProjectId = searchParams.get('projectId') ?? projectId;

  const [state, setState] = useState<LoadState>({ kind: 'loading' });
  const [drafts, setDrafts] = useState<Drafts | null>(null);
  const [reloadToken, setReloadToken] = useState(0);
  const [saving, setSaving] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [conflictVersion, setConflictVersion] = useState<number | null>(null);
  const [audit, setAudit] = useState<TicketAuditEntry[]>([]);
  const [messageBody, setMessageBody] = useState('');
  const [visibility, setVisibility] = useState<MessageVisibility>('PUBLIC');
  const [sending, setSending] = useState(false);
  const [messageError, setMessageError] = useState<string | null>(null);
  const messageKey = useRef(newIdempotencyKey());

  const canReadAudit = hasPermission('audit', 'read');

  const refresh = useCallback(
    async (syncDrafts: boolean): Promise<TicketDetailResponse | null> => {
      if (effectiveProjectId === null) {
        setState({ kind: 'error', status: 400, code: 'PROJECT_REQUIRED' });
        return null;
      }
      try {
        const ticket = await fetchTicket(ticketId, effectiveProjectId);
        setState({ kind: 'ready', ticket });
        if (syncDrafts) {
          setDrafts(draftsOf(ticket));
        }
        if (canReadAudit) {
          try {
            const trail = await fetchTicketAudit(ticketId, effectiveProjectId);
            setAudit(trail.items);
          } catch {
            setAudit([]);
          }
        }
        return ticket;
      } catch (caught: unknown) {
        if (caught instanceof ApiError) {
          setState({ kind: 'error', status: caught.status, code: caught.code });
        } else {
          setState({ kind: 'error', status: 0, code: 'NETWORK_ERROR' });
        }
        return null;
      }
    },
    [ticketId, effectiveProjectId, canReadAudit],
  );

  useEffect(() => {
    setState({ kind: 'loading' });
    void refresh(true);
  }, [refresh, reloadToken]);

  const ticket = state.kind === 'ready' ? state.ticket : null;

  const canUpdate = hasPermission('ticket', 'update');
  const canReply = hasPermission('ticket', 'reply');
  const canNote = hasPermission('ticket', 'note');
  const canEditRefund = canWriteField('ticket', 'refundAmount');
  const canEditNote = canNote && canWriteField('ticket', 'internalNote');
  const canAssign = canWriteField('ticket', 'assigneeId');

  const dirty =
    ticket !== null &&
    drafts !== null &&
    (drafts.status !== ticket.status ||
      drafts.priority !== ticket.priority ||
      JSON.stringify(parseTags(drafts.tags)) !== JSON.stringify(ticket.tags) ||
      (canEditRefund &&
        drafts.refund !== (ticket.refundAmount === undefined ? '' : String(ticket.refundAmount))) ||
      (canEditNote && drafts.note !== (ticket.internalNote ?? '')));

  async function save(): Promise<void> {
    if (ticket === null || drafts === null || effectiveProjectId === null || saving) {
      return;
    }
    const payload: UpdateTicketRequest = {};
    if (drafts.status !== ticket.status) {
      payload.status = drafts.status;
    }
    if (drafts.priority !== ticket.priority) {
      payload.priority = drafts.priority;
    }
    const tags = parseTags(drafts.tags);
    if (JSON.stringify(tags) !== JSON.stringify(ticket.tags)) {
      payload.tags = tags;
    }
    if (canEditRefund) {
      const current = ticket.refundAmount === undefined ? '' : String(ticket.refundAmount);
      if (drafts.refund !== current) {
        payload.refundAmount = drafts.refund === '' ? null : Number(drafts.refund);
      }
    }
    if (canEditNote && drafts.note !== (ticket.internalNote ?? '')) {
      payload.internalNote = drafts.note === '' ? null : drafts.note;
    }
    if (Object.keys(payload).length === 0) {
      setActionError('没有需要保存的变更');
      return;
    }

    setSaving(true);
    setActionError(null);
    setConflictVersion(null);
    try {
      const updated = await updateTicket(ticketId, effectiveProjectId, payload, ticket.version);
      setState({ kind: 'ready', ticket: { ...updated, messages: ticket.messages } });
      setDrafts(draftsOf({ ...updated, messages: ticket.messages }));
    } catch (caught: unknown) {
      if (caught instanceof ApiError && caught.status === 409 && caught.code === 'VERSION_CONFLICT') {
        const details = caught.details as { currentVersion?: number } | undefined;
        setConflictVersion(details?.currentVersion ?? null);
        // 拉取最新数据，但保留用户草稿，便于确认后重新保存。
        await refresh(false);
      } else {
        setActionError(
          caught instanceof ApiError
            ? `${caught.message}（${caught.code}）`
            : '网络异常，请稍后重试',
        );
      }
    } finally {
      setSaving(false);
    }
  }

  async function assignToMe(): Promise<void> {
    if (ticket === null || session === null || effectiveProjectId === null || saving) {
      return;
    }
    setSaving(true);
    setActionError(null);
    try {
      const updated = await updateTicket(
        ticketId,
        effectiveProjectId,
        { assigneeId: session.user.id },
        ticket.version,
      );
      setState({ kind: 'ready', ticket: { ...updated, messages: ticket.messages } });
      setDrafts(draftsOf({ ...updated, messages: ticket.messages }));
    } catch (caught: unknown) {
      setActionError(
        caught instanceof ApiError ? `${caught.message}（${caught.code}）` : '网络异常，请稍后重试',
      );
    } finally {
      setSaving(false);
    }
  }

  async function sendMessage(): Promise<void> {
    if (
      ticket === null ||
      effectiveProjectId === null ||
      sending ||
      messageBody.trim() === ''
    ) {
      return;
    }
    setSending(true);
    setMessageError(null);
    try {
      await appendTicketMessage(
        ticketId,
        effectiveProjectId,
        { body: messageBody.trim(), visibility },
        messageKey.current,
      );
      setMessageBody('');
      messageKey.current = newIdempotencyKey();
      await refresh(false);
    } catch (caught: unknown) {
      setMessageError(
        caught instanceof ApiError
          ? `${caught.message}（${caught.code}）`
          : '网络异常，请稍后重试',
      );
    } finally {
      setSending(false);
    }
  }

  if (state.kind === 'loading') {
    return (
      <section className="panel">
        <h1>工单详情</h1>
        <p className="lead">加载中…</p>
      </section>
    );
  }

  if (state.kind === 'error') {
    if (state.status === 404) {
      return (
        <section className="panel">
          <h1>工单不可见</h1>
          <p className="lead" data-testid="ticket-not-found">
            资源不存在，或当前租户无权访问。
          </p>
          <Link to="/tickets">返回工单列表</Link>
        </section>
      );
    }
    if (state.status === 403) {
      return (
        <section className="panel">
          <h1>无权访问</h1>
          <p className="lead" data-testid="ticket-forbidden">
            当前账号没有该项目或该操作的权限。
          </p>
          <Link to="/tickets">返回工单列表</Link>
        </section>
      );
    }

    return (
      <section className="panel">
        <h1>工单加载失败</h1>
        <p className="lead" data-testid="ticket-error">
          请求失败：{state.code}
        </p>
        <button type="button" className="button" onClick={() => setReloadToken((value) => value + 1)}>
          重试
        </button>
      </section>
    );
  }

  if (ticket === null || drafts === null) {
    return null;
  }

  const statusOptions = [
    ticket.status,
    ...STATUS_TRANSITIONS[ticket.status].filter((target) =>
      target === 'CLOSED' ? hasPermission('ticket', 'close') : true,
    ),
  ];
  const editable = canUpdate && ticket.status !== 'CLOSED';
  const closed = ticket.status === 'CLOSED';

  return (
    <div className="workbench">
      <section className="panel">
        <div className="page-head">
          <div>
            <h1>{ticket.subject}</h1>
            <p className="lead">
              工单号 <strong data-testid="ticket-no">{ticket.ticketNo}</strong>
              <span className="muted">ID：</span>
              <code data-testid="ticket-id">{ticket.id}</code>
            </p>
          </div>
          <div className="page-head__meta">
            <span className={`status-pill status-pill--${ticket.status.toLowerCase()}`} data-testid="ticket-status">
              {STATUS_LABELS[ticket.status]}
            </span>
            <span className="muted" data-testid="ticket-version">
              v{ticket.version}
            </span>
          </div>
        </div>

        <p className="description" data-testid="ticket-description">
          {ticket.description}
        </p>

        <dl className="status-list">
          <div className="status-row">
            <dt>客户</dt>
            <dd>{ticket.customerName}</dd>
          </div>
          {ticket.customerPhone !== undefined ? (
            <div className="status-row">
              <dt>客户手机号</dt>
              <dd data-testid="ticket-phone">{ticket.customerPhone}</dd>
            </div>
          ) : null}
          {ticket.refundAmount !== undefined ? (
            <div className="status-row">
              <dt>退款金额</dt>
              <dd data-testid="ticket-refund">{ticket.refundAmount}</dd>
            </div>
          ) : null}
          {ticket.assigneeId !== undefined ? (
            <div className="status-row">
              <dt>处理人</dt>
              <dd data-testid="ticket-assignee">{ticket.assigneeId}</dd>
            </div>
          ) : null}
          {canNote && ticket.internalNote !== undefined ? (
            <div className="status-row">
              <dt>内部备注</dt>
              <dd data-testid="ticket-internal-note">{ticket.internalNote}</dd>
            </div>
          ) : null}
        </dl>

        {conflictVersion !== null ? (
          <p className="form-warning" role="alert" data-testid="ticket-conflict">
            工单已被他人更新（当前版本 v{conflictVersion}），你的输入已保留，可直接再次保存。
          </p>
        ) : null}

        {actionError !== null ? (
          <p className="form-error" role="alert" data-testid="ticket-action-error">
            {actionError}
          </p>
        ) : null}

        {canAssign && !closed && session !== null ? (
          <div className="inline-form">
            {ticket.assigneeId === session.user.id ? null : (
              <button
                type="button"
                className="button button--ghost"
                disabled={saving}
                onClick={() => void assignToMe()}
                data-testid="assign-to-me"
              >
                分配给我
              </button>
            )}
          </div>
        ) : null}
      </section>

      {editable ? (
        <section className="panel">
          <h2>修改工单</h2>
          <div className="form form--wide">
            <div className="form-grid">
              <label className="form-field">
                状态
                <select
                  className="select"
                  value={drafts.status}
                  onChange={(event) =>
                    setDrafts({ ...drafts, status: event.target.value as TicketStatus })
                  }
                  data-testid="ticket-status-select"
                >
                  {statusOptions.map((value) => (
                    <option key={value} value={value}>
                      {STATUS_LABELS[value]}
                    </option>
                  ))}
                </select>
              </label>

              <label className="form-field">
                优先级
                <select
                  className="select"
                  value={drafts.priority}
                  onChange={(event) =>
                    setDrafts({ ...drafts, priority: event.target.value as TicketPriority })
                  }
                  data-testid="ticket-priority-select"
                >
                  {PRIORITIES.map((value) => (
                    <option key={value} value={value}>
                      {value}
                    </option>
                  ))}
                </select>
              </label>
            </div>

            <label className="form-field">
              标签（逗号分隔）
              <input
                className="input-field"
                value={drafts.tags}
                onChange={(event) => setDrafts({ ...drafts, tags: event.target.value })}
                data-testid="ticket-tags-input"
              />
            </label>

            {canEditRefund ? (
              <label className="form-field">
                退款金额
                <input
                  className="input-field"
                  type="number"
                  min="0"
                  step="0.01"
                  value={drafts.refund}
                  onChange={(event) => setDrafts({ ...drafts, refund: event.target.value })}
                  data-testid="refund-input"
                />
              </label>
            ) : null}

            <button
              type="button"
              className="button"
              disabled={saving || !dirty}
              onClick={() => void save()}
              data-testid="ticket-save"
            >
              {saving ? '保存中…' : '保存变更'}
            </button>
          </div>
        </section>
      ) : null}

      {canEditNote && !closed ? (
        <section className="panel">
          <h2>内部备注</h2>
          <textarea
            className="textarea"
            rows={4}
            value={drafts.note}
            onChange={(event) => setDrafts({ ...drafts, note: event.target.value })}
            data-testid="internal-note-input"
          />
          <button
            type="button"
            className="button"
            disabled={saving || drafts.note === (ticket.internalNote ?? '')}
            onClick={() => void save()}
            data-testid="internal-note-save"
          >
            保存内部备注
          </button>
        </section>
      ) : null}

      <section className="panel">
        <h2>沟通记录</h2>
        <ul className="message-list" data-testid="message-list">
          {ticket.messages.length === 0 ? (
            <li className="muted">暂无消息</li>
          ) : (
            ticket.messages.map((message) => (
              <li key={message.id} className="message" data-testid="message-item">
                <div className="message__meta">
                  <span className="tag">#{message.seq}</span>
                  <span
                    className={
                      message.visibility === 'INTERNAL' ? 'tag tag--internal' : 'tag tag--public'
                    }
                  >
                    {message.visibility === 'INTERNAL' ? '内部备注' : '公开回复'}
                  </span>
                  <span className="muted">
                    {new Date(message.createdAt).toLocaleString('zh-CN')}
                  </span>
                </div>
                <p className="message__body">{message.body}</p>
              </li>
            ))
          )}
        </ul>

        {canReply && !closed ? (
          <div className="form">
            <label className="form-field">
              消息类型
              <select
                className="select"
                value={visibility}
                onChange={(event) => setVisibility(event.target.value as MessageVisibility)}
                data-testid="message-visibility"
              >
                <option value="PUBLIC">公开回复</option>
                {canNote ? <option value="INTERNAL">内部备注</option> : null}
              </select>
            </label>
            <textarea
              className="textarea"
              rows={3}
              value={messageBody}
              onChange={(event) => setMessageBody(event.target.value)}
              data-testid="message-input"
            />
            {messageError !== null ? (
              <p className="form-error" role="alert" data-testid="message-error">
                {messageError}
              </p>
            ) : null}
            <button
              type="button"
              className="button"
              disabled={sending || messageBody.trim() === ''}
              onClick={() => void sendMessage()}
              data-testid="message-send"
            >
              {sending ? '发送中…' : '发送'}
            </button>
          </div>
        ) : closed ? (
          <p className="muted">工单已关闭，不能再追加消息。</p>
        ) : null}
      </section>

      {canReadAudit ? (
        <section className="panel">
          <h2>审计记录</h2>
          {audit.length === 0 ? (
            <p className="muted">暂无审计记录。</p>
          ) : (
            <ul className="audit-list" data-testid="audit-list">
              {audit.map((entry) => (
                <li key={entry.id} className="audit-item">
                  <div className="message__meta">
                    <span className={entry.action === 'CREATE' ? 'tag tag--public' : 'tag'}>
                      {entry.action === 'CREATE' ? '创建' : '更新'}
                    </span>
                    <span className="muted">
                      {new Date(entry.createdAt).toLocaleString('zh-CN')}
                    </span>
                  </div>
                  <p className="audit-item__fields">
                    变更字段：{entry.changedFields.join(', ')}
                  </p>
                </li>
              ))}
            </ul>
          )}
        </section>
      ) : null}

      <p>
        <Link to="/tickets">返回工单列表</Link>
      </p>
    </div>
  );
}
