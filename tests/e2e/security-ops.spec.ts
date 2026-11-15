import { randomUUID } from 'node:crypto';

import { expect, test, type APIRequestContext, type Page } from '@playwright/test';

const PASSWORD = process.env.SEED_DEFAULT_PASSWORD ?? 'local_dev_seed_password';
const PROJECT_A1 = 'a1111111-1111-4111-8111-111111111111';

interface LoginBody {
  accessToken: string;
  user: { id: string; email: string };
}

interface KbArticleFixture {
  id: string;
  versions: { id: string; versionNo: number; status: string }[];
}

interface KbDetailBody {
  id: string;
  versions: { versionNo: number; status: string; body: string }[];
}

interface TicketFixture {
  id: string;
}

async function loginViaApi(
  request: APIRequestContext,
  email = 'lead-a@example.com',
  tenantCode = 'tenant-a',
): Promise<LoginBody> {
  const response = await request.post('/api/v1/auth/login', {
    data: { email, password: PASSWORD, tenantCode },
  });
  expect(response.status()).toBe(200);
  return (await response.json()) as LoginBody;
}

async function loginViaUi(page: Page, email: string, tenantCode = 'tenant-a'): Promise<void> {
  await page.goto('/login');
  await page.getByTestId('login-email').fill(email);
  await page.getByTestId('login-password').fill(PASSWORD);
  await page.getByTestId('login-tenant').fill(tenantCode);
  await page.getByTestId('login-submit').click();
  await expect(page.getByRole('heading', { name: '客服工作台' })).toBeVisible();
}

function authHeaders(accessToken: string): Record<string, string> {
  return { Authorization: `Bearer ${accessToken}`, 'X-Project-Id': PROJECT_A1 };
}

test.describe('@security I4 安全加固', () => {
  test('站点与接口均返回安全响应头', async ({ request }) => {
    const pageResponse = await request.get('/');
    expect(pageResponse.status()).toBe(200);
    const pageHeaders = pageResponse.headers();
    const csp = pageHeaders['content-security-policy'] ?? '';
    expect(csp).toContain("default-src 'self'");
    expect(csp).toContain("frame-ancestors 'none'");
    expect(csp).toContain("object-src 'none'");
    expect(pageHeaders['x-content-type-options']).toBe('nosniff');
    expect(pageHeaders['x-frame-options']).toBe('DENY');
    expect(pageHeaders['referrer-policy']).toContain('strict-origin-when-cross-origin');
    expect(pageHeaders['permissions-policy']).toContain('camera=()');

    const apiResponse = await request.get('/api/health/live');
    expect(apiResponse.status()).toBe(200);
    expect(apiResponse.headers()['content-security-policy']).toContain("default-src 'none'");
    expect(apiResponse.headers()['x-content-type-options']).toBe('nosniff');
    expect(apiResponse.headers()['referrer-policy']).toContain('no-referrer');
  });

  test('健康检查暴露依赖状态，指标端点不对外暴露', async ({ request }) => {
    const ready = await request.get('/api/health/ready');
    expect(ready.status()).toBe(200);
    const body = (await ready.json()) as { checks: { redis: string; migrations: unknown } };
    expect(['up', 'degraded']).toContain(body.checks.redis);
    expect(body.checks.migrations).toBeDefined();

    const metrics = await request.get('/api/metrics');
    expect(metrics.status()).toBe(404);
  });

  test('知识库正文中的脚本、事件属性与危险协议被清洗', async ({ request }) => {
    const login = await loginViaApi(request);
    const created = await request.post('/api/v1/kb/articles', {
      headers: authHeaders(login.accessToken),
      data: {
        slug: `xss-${randomUUID()}`,
        title: `XSS 用例-${randomUUID()}`,
        body:
          '<p>退款政策</p><script>window.__xss = true</script>' +
          '<img src="x" onerror="window.__xss = true">' +
          '<a href="javascript:window.__xss = true">点我</a>' +
          '<strong>保留加粗</strong>',
      },
    });
    expect(created.status()).toBe(201);
    const article = (await created.json()) as KbArticleFixture;

    const published = await request.post(`/api/v1/kb/articles/${article.id}/publish`, {
      headers: authHeaders(login.accessToken),
      data: { versionNo: 1 },
    });
    expect(published.status()).toBe(200);

    const detail = await request.get(`/api/v1/kb/articles/${article.id}`, {
      headers: authHeaders(login.accessToken),
    });
    expect(detail.status()).toBe(200);
    const body = (await detail.json()) as KbDetailBody;
    const version = body.versions.find((item) => item.versionNo === 1);
    expect(version).toBeDefined();
    expect(version?.body).toContain('<strong>保留加粗</strong>');
    expect(version?.body).not.toContain('<script');
    expect(version?.body).not.toContain('onerror');
    expect(version?.body).not.toContain('javascript:');
  });

  test('工单消息中的脚本只作为文本展示，页面不执行', async ({ request, page }) => {
    const login = await loginViaApi(request, 'agent-a@example.com');
    const created = await request.post('/api/v1/tickets', {
      headers: { ...authHeaders(login.accessToken), 'Idempotency-Key': randomUUID() },
      data: {
        subject: `XSS 消息-${randomUUID()}`,
        description: '安全用例工单',
        customerName: '张先生',
      },
    });
    expect(created.status()).toBe(201);
    const ticket = (await created.json()) as TicketFixture;

    const payload = '<script>window.__xss = true</script><b>加粗</b>';
    const message = await request.post(`/api/v1/tickets/${ticket.id}/messages`, {
      headers: { ...authHeaders(login.accessToken), 'Idempotency-Key': randomUUID() },
      data: { body: payload, visibility: 'PUBLIC' },
    });
    expect(message.status()).toBe(201);

    let dialogFired = false;
    page.on('dialog', async (dialog) => {
      dialogFired = true;
      await dialog.dismiss();
    });

    await loginViaUi(page, 'agent-a@example.com');
    await page.goto(`/tickets/${ticket.id}?projectId=${PROJECT_A1}`);
    await expect(page.getByTestId('message-list')).toContainText(payload);

    expect(await page.evaluate(() => (window as { __xss?: boolean }).__xss ?? null)).toBeNull();
    expect(dialogFired).toBe(false);
  });
});

