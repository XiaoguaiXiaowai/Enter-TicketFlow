import {
  type CallHandler,
  type ExecutionContext,
  Injectable,
  type NestInterceptor,
} from '@nestjs/common';
import type { Request, Response } from 'express';
import type { Observable } from 'rxjs';

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
 * 使用 finish 事件而不是 RxJS finalize，确保异常被过滤器转换后记录真实状态码。
 */
@Injectable()
export class AccessLogInterceptor implements NestInterceptor {
  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const startedAt = process.hrtime.bigint();
    const http = context.switchToHttp();
    const req = http.getRequest<RoutedRequest>();
    const res = http.getResponse<Response>();

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

    return next.handle();
  }
}
