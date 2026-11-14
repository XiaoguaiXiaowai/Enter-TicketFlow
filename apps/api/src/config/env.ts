import { z } from 'zod';

/**
 * 环境变量 schema 是配置键的唯一事实来源。
 * scripts/check-env-example.ts 会比对 .env.example 与本 schema 的键集合。
 */
export const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']),
  API_PORT: z.coerce.number().int().min(1).max(65535),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']),

  POSTGRES_DB: z.string().min(1),
  POSTGRES_SUPERUSER: z.string().min(1),
  POSTGRES_SUPERUSER_PASSWORD: z.string().min(1),

  DATABASE_URL: z.string().url(),
  MIGRATE_DATABASE_URL: z.string().url(),
  WORKER_DATABASE_URL: z.string().url(),

  REDIS_URL: z.string().url(),
});

export type AppEnv = z.infer<typeof envSchema>;

export type EnvParseResult =
  { ok: true; env: AppEnv } | { ok: false; invalidKeys: string[]; issues: string[] };

export function parseEnv(source: NodeJS.ProcessEnv = process.env): EnvParseResult {
  const result = envSchema.safeParse(source);
  if (result.success) {
    return { ok: true, env: result.data };
  }

  const invalidKeys = [
    ...new Set(
      result.error.issues.map((issue) => {
        const key = issue.path.join('.');
        return key.length > 0 ? key : 'UNKNOWN';
      }),
    ),
  ];
  const issues = result.error.issues.map((issue) => {
    const key = issue.path.join('.');
    return `${key}: ${issue.message}`;
  });

  return { ok: false, invalidKeys, issues };
}