test.describe('@rate I4 限流与降级可见性', () => {
  test('同一账号连续 5 次失败后锁定，其他账号不受影响', async ({ request }) => {
    const email = `lockout-${randomUUID()}@example.com`;
    const attempt = () =>
      request.post('/api/v1/auth/login', {
        data: { email, password: 'definitely-wrong-password', tenantCode: 'tenant-a' },
      });

    for (let index = 0; index < 5; index += 1) {
      const failed = await attempt();
      expect(failed.status()).toBe(401);
    }

    const locked = await attempt();
    expect(locked.status()).toBe(429);
    const body = (await locked.json()) as { error: { code: string } };
    expect(body.error.code).toBe('AUTH_LOGIN_LOCKED');
    expect(Number(locked.headers()['retry-after'])).toBeGreaterThan(0);

    const other = await loginViaApi(request, 'agent-a@example.com');
    expect(other.accessToken).not.toBe('');
  });

  test('读写请求返回限流配额响应头', async ({ request }) => {
    const login = await loginViaApi(request, 'agent-a@example.com');

    const read = await request.get('/api/v1/me/permissions', {
      headers: authHeaders(login.accessToken),
    });
    expect(read.status()).toBe(200);
    expect(read.headers()['x-ratelimit-limit']).toBe('300');
    expect(Number(read.headers()['x-ratelimit-remaining'])).toBeGreaterThanOrEqual(0);

    const write = await request.post('/api/v1/tickets', {
      headers: { ...authHeaders(login.accessToken), 'Idempotency-Key': randomUUID() },
      data: {
        subject: `限流头-${randomUUID()}`,
        description: '限流用例工单',
        customerName: '张先生',
      },
    });
    expect(write.status()).toBe(201);
    expect(write.headers()['x-ratelimit-limit']).toBe('60');
  });
});