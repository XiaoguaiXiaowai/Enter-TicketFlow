import { useCallback, useEffect, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';

import type { TicketListResponse, TicketResponse, TicketStatus } from '@ticket/shared';
import { useAuth } from '../auth/AuthContext';
import { ApiError, fetchTickets } from '../lib/api';

const STATUS_LABELS: Record<TicketStatus, string> = {
  OPEN: '待处理',
  PENDING: '处理中',
  RESOLVED: '已解决',
  CLOSED: '已关闭',
};

export function TicketsPage() {
  const { session, projectId, setProjectId, hasPermission } = useAuth();
  const [searchParams, setSearchParams] = useSearchParams();
  const effectiveProjectId = searchParams.get('projectId') ?? projectId;

  const [status, setStatus] = useState<TicketStatus | ''>('');
  const [onlyMine, setOnlyMine] = useState(false);
  const [items, setItems] = useState<TicketResponse[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(
    async (cursor?: string) => {
      if (effectiveProjectId === null || session === null) {
        return;
      }
      const isPaging = cursor !== undefined;
      if (isPaging) {
        setLoadingMore(true);
      } else {
        setLoading(true);
        setItems([]);
      }
      setError(null);
      try {
        const page: TicketListResponse = await fetchTickets(effectiveProjectId, {
          ...(status === '' ? {} : { status }),
          ...(onlyMine ? { assigneeId: session.user.id } : {}),
          limit: 20,
          ...(cursor === undefined ? {} : { cursor }),
        });
        setItems((current) => (isPaging ? [...current, ...page.items] : page.items));
        setNextCursor(page.nextCursor);
      } catch (caught: unknown) {
        setError(
          caught instanceof ApiError
            ? `${caught.message}（${caught.code}）`
            : '网络异常，请稍后重试',
        );
      } finally {
        setLoading(false);
        setLoadingMore(false);
      }
    },
    [effectiveProjectId, session, status, onlyMine],
  );

  useEffect(() => {
    void load();
  }, [load]);

  if (session === null) {
    return null;
  }

  function changeProject(value: string): void {
    setProjectId(value);
    const next = new URLSearchParams(searchParams);
    next.set('projectId', value);
    setSearchParams(next, { replace: true });
  }

  const canCreate = hasPermission('ticket', 'create');

  return (
    <div className="workbench">
      <section className="panel">
        <div className="page-head">
          <div>
            <h1>工单工作台</h1>
            <p className="lead">按项目隔离，列表使用游标分页，字段按角色策略投影。</p>
          </div>
          {canCreate && effectiveProjectId !== null ? (
            <Link
              className="button"
              to={`/tickets/new?projectId=${effectiveProjectId}`}
              data-testid="new-ticket"
            >
              新建工单
            </Link>
          ) : null}
        </div>

        <div className="filters">
          <label className="form-field">
            项目
            <select
              className="select"
              value={effectiveProjectId ?? ''}
              onChange={(event) => changeProject(event.target.value)}
              data-testid="ticket-project-select"
            >
              {session.projects.map((project) => (
                <option key={project.id} value={project.id}>
                  {project.name}（{project.code}）
                </option>
              ))}
            </select>
          </label>

          <label className="form-field">
            状态
            <select
              className="select"
              value={status}
              onChange={(event) => setStatus(event.target.value as TicketStatus | '')}
              data-testid="ticket-status-filter"
            >
              <option value="">全部</option>
              {(Object.keys(STATUS_LABELS) as TicketStatus[]).map((value) => (
                <option key={value} value={value}>
                  {STATUS_LABELS[value]}
                </option>
              ))}
            </select>
          </label>

          <label className="checkbox-field">
            <input
              type="checkbox"
              checked={onlyMine}
              onChange={(event) => setOnlyMine(event.target.checked)}
              data-testid="ticket-assignee-filter"
            />
            只看我处理的
          </label>
        </div>

        {effectiveProjectId === null ? (
          <p className="form-error" role="alert">
            当前账号还没有被授予任何项目，请联系管理员。
          </p>
        ) : null}

        {error !== null ? (
          <p className="form-error" role="alert" data-testid="ticket-list-error">
            {error}
          </p>
        ) : null}

        {loading ? <p className="muted">加载中…</p> : null}

        {!loading && items.length === 0 && error === null && effectiveProjectId !== null ? (
          <p className="empty" data-testid="ticket-empty">
            还没有工单，点击右上角新建。
          </p>
        ) : null}

        {items.length > 0 ? (
          <table className="data-table" data-testid="ticket-table">
            <thead>
              <tr>
                <th>工单号</th>
                <th>主题</th>
                <th>状态</th>
                <th>优先级</th>
                <th>客户</th>
                <th>更新时间</th>
              </tr>
            </thead>
            <tbody>
              {items.map((ticket) => (
                <tr key={ticket.id} data-testid="ticket-row">
                  <td>
                    <Link to={`/tickets/${ticket.id}?projectId=${effectiveProjectId}`}>
                      {ticket.ticketNo}
                    </Link>
                  </td>
                  <td>{ticket.subject}</td>
                  <td>
                    <span className={`status-pill status-pill--${ticket.status.toLowerCase()}`}>
                      {STATUS_LABELS[ticket.status]}
                    </span>
                  </td>
                  <td>{ticket.priority}</td>
                  <td>{ticket.customerName}</td>
                  <td>{new Date(ticket.updatedAt).toLocaleString('zh-CN')}</td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : null}

        {nextCursor !== null ? (
          <button
            type="button"
            className="button button--ghost"
            disabled={loadingMore}
            onClick={() => void load(nextCursor)}
            data-testid="load-more"
          >
            {loadingMore ? '加载中…' : '加载更多'}
          </button>
        ) : null}
      </section>
    </div>
  );
}
