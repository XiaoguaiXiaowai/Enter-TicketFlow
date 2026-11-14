import {
  type ArgumentsHost,
  Catch,
  type ExceptionFilter,
  HttpException,
  HttpStatus,
} from '@nestjs/common';
import type { Request, Response } from 'express';

import type { ApiErrorBody } from '@ticket/shared';
import { writeLog } from './logger';
import { getRequestContext } from './request-context';

interface ExceptionPayload {
  code?: unknown;
  message?: unknown;
  details?: unknown;
}

/**
 * 统一错误结构：{ error: { code, message, requestId, details? } }。
 * 未预期异常只外泄 code/message/requestId，堆栈只写服务端日志。
 */
@Catch()
export class AllExceptionsFilter implements ExceptionFilter {
  catch(exception: unknown, host: ArgumentsHost): void {
    const ctx = host.switchToHttp();
    const res = ctx.getResponse<Response>();
    const req = ctx.getRequest<Request>();
    const requestId = getRequestContext()?.requestId ?? '-';

    let statusCode = HttpStatus.INTERNAL_SERVER_ERROR;
    let code = 'INTERNAL_SERVER_ERROR';
    let message = 'Internal server error';
    let details: unknown;

    if (exception instanceof HttpException) {
      statusCode = exception.getStatus();
      const payload = exception.getResponse();

      if (typeof payload === 'string') {
        message = payload;
        code = `HTTP_${statusCode}`;
      } else if (payload !== null && typeof payload === 'object') {
        const body = payload as ExceptionPayload;
        code = typeof body.code === 'string' ? body.code : `HTTP_${statusCode}`;
        message =
          typeof body.message === 'string'
            ? body.message
            : Array.isArray(body.message)
              ? body.message.join('; ')
              : exception.message;
        details = body.details;
      }
    }

    if (statusCode >= HttpStatus.INTERNAL_SERVER_ERROR) {
      const expected = exception instanceof HttpException;
      writeLog(expected ? 'warn' : 'error', 'request failed', {
        type: 'error',
        requestId,
        method: req.method,
        route: req.originalUrl,
        statusCode,
        error: exception instanceof Error ? exception.message : String(exception),
        ...(expected ? {} : { stack: exception instanceof Error ? exception.stack : undefined }),
      });
    }

    const body: ApiErrorBody = {
      error: {
        code,
        message,
        requestId,
        ...(details === undefined ? {} : { details }),
      },
    };

    if (!res.headersSent) {
      res.status(statusCode).json(body);
    }
  }
}
