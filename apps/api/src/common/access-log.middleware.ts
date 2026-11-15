import type { NextFunction, Request, Response } from 'express';

import { writeLog } from './logger';
import { getRequestContext } from './request-context';

type RoutedRequest = Request & { route?: { path?: string } };

function routeOf(req: RoutedRequest): string {
  const base = req.baseUrl ?? '';
  const path = req.route?.path;
  if (typeof path === 'string' && path.length > 0) {
    return `${base}${path}` || '/';
  }
  return req.path;
}

/**
 * 访问日志：requestId、route、statusCode、durationMs 四个字段固定输出。
 * 注册为中间件而不是拦截器：守卫（401/403/429）在拦截器之前执行，
 * 若放在拦截器里，被守卫拒绝的请求不会留下访问日志，无法与错误日志按 requestId 关联。
 */
export function accessLogMiddleware(req: Request, res: Response, next: NextFunction): void {
  const startedAt = process.hrtime.bigint();

  res.once('finish', () => {
    const durationMs = Number(process.hrtime.bigint() - startedAt) / 1_000_000;
    writeLog('info', 'http request', {
      type: 'access',
      requestId: getRequestContext()?.requestId ?? res.getHeader('x-request-id') ?? '-',
      method: req.method,
      route: routeOf(req),
      statusCode: res.statusCode,
      durationMs: Math.round(durationMs * 100) / 100,
    });
  });

  next();
}