import type { NextFunction, Request, Response } from 'express';

import type { MetricsService } from './metrics.service';

type RoutedRequest = Request & { route?: { path?: string }; actor?: { tenantId?: string } };

function routeOf(req: RoutedRequest): string {
  const base = req.baseUrl ?? '';
  const path = req.route?.path;
  if (typeof path === 'string' && path.length > 0) {
    return `${base}${path}` || '/';
  }
  return 'unmatched';
}

/** 已认证请求带租户标签，仪表盘可按租户筛选；未认证请求归入 anonymous。 */
function tenantOf(req: RoutedRequest): string {
  return req.actor?.tenantId ?? 'anonymous';
}

function statusClass(status: number): string {
  if (status >= 500) {
    return '5xx';
  }
  if (status >= 400) {
    return '4xx';
  }
  if (status >= 300) {
    return '3xx';
  }
  return '2xx';
}

/**
 * RED 指标中间件：在路由完成后按路由模板记录，避免把原始 URL 当作标签。
 * 作为中间件注册，因此守卫拒绝（401/403/429）同样被统计。
 */
export function createHttpMetricsMiddleware(metrics: MetricsService) {
  return function httpMetrics(req: Request, res: Response, next: NextFunction): void {
    const startedAt = process.hrtime.bigint();
    res.once('finish', () => {
      const durationMs = Number(process.hrtime.bigint() - startedAt) / 1_000_000;
      const route = routeOf(req as RoutedRequest);
      const tenant = tenantOf(req as RoutedRequest);
      const base = { method: req.method, route, tenant, status: String(res.statusCode) };
      metrics.incCounter('http_requests_total', base);
      metrics.incCounter('http_status_class_total', {
        method: req.method,
        route,
        tenant,
        class: statusClass(res.statusCode),
      });
      if (res.statusCode >= 500) {
        metrics.incCounter('http_5xx_total');
      }
      metrics.observeHistogram(
        'http_request_duration_ms',
        { method: req.method, route, tenant, class: statusClass(res.statusCode) },
        durationMs,
      );
    });
    next();
  };
}