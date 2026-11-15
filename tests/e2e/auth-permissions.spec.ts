import { randomUUID } from 'node:crypto';

import { expect, test, type APIRequestContext, type Page } from '@playwright/test';

const PASSWORD = process.env.SEED_DEFAULT_PASSWORD ?? 'local_dev_seed_password';

// 与 seed 中固定 ID 保持一致：跨租户/跨项目用例直接引用。
const PROJECT_A1 = 'a1111111-1111-4111-8111-111111111111';
const PROJECT_A2 = 'a2222222-2222-4222-8222-222222222222';
const PROJECT_B1 = 'b1111111-1111-4111-8111-111111111111';

interface LoginBody {
  accessToken: string;
  user: { id: string; email: string };
  tenant: { id: string; code: string; name: string };
}

interface TicketFixture {
  id: string;
  version: number;
}

async function createTicketViaApi(
  request: APIRequestContext,
  accessToken: string,
  projectId: string,
): Promise<TicketFixture> {
  const response = await request.post('/api/v1/tickets', {
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'X-Project-Id': projectId,
      'Idempotency-Key': randomUUID(),
    },
    data: {
      subject: `权限用例-${randomUUID()}`,
      description: '权限用例工单',
      customerName: '张先生',
      customerPhone: '13800001234',
    },
  });
  expect(response.status()).toBe(201);
  return (await response.json()) as TicketFixture;
}

async function loginViaApi(
  request: APIRequestContext,
  email: string,
  tenantCode: string,
): Promise<LoginBody> {
  const response = await request.post('/api/v1/auth/login', {
    data: { email, password: PASSWORD, tenantCode },
  });
  expect(response.status()).toBe(200);
  return (await response.json()) as LoginBody;
}

async function loginViaUi(
  page: Page,
  options: { email: string; tenantCode: string },
): Promise<void> {
  await page.goto('/login');
  await page.getByTestId('login-email').fill(options.email);
  await page.getByTestId('login-password').fill(PASSWORD);
  await page.getByTestId('login-tenant').fill(options.tenantCode);
  await page.getByTestId('login-submit').click();
  await expect(page.getByRole('heading', { name: '客服工作台' })).toBeVisible();
}

