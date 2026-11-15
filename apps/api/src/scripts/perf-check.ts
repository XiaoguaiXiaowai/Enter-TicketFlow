import { getEnv } from '../config/runtime';
import { PermissionCacheService } from '../iam/permission-cache.service';
import { MetricsService } from '../observability/metrics.service';
import { PrismaService } from '../prisma/prisma.service';

interface Sample {
  name: string;
  budgetMs: number;
  values: number[];
}

interface LoginResponseBody {
  accessToken: string;
}

interface PermissionsResponseBody {
  projects: Array<{ id: string; code: string }>;
}

const BUDGETS = {
  permissions: 50,
  list: 300,
  detail: 150,
  create: 250,
  kbSearch: 300,
};

/** 架构文档预算：权限求值（缓存命中）P95 ≤ 5ms，这里测进程内 can() 调用。 */
const PERMISSION_EVAL_BUDGET_MS = 5;
const PERMISSION_EVAL_ITERATIONS = 2000;

function p95(values: number[]): number {
  if (values.length === 0) {
    return 0;
  }
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.ceil(sorted.length * 0.95) - 1);
  return sorted[index] ?? 0;
}

async function timed(fn: () => Promise<unknown>): Promise<number> {
  const startedAt = process.hrtime.bigint();
  await fn();
  return Number(process.hrtime.bigint() - startedAt) / 1_000_000;
}

/**
 * 权限求值预算针对进程内 can()，走的是 60 秒策略缓存；
 * 放在 perf-check 内测量，避免把 HTTP 与鉴权开销算进这道 5ms 预算。
 */
async function permissionEvalP95(): Promise<number> {
  const prisma = new PrismaService(new MetricsService());
  const cache = new PermissionCacheService(prisma);
  try {
    const tenant = await prisma.tenant.findUniqueOrThrow({ where: { code: 'tenant-a' } });
    const user = await prisma.user.findUniqueOrThrow({ where: { email: 'agent-a@example.com' } });
    const membership = await prisma.withTenant(tenant.id, (tx) =>
      tx.membership.findFirstOrThrow({
        where: { userId: user.id, status: 'ACTIVE' },
        select: { roles: { select: { roleId: true } } },
      }),
    );
    const roleIds = membership.roles.map((row) => row.roleId);
    if (roleIds.length === 0) {
      throw new Error('agent-a has no role assigned');
    }

    // 预热：首次调用会加载策略快照，不计入样本。
    await cache.can(tenant.id, roleIds, 'ticket', 'read');

    const values: number[] = [];
    for (let index = 0; index < PERMISSION_EVAL_ITERATIONS; index += 1) {
      const startedAt = process.hrtime.bigint();
      await cache.can(tenant.id, roleIds, 'ticket', 'read');
      values.push(Number(process.hrtime.bigint() - startedAt) / 1_000_000);
    }
    return p95(values);
  } finally {
    await prisma.$disconnect();
  }
}

