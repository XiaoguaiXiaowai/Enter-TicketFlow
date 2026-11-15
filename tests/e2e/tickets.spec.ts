import { randomUUID } from 'node:crypto';

import { expect, test, type APIRequestContext, type Page } from '@playwright/test';

const PASSWORD = process.env.SEED_DEFAULT_PASSWORD ?? 'local_dev_seed_password';
const PROJECT_A1 = 'a1111111-1111-4111-8111-111111111111';

interface LoginBody {
  accessToken: string;
  user: { id: string; email: string };
}

interface TicketFixture {
  id: string;
  ticketNo: string;
  subject: string;
  status: string;
  version: number;
}

async function loginViaApi(
  request: APIRequestContext,
  email: string,
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
  return {
    Authorization: `Bearer ${accessToken}`,
    'X-Project-Id': PROJECT_A1,
  };
}

async function createTicket(
  request: APIRequestContext,
  accessToken: string,
  subject: string,
): Promise<TicketFixture> {
  const response = await request.post('/api/v1/tickets', {
    headers: { ...authHeaders(accessToken), 'Idempotency-Key': randomUUID() },
    data: {
      subject,
      description: 'I2 验收用例工单',
      customerName: '张先生',
      customerPhone: '13800001234',
    },
  });
  expect(response.status()).toBe(201);
  return (await response.json()) as TicketFixture;
}

test.describe('@idempotency I2 建单幂等', () => {
  test('相同 Idempotency-Key 并发提交只产生一张工单', async ({ request }) => {
    const login = await loginViaApi(request, 'agent-a@example.com');
    const subject = `幂等并发-${randomUUID()}`;
    const key = randomUUID();
    const payload = {
      subject,
      description: '并发幂等用例',
      customerName: '张先生',
      customerPhone: '13800001234',
    };

    const responses = await Promise.all([
      request.post('/api/v1/tickets', {
        headers: { ...authHeaders(login.accessToken), 'Idempotency-Key': key },
        data: payload,
      }),
      request.post('/api/v1/tickets', {
        headers: { ...authHeaders(login.accessToken), 'Idempotency-Key': key },
        data: payload,
      }),
    ]);

    const statuses = responses.map((response) => response.status()).sort();
    expect(statuses).toEqual([200, 201]);

    const created = responses.find((response) => response.status() === 201);
    const replayed = responses.find((response) => response.status() === 200);
    expect(created).toBeDefined();
    expect(replayed?.headers()['idempotent-replay']).toBe('true');

    const createdBody = (await created?.json()) as TicketFixture;
    const replayedBody = (await replayed?.json()) as TicketFixture;
    expect(replayedBody.id).toBe(createdBody.id);
    expect(replayedBody.ticketNo).toBe(createdBody.ticketNo);
    expect(replayedBody.subject).toBe(subject);

    const list = await request.get('/api/v1/tickets?limit=50', {
      headers: authHeaders(login.accessToken),
    });
    expect(list.status()).toBe(200);
    const page = (await list.json()) as { items: TicketFixture[] };
    expect(page.items.filter((item) => item.subject === subject)).toHaveLength(1);
  });

  test('双击提交按钮只创建一张工单', async ({ page, request }) => {
    const login = await loginViaApi(request, 'agent-a@example.com');
    const subject = `双击建单-${randomUUID()}`;

    await loginViaUi(page, 'agent-a@example.com');
    await page.goto(`/tickets/new?projectId=${PROJECT_A1}`);
    await page.getByTestId('subject-input').fill(subject);
    await page.getByTestId('description-input').fill('双击提交防重复');
    await page.getByTestId('customer-name-input').fill('张先生');
    await page.getByTestId('customer-phone-input').fill('13800001234');

    // 两次快速点击：客户端 submitting 守卫 + 服务端同一幂等键都应保证只建一张单。
    await Promise.all([
      page.getByTestId('submit-ticket').click({ force: true }),
      page.getByTestId('submit-ticket').click({ force: true }),
    ]);
    await expect(page).toHaveURL(/\/tickets\/[0-9a-f-]{36}/);
    await expect(page.getByTestId('ticket-no')).toContainText('SUP-');

    const list = await request.get('/api/v1/tickets?limit=50', {
      headers: authHeaders(login.accessToken),
    });
    const page1 = (await list.json()) as { items: TicketFixture[] };
    expect(page1.items.filter((item) => item.subject === subject)).toHaveLength(1);
  });

  test('消息重试使用同一幂等键不会重复写入', async ({ request }) => {
    const login = await loginViaApi(request, 'agent-a@example.com');
    const ticket = await createTicket(request, login.accessToken, `消息幂等-${randomUUID()}`);
    const key = randomUUID();

    const first = await request.post(`/api/v1/tickets/${ticket.id}/messages`, {
      headers: { ...authHeaders(login.accessToken), 'Idempotency-Key': key },
      data: { body: '重试消息', visibility: 'PUBLIC' },
    });
    const second = await request.post(`/api/v1/tickets/${ticket.id}/messages`, {
      headers: { ...authHeaders(login.accessToken), 'Idempotency-Key': key },
      data: { body: '重试消息', visibility: 'PUBLIC' },
    });

    expect(first.status()).toBe(201);
    expect(second.status()).toBe(200);
    expect(second.headers()['idempotent-replay']).toBe('true');

    const firstBody = (await first.json()) as { id: string; seq: number };
    const secondBody = (await second.json()) as { id: string; seq: number };
    expect(secondBody.id).toBe(firstBody.id);

    const detail = await request.get(`/api/v1/tickets/${ticket.id}`, {
      headers: authHeaders(login.accessToken),
    });
    const detailBody = (await detail.json()) as { messages: { id: string }[] };
    expect(detailBody.messages.filter((message) => message.id === firstBody.id)).toHaveLength(1);
  });
});

