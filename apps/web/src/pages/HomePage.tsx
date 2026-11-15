import { Link } from 'react-router-dom';

import { useAuth } from '../auth/AuthContext';

// 与 @ticket/shared 的 TICKET_SENSITIVE_FIELDS 保持一致；前端只做展示，判定始终在服务端。
const TICKET_SENSITIVE_FIELDS = [
  'customerPhone',
  'internalNote',
  'refundAmount',
  'assigneeId',
] as const;

const FIELD_LABELS: Record<string, string> = {
  customerPhone: '客户手机号',
  internalNote: '内部备注',
  refundAmount: '退款金额',
  assigneeId: '处理人',
};

export function HomePage() {
  const { session, projectId, setProjectId, hasPermission, fieldRule } = useAuth();

  if (session === null) {
    return null;
  }

  const canListTickets = hasPermission('ticket', 'list');
  const canViewInternalNote = hasPermission('ticket', 'note');
  const canUpdateRefund = hasPermission('ticket', 'update') &&
    fieldRule('ticket', 'refundAmount')?.canWrite === true;
  const canReadAudit = hasPermission('audit', 'read');

  return (
    <div className="workbench">
      <section className="panel">
        <h1>客服工作台</h1>
        <p className="lead">
          当前租户 <strong data-testid="tenant-name">{session.tenant.name}</strong>
          <span className="muted">（{session.tenant.code}）</span>
          ，登录账号 <span data-testid="current-user">{session.user.email}</span>。
        </p>

        <div className="status-row">
          <span className="status-row__label">角色</span>
          <ul className="tag-list" data-testid="role-list">
            {session.roles.map((role) => (
              <li key={role.code} className="tag">
                {role.name}
              </li>
            ))}
          </ul>
        </div>

        <div className="status-row">
          <span className="status-row__label">项目</span>
          {session.projects.length === 0 ? (
            <span className="muted">未授予任何项目</span>
          ) : (
            <select
              className="select"
              data-testid="project-select"
              value={projectId ?? ''}
              onChange={(event) => setProjectId(event.target.value)}
            >
              {session.projects.map((project) => (
                <option key={project.id} value={project.id}>
                  {project.name}（{project.code}）
                </option>
              ))}
            </select>
          )}
        </div>

        <nav className="menu" aria-label="功能菜单">
          {canListTickets && projectId !== null ? (
            <Link
              className="menu-item"
              to={`/tickets?projectId=${projectId}`}
              data-testid="menu-tickets"
            >
              工单工作台
            </Link>
          ) : null}
          {canViewInternalNote ? (
            <span className="menu-item" data-testid="menu-internal-note">
              内部备注
            </span>
          ) : null}
          {canUpdateRefund ? (
            <span className="menu-item" data-testid="menu-refund">
              退款处理
            </span>
          ) : null}
          {canReadAudit ? (
            <span className="menu-item" data-testid="menu-audit">
              审计日志
            </span>
          ) : null}
        </nav>
      </section>

      <section className="panel">
        <h2>字段权限</h2>
        <p className="lead">字段可见性由服务端投影，前端隐藏只是体验优化。</p>
        <table className="data-table">
          <thead>
            <tr>
              <th>字段</th>
              <th>读取</th>
              <th>写入</th>
            </tr>
          </thead>
          <tbody>
            {TICKET_SENSITIVE_FIELDS.map((field) => {
              const rule = session.fields.find(
                (item) => item.resource === 'ticket' && item.field === field,
              );
              return (
                <tr key={field} data-testid={`field-${field}`}>
                  <td>{FIELD_LABELS[field] ?? field}</td>
                  <td>
                    {rule === undefined || !rule.canRead
                      ? '不可见'
                      : rule.masked
                        ? '脱敏'
                        : '完整'}
                  </td>
                  <td>{rule?.canWrite === true ? '可写' : '只读'}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </section>
    </div>
  );
}
