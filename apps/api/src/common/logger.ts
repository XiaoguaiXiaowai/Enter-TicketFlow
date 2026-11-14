export type LogLevel = 'fatal' | 'error' | 'warn' | 'info' | 'debug' | 'trace';

export type LogFields = Record<string, unknown>;

/**
 * 结构化日志：每条一行 JSON，便于日志系统按字段检索。
 */
export function writeLog(level: LogLevel, message: string, fields: LogFields = {}): void {
  const line = JSON.stringify({
    timestamp: new Date().toISOString(),
    level,
    message,
    ...fields,
  });
  process.stdout.write(`${line}\n`);
}
