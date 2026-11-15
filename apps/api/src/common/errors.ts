import { HttpException, HttpStatus } from '@nestjs/common';

/**
 * 业务异常：保留可判定的错误码与 details，响应结构由全局过滤器统一输出。
 */
export class AppException extends HttpException {
  constructor(status: HttpStatus, code: string, message: string, details?: unknown) {
    super({ code, message, ...(details === undefined ? {} : { details }) }, status);
  }

  static unauthorized(code = 'UNAUTHORIZED', message = '未登录或会话已失效'): AppException {
    return new AppException(HttpStatus.UNAUTHORIZED, code, message);
  }

  static forbidden(code = 'FORBIDDEN', message = '无权限执行该操作', details?: unknown): AppException {
    return new AppException(HttpStatus.FORBIDDEN, code, message, details);
  }

  static notFound(code = 'NOT_FOUND', message = '资源不存在'): AppException {
    return new AppException(HttpStatus.NOT_FOUND, code, message);
  }

  static conflict(code: string, message: string, details?: unknown): AppException {
    return new AppException(HttpStatus.CONFLICT, code, message, details);
  }

  static preconditionRequired(
    code = 'PRECONDITION_REQUIRED',
    message = '缺少 If-Match 前置条件',
    details?: unknown,
  ): AppException {
    return new AppException(HttpStatus.PRECONDITION_FAILED, code, message, details);
  }

  static validation(message: string, details?: unknown): AppException {
    return new AppException(HttpStatus.BAD_REQUEST, 'VALIDATION_FAILED', message, details);
  }

  static unprocessable(code: string, message: string, details?: unknown): AppException {
    return new AppException(HttpStatus.UNPROCESSABLE_ENTITY, code, message, details);
  }
}
