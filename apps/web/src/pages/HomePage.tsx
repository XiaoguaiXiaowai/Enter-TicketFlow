import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';

import { ApiError, fetchHealthReady } from '../lib/api';

type HealthState =
  | { kind: 'loading' }
  | { kind: 'ready'; migrationVersion: string }
  | { kind: 'unavailable'; reason: string };

export function HomePage() {
  const [health, setHealth] = useState<HealthState>({ kind: 'loading' });

  useEffect(() => {
    let cancelled = false;

    fetchHealthReady()
      .then((response) => {
        if (!cancelled) {
          setHealth({ kind: 'ready', migrationVersion: response.migrationVersion });
        }
      })
      .catch((error: unknown) => {
        if (cancelled) {
          return;
        }
        const reason =
          error instanceof ApiError
            ? `${error.code}（requestId: ${error.requestId ?? '-'}）`
            : '网络异常';
        setHealth({ kind: 'unavailable', reason });
      });

    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <section className="panel">
      <h1>工程基座已就绪</h1>
      <p className="lead">当前版本只包含构建、迁移、编排与健康检查，业务功能从 I1 开始交付。</p>

      <dl className="status-list">
        <div className="status-row">
          <dt>就绪状态</dt>
          <dd>
            <span className={`status-pill status-pill--${health.kind}`} data-testid="health-state">
              {health.kind === 'loading' ? '检测中' : null}
              {health.kind === 'ready' ? '就绪' : null}
              {health.kind === 'unavailable' ? '未就绪' : null}
            </span>
            {health.kind === 'unavailable' ? (
              <span className="status-detail">{health.reason}</span>
            ) : null}
          </dd>
        </div>
        <div className="status-row">
          <dt>迁移版本</dt>
          <dd data-testid="migration-version">
            {health.kind === 'ready' ? health.migrationVersion : '-'}
          </dd>
        </div>
      </dl>

      <p className="hint">
        前端路由回退验证入口：<Link to="/tickets/123">/tickets/123</Link>
      </p>
    </section>
  );
}
