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

  // 认证：HS256 对称密钥仅用于本地与预发；生产改由密钥文件注入。
  JWT_SECRET: z.string().min(32, 'JWT_SECRET 至少 32 个字符'),
  ACCESS_TOKEN_TTL_SECONDS: z.coerce.number().int().min(60).max(3600).default(900),
  REFRESH_TOKEN_TTL_SECONDS: z.coerce.number().int().min(300).max(2592000).default(604800),

  // Argon2id 参数，随硬件评估调整。
  ARGON2_MEMORY_KIB: z.coerce.number().int().min(8192).max(1048576).default(19456),
  ARGON2_TIME_COST: z.coerce.number().int().min(2).max(10).default(2),
  ARGON2_PARALLELISM: z.coerce.number().int().min(1).max(8).default(1),

  // seed 只用于演示租户，生产环境不执行。
  SEED_DEFAULT_PASSWORD: z.string().min(8),
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
