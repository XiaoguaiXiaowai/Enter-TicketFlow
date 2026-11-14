import { Link, Route, Routes } from 'react-router-dom';

import { HomePage } from './pages/HomePage';
import { NotFoundPage } from './pages/NotFoundPage';
import { TicketDetailPage } from './pages/TicketDetailPage';

export function App() {
  return (
    <div className="app">
      <header className="app-header">
        <Link to="/" className="brand">
          企业客服工单平台
        </Link>
        <span className="phase-badge">I0 工程基座</span>
      </header>

      <main className="app-main">
        <Routes>
          <Route path="/" element={<HomePage />} />
          <Route path="/tickets/:ticketId" element={<TicketDetailPage />} />
          <Route path="*" element={<NotFoundPage />} />
        </Routes>
      </main>
    </div>
  );
}
