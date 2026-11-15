import { Navigate, Route, Routes, Link, useNavigate } from 'react-router-dom';

import { useAuth } from './auth/AuthContext';
import { HomePage } from './pages/HomePage';
import { KnowledgePage } from './pages/KnowledgePage';
import { LoginPage } from './pages/LoginPage';
import { NotFoundPage } from './pages/NotFoundPage';
import { TicketCreatePage } from './pages/TicketCreatePage';
import { TicketDetailPage } from './pages/TicketDetailPage';
import { TicketsPage } from './pages/TicketsPage';

export function App() {
  const { status, session, signOut, hasPermission } = useAuth();
  const navigate = useNavigate();

  async function handleSignOut(): Promise<void> {
    await signOut();
    navigate('/login', { replace: true });
  }

  if (status === 'loading') {
    return (
      <div className="app">
        <main className="app-main">
          <section className="panel">
            <h1>正在恢复会话…</h1>
          </section>
        </main>
      </div>
    );
  }

  if (status === 'anonymous') {
    return (
      <div className="app">
        <header className="app-header">
          <span className="brand">企业客服工单平台</span>
          <span className="phase-badge">I3 知识库</span>
        </header>
        <main className="app-main">
          <Routes>
            <Route path="/login" element={<LoginPage />} />
            <Route path="*" element={<Navigate to="/login" replace />} />
          </Routes>
        </main>
      </div>
    );
  }

  return (
    <div className="app">
      <header className="app-header">
        <Link to="/" className="brand">
          企业客服工单平台
        </Link>
        <span className="phase-badge">I3 知识库</span>
        {hasPermission('kb', 'read') ? (
          <Link to="/knowledge" className="header-link" data-testid="nav-knowledge">
            知识库
          </Link>
        ) : null}
        <div className="header-spacer" />
        {session !== null ? (
          <span className="header-tenant" data-testid="header-tenant">
            {session.tenant.name}
          </span>
        ) : null}
        <button
          type="button"
          className="button button--ghost"
          onClick={() => void handleSignOut()}
          data-testid="switch-tenant"
        >
          切换租户
        </button>
        <button
          type="button"
          className="button button--ghost"
          onClick={() => void handleSignOut()}
          data-testid="sign-out"
        >
          退出登录
        </button>
      </header>

      <main className="app-main">
        <Routes>
          <Route path="/" element={<HomePage />} />
          <Route path="/tickets" element={<TicketsPage />} />
          <Route path="/tickets/new" element={<TicketCreatePage />} />
          <Route path="/tickets/:ticketId" element={<TicketDetailPage />} />
          <Route path="/knowledge" element={<KnowledgePage />} />
          <Route path="/login" element={<Navigate to="/" replace />} />
          <Route path="*" element={<NotFoundPage />} />
        </Routes>
      </main>
    </div>
  );
}
