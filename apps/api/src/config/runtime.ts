import { config as loadDotenvFile } from 'dotenv';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';

import { parseEnv, type AppEnv } from './env';

let cached: AppEnv | null = null;

function loadEnvFiles(): void {
  const candidates = [
    resolve(process.cwd(), '.env'),
    resolve(process.cwd(), '../../.env'),
    resolve(__dirname, '../../../../.env'),
  ];

  for (const file of candidates) {
    if (existsSync(file)) {
      loadDotenvFile({ path: file, quiet: true });
    }
  }
}

/**
 * 返回经过 schema 校验的配置。缺少必填键时输出单行 JSON 后退出，
 * 不用默认值兜底，避免生产误连测试库。
 */
export function getEnv(): AppEnv {
  if (cached) {
    return cached;
  }

  loadEnvFiles();

  const result = parseEnv();
  if (!result.ok) {
    process.stdout.write(
      `${JSON.stringify({
        timestamp: new Date().toISOString(),
        level: 'fatal',
        message: 'invalid environment configuration',
        invalidKeys: result.invalidKeys,
        issues: result.issues,
      })}\n`,
    );
    process.exit(1);
  }

  cached = result.env;
  return cached;
}