test.describe('@permissions I1 认证、租户与字段权限', () => {
  test('登录成功，刷新页面保持会话且 access token 不落 Web Storage', async ({ page }) => {
    await loginViaUi(page, { email: 'agent-a@example.com', tenantCode: 'tenant-a' });

    await expect(page.getByTestId('tenant-name')).toHaveText('演示租户 A');
    await expect(page.getByTestId('role-list')).toContainText('客服');

    const storage = await page.evaluate(() => ({
      local: JSON.stringify(localStorage),
      session: JSON.stringify(sessionStorage),
    }));
    expect(storage.local).not.toContain('accessToken');
    expect(storage.session).not.toContain('accessToken');

    await page.reload();
    await expect(page.getByRole('heading', { name: '客服工作台' })).toBeVisible();
    await expect(page.getByTestId('tenant-name')).toHaveText('演示租户 A');
  });

  test('刷新凭据一次性使用，旧 refresh token 重放返回 401', async ({ playwright, request }) => {
    await loginViaApi(request, 'agent-a@example.com', 'tenant-a');

    const cookieHeader = (await request.storageState()).cookies.find(
      (cookie) => cookie.name === 'refresh_token',
    );
    expect(cookieHeader).toBeDefined();
    const oldToken = cookieHeader?.value ?? '';

    const rotated = await request.post('/api/v1/auth/refresh');
    expect(rotated.status()).toBe(200);

    const replayContext = await playwright.request.newContext({
      baseURL: process.env.E2E_BASE_URL ?? 'http://localhost',
    });
    try {
      const replay = await replayContext.post('/api/v1/auth/refresh', {
        headers: { Cookie: `refresh_token=${oldToken}` },
      });
      expect(replay.status()).toBe(401);
      const body = (await replay.json()) as { error: { code: string } };
      expect(body.error.code).toBe('REFRESH_TOKEN_INVALID');
    } finally {
      await replayContext.dispose();
    }
  });

  test('登出撤销会话，旧 access token 立即失效', async ({ request }) => {
    const login = await loginViaApi(request, 'agent-a@example.com', 'tenant-a');

    const me = await request.get('/api/v1/me/permissions', {
      headers: { Authorization: `Bearer ${login.accessToken}` },
    });
    expect(me.status()).toBe(200);

    const logout = await request.post('/api/v1/auth/logout', {
      headers: { Authorization: `Bearer ${login.accessToken}` },
    });
    expect(logout.status()).toBe(204);

    const after = await request.get('/api/v1/me/permissions', {
      headers: { Authorization: `Bearer ${login.accessToken}` },
    });
    expect(after.status()).toBe(401);
    const body = (await after.json()) as { error: { code: string } };
    expect(body.error.code).toBe('SESSION_INVALID');
  });

  test('未认证访问受保护接口返回 401', async ({ request }) => {
    const response = await request.get('/api/v1/me/permissions');
    expect(response.status()).toBe(401);
  });

  test('外包坐席读取时内部备注与退款金额缺失，手机号脱敏', async ({ request, page }) => {
    const login = await loginViaApi(request, 'contractor-a@example.com', 'tenant-a');
    const auth = { Authorization: `Bearer ${login.accessToken}` };
    const agentLogin = await loginViaApi(request, 'agent-a@example.com', 'tenant-a');
    const ticket = await createTicketViaApi(request, agentLogin.accessToken, PROJECT_A1);

    const me = await request.get('/api/v1/me/permissions', { headers: auth });
    expect(me.status()).toBe(200);
    const permissions = (await me.json()) as {
      roles: { code: string }[];
      fields: { field: string; canRead: boolean; masked: boolean }[];
    };
    expect(permissions.roles.map((role) => role.code)).toEqual(['contractor']);
    expect(permissions.fields).toEqual([
      { resource: 'ticket', field: 'customerPhone', canRead: true, canWrite: false, masked: true },
    ]);

    const detail = await request.get(`/api/v1/tickets/${ticket.id}`, {
      headers: { ...auth, 'X-Project-Id': PROJECT_A1 },
    });
    expect(detail.status()).toBe(200);
    const body = (await detail.json()) as Record<string, unknown>;
    expect(body['customerPhone']).toBe('*******1234');
    expect(body).not.toHaveProperty('internalNote');
    expect(body).not.toHaveProperty('refundAmount');

    const update = await request.patch(`/api/v1/tickets/${ticket.id}`, {
      headers: { ...auth, 'X-Project-Id': PROJECT_A1, 'If-Match': '"1"' },
      data: { internalNote: '越权写入' },
    });
    expect(update.status()).toBe(403);

    await loginViaUi(page, { email: 'contractor-a@example.com', tenantCode: 'tenant-a' });
    await expect(page.getByTestId('menu-internal-note')).toHaveCount(0);
    await page.goto(`/tickets/${ticket.id}?projectId=${PROJECT_A1}`);
    await expect(page.getByTestId('ticket-phone')).toHaveText('*******1234');
    await expect(page.getByTestId('ticket-internal-note')).toHaveCount(0);
    await expect(page.getByTestId('ticket-refund')).toHaveCount(0);
  });

  test('客服写入退款金额被字段策略拒绝，内部备注可读写', async ({ request, page }) => {
    const login = await loginViaApi(request, 'agent-a@example.com', 'tenant-a');
    const auth = { Authorization: `Bearer ${login.accessToken}` };
    const ticket = await createTicketViaApi(request, login.accessToken, PROJECT_A1);

    const denied = await request.patch(`/api/v1/tickets/${ticket.id}`, {
      headers: { ...auth, 'X-Project-Id': PROJECT_A1, 'If-Match': '"1"' },
      data: { refundAmount: 10 },
    });
    expect(denied.status()).toBe(403);
    const deniedBody = (await denied.json()) as { error: { code: string; details: unknown } };
    expect(deniedBody.error.code).toBe('FIELD_DENIED');
    expect(JSON.stringify(deniedBody.error.details)).toContain('refundAmount');

    const allowed = await request.patch(`/api/v1/tickets/${ticket.id}`, {
      headers: { ...auth, 'X-Project-Id': PROJECT_A1, 'If-Match': '"1"' },
      data: { internalNote: '已回访' },
    });
    expect(allowed.status()).toBe(200);
    expect(((await allowed.json()) as Record<string, unknown>)['internalNote']).toBe('已回访');

    const unknownField = await request.patch(`/api/v1/tickets/${ticket.id}`, {
      headers: { ...auth, 'X-Project-Id': PROJECT_A1, 'If-Match': '"2"' },
      data: { secretField: 'x' },
    });
    expect(unknownField.status()).toBe(400);
    expect(JSON.stringify(await unknownField.json())).toContain('secretField');

    await loginViaUi(page, { email: 'agent-a@example.com', tenantCode: 'tenant-a' });
    await expect(page.getByTestId('menu-internal-note')).toBeVisible();
    await page.goto(`/tickets/${ticket.id}?projectId=${PROJECT_A1}`);
    await expect(page.getByTestId('ticket-phone')).toHaveText('13800001234');
    await expect(page.getByTestId('ticket-internal-note')).toBeVisible();
    await expect(page.getByTestId('refund-save')).toHaveCount(0);
    await expect(page.getByTestId('internal-note-save')).toBeVisible();
  });

  test('主管可写退款金额并可见审计入口', async ({ request, page }) => {
    const login = await loginViaApi(request, 'lead-a@example.com', 'tenant-a');
    const auth = { Authorization: `Bearer ${login.accessToken}` };
    const ticket = await createTicketViaApi(request, login.accessToken, PROJECT_A2);

    const updated = await request.patch(`/api/v1/tickets/${ticket.id}`, {
      headers: { ...auth, 'X-Project-Id': PROJECT_A2, 'If-Match': '"1"' },
      data: { refundAmount: 66.6 },
    });
    expect(updated.status()).toBe(200);
    expect(((await updated.json()) as Record<string, unknown>)['refundAmount']).toBe(66.6);

    await loginViaUi(page, { email: 'lead-a@example.com', tenantCode: 'tenant-a' });
    await expect(page.getByTestId('menu-audit')).toBeVisible();
    await expect(page.getByTestId('menu-refund')).toBeVisible();
  });

  test('跨租户项目资源返回 404 且页面不泄露字段', async ({ request, page }) => {
    const login = await loginViaApi(request, 'agent-a@example.com', 'tenant-a');
    const auth = { Authorization: `Bearer ${login.accessToken}` };
    const ticket = await createTicketViaApi(request, login.accessToken, PROJECT_A1);

    const response = await request.get(`/api/v1/tickets/${ticket.id}`, {
      headers: { ...auth, 'X-Project-Id': PROJECT_B1 },
    });
    expect(response.status()).toBe(404);
    const body = (await response.json()) as { error: { code: string } };
    expect(body.error.code).toBe('PROJECT_NOT_FOUND');

    await loginViaUi(page, { email: 'agent-a@example.com', tenantCode: 'tenant-a' });
    await page.goto(`/tickets/${ticket.id}?projectId=${PROJECT_B1}`);
    await expect(page.getByTestId('ticket-not-found')).toBeVisible();
    await expect(page.getByText('13800001234')).toHaveCount(0);
  });

  test('同租户未授权项目返回 403，缺少项目上下文返回 400', async ({ request }) => {
    const contractor = await loginViaApi(request, 'contractor-a@example.com', 'tenant-a');
    const contractorAuth = { Authorization: `Bearer ${contractor.accessToken}` };
    const missingTicketId = randomUUID();

    const forbidden = await request.get(`/api/v1/tickets/${missingTicketId}`, {
      headers: { ...contractorAuth, 'X-Project-Id': PROJECT_A2 },
    });
    expect(forbidden.status()).toBe(403);
    expect(((await forbidden.json()) as { error: { code: string } }).error.code).toBe(
      'PROJECT_FORBIDDEN',
    );

    const missing = await request.get(`/api/v1/tickets/${missingTicketId}`, {
      headers: contractorAuth,
    });
    expect(missing.status()).toBe(400);
    expect(((await missing.json()) as { error: { code: string } }).error.code).toBe(
      'PROJECT_REQUIRED',
    );
  });

  test('切换租户后角色、菜单与字段展示随之变化', async ({ page, request }) => {
    const agentB = await loginViaApi(request, 'agent-b@example.com', 'tenant-b');
    const ticket = await createTicketViaApi(request, agentB.accessToken, PROJECT_B1);

    await loginViaUi(page, { email: 'agent-a@example.com', tenantCode: 'tenant-a' });
    await expect(page.getByTestId('menu-internal-note')).toBeVisible();
    await expect(page.getByTestId('role-list')).toContainText('客服');

    await page.getByTestId('switch-tenant').click();
    await expect(page.getByRole('heading', { name: '登录' })).toBeVisible();

    await loginViaUi(page, { email: 'agent-a@example.com', tenantCode: 'tenant-b' });
    await expect(page.getByTestId('header-tenant')).toHaveText('演示租户 B');
    await expect(page.getByTestId('role-list')).toContainText('外包坐席');
    await expect(page.getByTestId('menu-internal-note')).toHaveCount(0);

    await page.goto(`/tickets/${ticket.id}?projectId=${PROJECT_B1}`);
    await expect(page.getByTestId('ticket-phone')).toHaveText('*******1234');
    await expect(page.getByTestId('ticket-internal-note')).toHaveCount(0);
  });
});
