import { Link, useParams } from 'react-router-dom';

export function TicketDetailPage() {
  const { ticketId } = useParams<{ ticketId: string }>();

  return (
    <section className="panel">
      <h1>工单详情</h1>
      <p className="lead">
        占位页面，用于验证 history 路由直接访问时回退到 index.html。工单业务在 I2 交付。
      </p>
      <p className="hint">
        当前工单标识：<code data-testid="ticket-id">{ticketId}</code>
      </p>
      <Link to="/">返回首页</Link>
    </section>
  );
}
