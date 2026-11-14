import type { LoggerService } from '@nestjs/common';

import { writeLog, type LogFields } from './logger';

function toMessage(message: unknown): string {
  if (typeof message === 'string') {
    return message;
  }
  if (message instanceof Error) {
    return message.message;
  }
  try {
    return JSON.stringify(message);
  } catch {
    return String(message);
  }
}

/**
 * 替换 Nest 默认控制台日志，保证进程内所有日志都是单行 JSON。
 */
export class JsonLogger implements LoggerService {
  log(message: unknown, context?: string): void {
    writeLog('info', toMessage(message), context ? { context } : {});
  }

  error(message: unknown, trace?: unknown, context?: string): void {
    const fields: LogFields = {};
    if (context) {
      fields.context = context;
    }
    if (typeof trace === 'string') {
      fields.stack = trace;
    }
    writeLog('error', toMessage(message), fields);
  }

  warn(message: unknown, context?: string): void {
    writeLog('warn', toMessage(message), context ? { context } : {});
  }

  debug(message: unknown, context?: string): void {
    writeLog('debug', toMessage(message), context ? { context } : {});
  }

  verbose(message: unknown, context?: string): void {
    writeLog('trace', toMessage(message), context ? { context } : {});
  }
}
