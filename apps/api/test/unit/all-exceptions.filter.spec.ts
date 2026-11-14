import {
  type ArgumentsHost,
  HttpStatus,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { describe, expect, it } from 'vitest';

import type { ApiErrorBody } from '@ticket/shared';
import { AllExceptionsFilter } from '../../src/common/all-exceptions.filter';

interface CapturedResponse {
  statusCode: number | undefined;
  body: ApiErrorBody | undefined;
}

function invoke(exception: unknown): CapturedResponse {
  const captured: CapturedResponse = { statusCode: undefined, body: undefined };

  const response = {
    headersSent: false,
    status(code: number) {
      captured.statusCode = code;
      return this;
    },
    json(body: ApiErrorBody) {
      captured.body = body;
      return this;
    },
  };

  const host = {
    switchToHttp: () => ({
      getResponse: () => response,
      getRequest: () => ({ method: 'GET', originalUrl: '/api/probe' }),
    }),
  } as unknown as ArgumentsHost;

  new AllExceptionsFilter().catch(exception, host);
  return captured;
}

describe('AllExceptionsFilter', () => {
  it('未捕获异常返回 500，且响应体只含 error.code、message、requestId', () => {
    const { statusCode, body } = invoke(new Error('数据库口令泄露风险'));

    expect(statusCode).toBe(HttpStatus.INTERNAL_SERVER_ERROR);
    expect(body).toBeDefined();
    expect(Object.keys(body ?? {})).toEqual(['error']);
    expect(Object.keys(body?.error ?? {}).sort()).toEqual(['code', 'message', 'requestId']);
    expect(body?.error.code).toBe('INTERNAL_SERVER_ERROR');
    expect(body?.error.message).toBe('Internal server error');
  });

  it('HTTP 异常保留状态码并映射错误码', () => {
    const { statusCode, body } = invoke(new NotFoundException('资源不存在'));

    expect(statusCode).toBe(HttpStatus.NOT_FOUND);
    expect(body?.error.code).toBe('HTTP_404');
    expect(body?.error.message).toBe('资源不存在');
  });

  it('就绪检查异常携带 details', () => {
    const { statusCode, body } = invoke(
      new ServiceUnavailableException({
        code: 'NOT_READY',
        message: 'database migrations are not applied',
        details: { migrations: { applied: 0, expected: 1, pending: ['baseline'] } },
      }),
    );

    expect(statusCode).toBe(HttpStatus.SERVICE_UNAVAILABLE);
    expect(body?.error.code).toBe('NOT_READY');
    expect(body?.error.details).toEqual({
      migrations: { applied: 0, expected: 1, pending: ['baseline'] },
    });
  });
});
