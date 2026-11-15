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
  REDIS_COMMAND_TIMEOUT_MS: z.coerce.number().int().min(100).max(10000).default(1000),

  // 限流：读/写按租户+用户维度分桶，登录失败按账号维度锁定。
  RATE_LIMIT_ENABLED: z
    .enum(['true', 'false'])
    .default('true')
    .transform((value) => value === 'true'),
  RATE_LIMIT_WRITE_PER_MINUTE: z.coerce.number().int().min(1).max(100000).default(60),
  RATE_LIMIT_READ_PER_MINUTE: z.coerce.number().int().min(1).max(100000).default(300),
  RATE_LIMIT_LOGIN_MAX_ATTEMPTS: z.coerce.number().int().min(1).max(1000).default(5),
  RATE_LIMIT_LOGIN_LOCK_SECONDS: z.coerce.number().int().min(60).max(86400).default(600),

  // Outbox Worker：轮询间隔、批大小、租约、最大尝试次数与投递目标。
  OUTBOX_POLL_INTERVAL_MS: z.coerce.number().int().min(100).max(60000).default(1000),
  OUTBOX_BATCH_SIZE: z.coerce.number().int().min(1).max(200).default(20),
  OUTBOX_MAX_ATTEMPTS: z.coerce.number().int().min(1).max(50).default(8),
  OUTBOX_LEASE_SECONDS: z.coerce.number().int().min(5).max(3600).default(30),
  OUTBOX_WEBHOOK_URL: z.preprocess(
    (value) => (value === '' ? undefined : value),
    z.string().url().optional(),
  ),

  // 指标与告警：5xx 占比按百分比配置，避免浮点环境变量。
  METRICS_INTERVAL_SECONDS: z.coerce.number().int().min(5).max(600).default(30),
  ALERT_5XX_RATIO_PERCENT: z.coerce.number().int().min(0).max(100).default(1),
  ALERT_OUTBOX_BACKLOG_THRESHOLD: z.coerce.number().int().min(1).max(1000000).default(100),
  ALERT_LOGIN_FAILURE_PER_MINUTE: z.coerce.number().int().min(1).max(1000000).default(20),

  // 备份与恢复演练：仅 tools profile 使用。
  BACKUP_ENCRYPTION_PASSPHRASE: z.preprocess(
    (value) => (value === '' ? undefined : value),
    z.string().min(16).optional(),
  ),
  BACKUP_RETENTION_DAYS: z.coerce.number().int().min(1).max(365).default(7),
  BACKUP_DIR: z.string().min(1).default('/backups'),

  // 性能验证脚本目标地址。
  PERF_BASE_URL: z.string().url().default('http://localhost/api'),
  PERF_ITERATIONS: z.coerce.number().int().min(5).max(5000).default(50),

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
