import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';

import type { NextFunction, Request, Response } from 'express';

export interface RequestContext {
  requestId: string;
}

const storage = new AsyncLocalStorage<RequestContext>();

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function getRequestContext(): RequestContext | undefined {
  return storage.getStore();
}

/**
 * 生成 requestId 并建立 AsyncLocalStorage 上下文。
 * 只接受格式合法的上游 requestId，其余一律重新生成，避免日志注入。
 */
export function requestContextMiddleware(req: Request, res: Response, next: NextFunction): void {
  const incoming = req.headers['x-request-id'];
  const requestId =
    typeof incoming === 'string' && UUID_PATTERN.test(incoming) ? incoming : randomUUID();

  res.setHeader('x-request-id', requestId);
  storage.run({ requestId }, () => next());
}
