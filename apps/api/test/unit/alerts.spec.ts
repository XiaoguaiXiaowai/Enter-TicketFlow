import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const { logSpy } = vi.hoisted(() => ({ logSpy: vi.fn() }));

vi.mock('../../src/common/logger', () => ({ writeLog: logSpy }));

import { AlertsService } from '../../src/observability/alerts.service';
import { MetricsService } from '../../src/observability/metrics.service';

// 告警评估读取 env 阈值，这里补齐必需键，避免依赖仓库根目录的 .env。
const REQUIRED_ENV: Record<string, string> = {
  NODE_ENV: 'test',
  API_PORT: '3000',
  LOG_LEVEL: 'error',
  POSTGRES_DB: 'ticket',
  POSTGRES_SUPERUSER: 'postgres',
  POSTGRES_SUPERUSER_PASSWORD: 'postgres',
  DATABASE_URL: 'postgresql://app_rw:pw@localhost:5432/ticket',
  MIGRATE_DATABASE_URL: 'postgresql://app_migrator:pw@localhost:5432/ticket',
  WORKER_DATABASE_URL: 'postgresql://app_worker:pw@localhost:5432/ticket',
  REDIS_URL: 'redis://localhost:6379',
  JWT_SECRET: 'unit_test_secret_0123456789abcdef0123456789',
  SEED_DEFAULT_PASSWORD: 'unit_test_password',
  METRICS_INTERVAL_SECONDS: '30',
  ALERT_5XX_RATIO_PERCENT: '1',
  ALERT_OUTBOX_BACKLOG_THRESHOLD: '100',
  ALERT_LOGIN_FAILURE_PER_MINUTE: '20',
};

beforeAll(() => {
  for (const [key, value] of Object.entries(REQUIRED_ENV)) {
    process.env[key] = value;
  }
});

beforeEach(() => {
  logSpy.mockClear();
});

/** 首次 evaluate 只建立基线，第二次才有增量。 */
function prime(alerts: AlertsService): void {
  alerts.evaluate();
}

function alertsOf(type: string): Record<string, unknown>[] {
  return logSpy.mock.calls
    .filter(([, message, fields]) => message === 'alert triggered' && (fields as { alert?: string }).alert === type)
    .map(([, , fields]) => fields as Record<string, unknown>);
}

describe('I4 告警规则', () => {
  it('5xx 比例超阈值触发告警，日志包含排查入口', () => {
    const metrics = new MetricsService();
    const alerts = new AlertsService(metrics);
    prime(alerts);

    for (let index = 0; index < 100; index += 1) {
      metrics.incCounter('http_requests_total', { method: 'GET', route: '/api/v1/tickets', status: '200' });
    }
    for (let index = 0; index < 5; index += 1) {
      metrics.incCounter('http_5xx_total');
    }

    alerts.evaluate();

    const fired = alertsOf('http_5xx_ratio');
    expect(fired).toHaveLength(1);
    expect(fired[0]).toMatchObject({
      type: 'alert',
      alert: 'http_5xx_ratio',
      runbook: 'docs/architecture.md',
      value: '5.00%',
      threshold: '1%',
    });
  });

  it('同一告警在冷却期内不重复通知', () => {
    const metrics = new MetricsService();
    const alerts = new AlertsService(metrics);
    prime(alerts);

    for (let index = 0; index < 40; index += 1) {
      metrics.incCounter('http_requests_total', { method: 'GET', route: '/api/v1/tickets', status: '200' });
    }
    for (let index = 0; index < 4; index += 1) {
      metrics.incCounter('http_5xx_total');
    }

    alerts.evaluate();
    alerts.evaluate();
    alerts.evaluate();

    expect(alertsOf('http_5xx_ratio')).toHaveLength(1);
  });

  it('Outbox 积压与 Redis 降级各自触发告警', () => {
    const metrics = new MetricsService();
    const alerts = new AlertsService(metrics);
    prime(alerts);

    metrics.setGauge('outbox_pending_events', { tenant: 'tenant-a' }, 101);
    metrics.setGauge('outbox_pending_events', { tenant: 'tenant-b' }, 0);
    metrics.setGauge('redis_state', {}, 0);

    alerts.evaluate();

    expect(alertsOf('outbox_backlog')).toHaveLength(1);
    expect(alertsOf('outbox_backlog')[0]).toMatchObject({ value: 101, threshold: 100 });
    expect(alertsOf('redis_degraded')).toHaveLength(1);
  });
});