async function main(): Promise<void> {
  const env = getEnv();
  const baseUrl = env.PERF_BASE_URL.replace(/\/$/, '');
  const iterations = env.PERF_ITERATIONS;

  const loginResponse = await fetch(`${baseUrl}/v1/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      tenantCode: 'tenant-a',
      email: 'agent-a@example.com',
      password: process.env.SEED_DEFAULT_PASSWORD ?? 'local_dev_seed_password',
    }),
  });
  if (!loginResponse.ok) {
    throw new Error(`login failed: ${loginResponse.status} ${await loginResponse.text()}`);
  }
  const { accessToken } = (await loginResponse.json()) as LoginResponseBody;
  const headers = { authorization: `Bearer ${accessToken}` };

  const permissionsResponse = await fetch(`${baseUrl}/v1/me/permissions`, { headers });
  if (!permissionsResponse.ok) {
    throw new Error(`permissions failed: ${permissionsResponse.status}`);
  }
  const permissions = (await permissionsResponse.json()) as PermissionsResponseBody;
  const project = permissions.projects[0];
  if (project === undefined) {
    throw new Error('no project available for perf check');
  }
  const projectHeaders = { ...headers, 'x-project-id': project.id };

  const createTicket = async (): Promise<void> => {
    const response = await fetch(`${baseUrl}/v1/tickets`, {
      method: 'POST',
      headers: {
        ...projectHeaders,
        'content-type': 'application/json',
        'idempotency-key': crypto.randomUUID(),
      },
      body: JSON.stringify({
        subject: `性能验证 ${Date.now()}`,
        description: 'perf-check 自动创建的工单，可忽略。',
        customerName: 'perf-check',
        priority: 'NORMAL',
        source: 'WEB',
      }),
    });
    if (!response.ok) {
      throw new Error(`create ticket failed: ${response.status}`);
    }
  };

  await createTicket();
  const listResponse = await fetch(`${baseUrl}/v1/tickets?limit=50`, { headers: projectHeaders });
  const list = (await listResponse.json()) as { items: Array<{ id: string }> };
  const ticketId = list.items[0]?.id;
  if (ticketId === undefined) {
    throw new Error('ticket list is empty');
  }

  const samples: Sample[] = [
    {
      name: `GET /v1/me/permissions（权限摘要接口，含鉴权）`,
      budgetMs: BUDGETS.permissions,
      values: [],
    },
    { name: 'GET /v1/tickets?limit=50', budgetMs: BUDGETS.list, values: [] },
    { name: 'GET /v1/tickets/:id', budgetMs: BUDGETS.detail, values: [] },
    { name: 'POST /v1/tickets', budgetMs: BUDGETS.create, values: [] },
    { name: 'GET /v1/kb/articles?q=退款', budgetMs: BUDGETS.kbSearch, values: [] },
  ];

  // 每个场景先预热 3 次，排除首次连接与 JIT 抖动。
  for (let index = 0; index < 3; index += 1) {
    await fetch(`${baseUrl}/v1/me/permissions`, { headers });
    await fetch(`${baseUrl}/v1/tickets?limit=50`, { headers: projectHeaders });
    await fetch(`${baseUrl}/v1/tickets/${ticketId}`, { headers: projectHeaders });
    await fetch(`${baseUrl}/v1/kb/articles?q=${encodeURIComponent('退款')}&limit=20`, {
      headers: projectHeaders,
    });
  }

  for (let index = 0; index < iterations; index += 1) {
    samples[0]?.values.push(await timed(() => fetch(`${baseUrl}/v1/me/permissions`, { headers })));
    samples[1]?.values.push(
      await timed(() => fetch(`${baseUrl}/v1/tickets?limit=50`, { headers: projectHeaders })),
    );
    samples[2]?.values.push(
      await timed(() => fetch(`${baseUrl}/v1/tickets/${ticketId}`, { headers: projectHeaders })),
    );
    samples[4]?.values.push(
      await timed(() =>
        fetch(`${baseUrl}/v1/kb/articles?q=${encodeURIComponent('退款')}&limit=20`, {
          headers: projectHeaders,
        }),
      ),
    );
  }

  // 写请求计入 60 次/分钟限流，控制在 20 次以内。
  for (let index = 0; index < Math.min(iterations, 20); index += 1) {
    samples[3]?.values.push(await timed(createTicket));
  }

  let failed = false;
  process.stdout.write(`perf-check baseUrl=${baseUrl} iterations=${iterations}\n`);
  for (const sample of samples) {
    const value = p95(sample.values);
    const passed = value <= sample.budgetMs;
    failed ||= !passed;
    process.stdout.write(
      `${passed ? 'PASS' : 'FAIL'} p95=${value.toFixed(1)}ms budget=${sample.budgetMs}ms samples=${sample.values.length} ${sample.name}\n`,
    );
  }

  const evalP95 = await permissionEvalP95();
  const evalPassed = evalP95 <= PERMISSION_EVAL_BUDGET_MS;
  failed ||= !evalPassed;
  process.stdout.write(
    `${evalPassed ? 'PASS' : 'FAIL'} p95=${evalP95.toFixed(3)}ms budget=${PERMISSION_EVAL_BUDGET_MS}ms samples=${PERMISSION_EVAL_ITERATIONS} 进程内权限求值 can()\n`,
  );

  if (failed) {
    process.exitCode = 1;
  }
}

main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
  process.exit(1);
});