test.describe('@concurrency I2 乐观锁', () => {
  test('两个客户端用同一版本更新，后提交返回 409', async ({ request }) => {
    const login = await loginViaApi(request, 'agent-a@example.com');
    const ticket = await createTicket(request, login.accessToken, `并发更新-${randomUUID()}`);
    const headers = { ...authHeaders(login.accessToken), 'If-Match': `"${ticket.version}"` };

    const [first, second] = await Promise.all([
      request.patch(`/api/v1/tickets/${ticket.id}`, {
        headers,
        data: { priority: 'HIGH' },
      }),
      request.patch(`/api/v1/tickets/${ticket.id}`, {
        headers,
        data: { priority: 'LOW' },
      }),
    ]);

    expect([first.status(), second.status()].sort()).toEqual([200, 409]);
    const conflict = first.status() === 409 ? first : second;
    const body = (await conflict.json()) as { error: { code: string; details: unknown } };
    expect(body.error.code).toBe('VERSION_CONFLICT');
    expect(JSON.stringify(body.error.details)).toContain('currentVersion');
  });

  test('并发冲突后页面提示并保留输入，刷新版本后可再次保存', async ({ page, request }) => {
    const login = await loginViaApi(request, 'agent-a@example.com');
    const ticket = await createTicket(request, login.accessToken, `冲突界面-${randomUUID()}`);

    await loginViaUi(page, 'agent-a@example.com');
    await page.goto(`/tickets/${ticket.id}?projectId=${PROJECT_A1}`);
    await expect(page.getByTestId('ticket-version')).toHaveText(`v${ticket.version}`);

    // 模拟另一个坐席先行更新，使页面持有的版本过期。
    const other = await request.patch(`/api/v1/tickets/${ticket.id}`, {
      headers: { ...authHeaders(login.accessToken), 'If-Match': `"${ticket.version}"` },
      data: { priority: 'HIGH' },
    });
    expect(other.status()).toBe(200);

    await page.getByTestId('ticket-status-select').selectOption('PENDING');
    await page.getByTestId('ticket-save').click();

    await expect(page.getByTestId('ticket-conflict')).toBeVisible();
    await expect(page.getByTestId('ticket-version')).toHaveText(`v${ticket.version + 1}`);
    await expect(page.getByTestId('ticket-status-select')).toHaveValue('PENDING');

    await page.getByTestId('ticket-save').click();
    await expect(page.getByTestId('ticket-conflict')).toHaveCount(0);
    await expect(page.getByTestId('ticket-status')).toHaveText('处理中');
  });
});

test.describe('@audit I2 审计与列表', () => {
  test('审计页展示创建与状态变更两条记录', async ({ page, request }) => {
    const login = await loginViaApi(request, 'agent-a@example.com');
    const ticket = await createTicket(request, login.accessToken, `审计展示-${randomUUID()}`);

    const updated = await request.patch(`/api/v1/tickets/${ticket.id}`, {
      headers: { ...authHeaders(login.accessToken), 'If-Match': `"${ticket.version}"` },
      data: { status: 'PENDING' },
    });
    expect(updated.status()).toBe(200);

    await loginViaUi(page, 'agent-a@example.com');
    await page.goto(`/tickets/${ticket.id}?projectId=${PROJECT_A1}`);

    const audit = page.getByTestId('audit-list');
    await expect(audit).toBeVisible();
    await expect(audit.locator('.audit-item')).toHaveCount(2);
    await expect(audit).toContainText('创建');
    await expect(audit).toContainText('更新');
    await expect(audit).toContainText('status');
  });

  test('工单列表展示新建工单并支持状态筛选', async ({ page, request }) => {
    const login = await loginViaApi(request, 'agent-a@example.com');
    const openSubject = `列表待处理-${randomUUID()}`;
    const pendingSubject = `列表处理中-${randomUUID()}`;
    const openTicket = await createTicket(request, login.accessToken, openSubject);
    const pendingTicket = await createTicket(request, login.accessToken, pendingSubject);

    const moved = await request.patch(`/api/v1/tickets/${pendingTicket.id}`, {
      headers: { ...authHeaders(login.accessToken), 'If-Match': `"${pendingTicket.version}"` },
      data: { status: 'PENDING' },
    });
    expect(moved.status()).toBe(200);
    expect(openTicket.status).toBe('OPEN');

    await loginViaUi(page, 'agent-a@example.com');
    await page.goto(`/tickets?projectId=${PROJECT_A1}`);
    await expect(page.getByTestId('ticket-table')).toBeVisible();
    await expect(page.getByText(pendingSubject)).toBeVisible();

    await page.getByTestId('ticket-status-filter').selectOption('PENDING');
    await expect(page.getByText(pendingSubject)).toBeVisible();
    await expect(page.getByText(openSubject)).toHaveCount(0);
  });
});
