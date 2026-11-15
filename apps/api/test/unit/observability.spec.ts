import { describe, expect, it } from 'vitest';

import { MetricsService } from '../../src/observability/metrics.service';
import { outboxBackoffSeconds } from '../../src/outbox/outbox-worker.service';

describe('Outbox 退避策略', () => {
  it('按 5 秒指数退避并在 5 分钟封顶', () => {
    expect(outboxBackoffSeconds(0)).toBe(5);
    expect(outboxBackoffSeconds(1)).toBe(10);
    expect(outboxBackoffSeconds(3)).toBe(40);
    expect(outboxBackoffSeconds(6)).toBe(300);
    expect(outboxBackoffSeconds(20)).toBe(300);
  });
});

describe('指标注册表', () => {
  it('累加计数器、覆盖仪表并按标签聚合', () => {
    const metrics = new MetricsService();
    metrics.incCounter('http_requests_total', { method: 'GET', route: '/v1/tickets' });
    metrics.incCounter('http_requests_total', { method: 'GET', route: '/v1/tickets' });
    metrics.incCounter('http_requests_total', { method: 'POST', route: '/v1/tickets' });
    metrics.setGauge('outbox_pending_events', { tenant: 'tenant-a' }, 3);
    metrics.setGauge('outbox_pending_events', { tenant: 'tenant-a' }, 5);

    expect(metrics.counterValue('http_requests_total', { method: 'GET', route: '/v1/tickets' })).toBe(
      2,
    );
    expect(metrics.sumCounters('http_requests_total')).toBe(3);
    expect(metrics.gaugeValue('outbox_pending_events', { tenant: 'tenant-a' })).toBe(5);
    expect(metrics.sumGauges('outbox_pending_events')).toBe(5);
  });

  it('直方图输出累计桶、sum 与 count', () => {
    const metrics = new MetricsService();
    metrics.observeHistogram('http_request_duration_ms', { route: '/v1/tickets' }, 12);
    metrics.observeHistogram('http_request_duration_ms', { route: '/v1/tickets' }, 120);

    const text = metrics.render();
    expect(text).toContain(
      'http_request_duration_ms_bucket{route="/v1/tickets",le="25"} 1',
    );
    expect(text).toContain(
      'http_request_duration_ms_bucket{route="/v1/tickets",le="200"} 2',
    );
    expect(text).toContain('http_request_duration_ms_bucket{route="/v1/tickets",le="+Inf"} 2');
    expect(text).toContain('http_request_duration_ms_sum{route="/v1/tickets"} 132');
    expect(text).toContain('http_request_duration_ms_count{route="/v1/tickets"} 2');
  });

  it('标签值中的引号与换行被转义', () => {
    const metrics = new MetricsService();
    metrics.incCounter('demo_total', { reason: 'a"b\nc' });
    expect(metrics.render()).toContain('demo_total{reason="a\\"b\\nc"} 1');
  });
});