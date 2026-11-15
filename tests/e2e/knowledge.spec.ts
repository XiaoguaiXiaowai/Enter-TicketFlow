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
  slug: string;
  version: number;
  publishedVersionId: string | null;
  versions: { id: string; versionNo: number; title: string; status: string }[];
}

interface KbListBody {
  items: {
    id: string;
    title: string;
    versionNo: number;
    publishedVersionId: string | null;
    snippet: string | null;
  }[];
  nextCursor: string | null;
}

interface ReplyTemplateFixture {
  id: string;
  name: string;
  variables: string[];
}

interface TicketFixture {
  id: string;
  ticketNo: string;
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

async function searchArticles(
  request: APIRequestContext,
  accessToken: string,
  keyword: string,
): Promise<KbListBody> {
  const response = await request.get(
    `/api/v1/kb/articles?q=${encodeURIComponent(keyword)}&limit=50`,
    { headers: authHeaders(accessToken) },
  );
  expect(response.status()).toBe(200);
  return (await response.json()) as KbListBody;
}

async function createArticle(
  request: APIRequestContext,
  accessToken: string,
  payload: { slug: string; title: string; body: string },
): Promise<KbArticleFixture> {
  const response = await request.post('/api/v1/kb/articles', {
    headers: authHeaders(accessToken),
    data: payload,
  });
  expect(response.status()).toBe(201);
  return (await response.json()) as KbArticleFixture;
}

async function publishArticle(
  request: APIRequestContext,
  accessToken: string,
  articleId: string,
  versionNo: number,
): Promise<void> {
  const response = await request.post(`/api/v1/kb/articles/${articleId}/publish`, {
    headers: authHeaders(accessToken),
    data: { versionNo },
  });
  expect(response.status()).toBe(200);
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
      description: 'I3 知识库验收用例工单',
      customerName: '张先生',
      customerPhone: '13800001234',
    },
  });
  expect(response.status()).toBe(201);
  return (await response.json()) as TicketFixture;
}

test.describe('@kb I3 知识库与回复模板', () => {
  test('草稿不可检索，发布后命中且编辑不影响线上内容', async ({ page, request }) => {
    const login = await loginViaApi(request, 'lead-a@example.com');
    const token = `kb${randomUUID().replace(/-/g, '').slice(0, 10)}`;
    const title = `退款时效说明-${token}`;
    const body = `订单 ${token} 的退款申请会在三个工作日内原路退回。`;

    const article = await createArticle(request, login.accessToken, {
      slug: `refund-${token}`,
      title,
      body,
    });

    // 发布前：检索不返回草稿，详情可见 DRAFT 版本且没有发布指针。
    const beforePublish = await searchArticles(request, login.accessToken, token);
    expect(beforePublish.items).toHaveLength(0);

    const detail = await request.get(`/api/v1/kb/articles/${article.id}`, {
      headers: authHeaders(login.accessToken),
    });
    expect(detail.status()).toBe(200);
    const detailBody = (await detail.json()) as KbArticleFixture;
    expect(detailBody.publishedVersionId).toBeNull();
    expect(detailBody.versions).toHaveLength(1);
    expect(detailBody.versions[0]?.status).toBe('DRAFT');

    await publishArticle(request, login.accessToken, article.id, 1);

    const afterPublish = await searchArticles(request, login.accessToken, token);
    expect(afterPublish.items).toHaveLength(1);
    expect(afterPublish.items[0]?.id).toBe(article.id);
    expect(afterPublish.items[0]?.title).toBe(title);
    expect(afterPublish.items[0]?.snippet).toContain(token);

    // 编辑只生成新草稿，检索仍返回线上版本内容。
    const edited = await request.patch(`/api/v1/kb/articles/${article.id}`, {
      headers: authHeaders(login.accessToken),
      data: { title: `${title}-草稿`, body: `草稿内容 ${token} 不应出现在检索结果` },
    });
    expect(edited.status()).toBe(200);

    const stillOnline = await searchArticles(request, login.accessToken, token);
    expect(stillOnline.items).toHaveLength(1);
    expect(stillOnline.items[0]?.title).toBe(title);
    expect(stillOnline.items[0]?.versionNo).toBe(1);

    // 页面检索命中并高亮关键词。
    await loginViaUi(page, 'lead-a@example.com');
    await page.goto(`/knowledge?projectId=${PROJECT_A1}`);
    await page.getByTestId('kb-search-input').fill(token);
    await page.getByTestId('kb-search-button').click();
    await expect(page.getByTestId('kb-article-title').filter({ hasText: title })).toBeVisible();
    await expect(page.getByTestId('kb-article-snippet').locator('mark')).toHaveText(token);
  });

  test('无发布权限的客服直接调用发布接口返回 403', async ({ request }) => {
    const lead = await loginViaApi(request, 'lead-a@example.com');
    const agent = await loginViaApi(request, 'agent-a@example.com');
    const token = `kb${randomUUID().replace(/-/g, '').slice(0, 10)}`;

    const article = await createArticle(request, lead.accessToken, {
      slug: `denied-${token}`,
      title: `权限校验-${token}`,
      body: `正文 ${token}。`,
    });

    // 客服可读不可发布：详情可访问，发布被拒。
    const detail = await request.get(`/api/v1/kb/articles/${article.id}`, {
      headers: authHeaders(agent.accessToken),
    });
    expect(detail.status()).toBe(200);

    const denied = await request.post(`/api/v1/kb/articles/${article.id}/publish`, {
      headers: authHeaders(agent.accessToken),
      data: { versionNo: 1 },
    });
    expect(denied.status()).toBe(403);
    const deniedBody = (await denied.json()) as { error: { code: string } };
    expect(deniedBody.error.code).toBe('FORBIDDEN');
  });

  test('模板渲染失败路径返回 VARIABLE_NOT_ALLOWED 并指出变量', async ({ request }) => {
    const login = await loginViaApi(request, 'agent-a@example.com');

    const list = await request.get('/api/v1/reply-templates', {
      headers: authHeaders(login.accessToken),
    });
    expect(list.status()).toBe(200);
    const templates = (await list.json()) as { items: ReplyTemplateFixture[] };
    const template = templates.items.find((item) => item.name === '退款指引');
    expect(template).toBeDefined();
    expect(template?.variables).toEqual(['customer_name', 'order_no']);

    const missing = await request.post(`/api/v1/reply-templates/${template?.id}/render`, {
      headers: authHeaders(login.accessToken),
      data: { variables: { customer_name: '张先生' } },
    });
    expect(missing.status()).toBe(400);
    const missingBody = (await missing.json()) as {
      error: { code: string; details: { variable: string; reason: string }[] };
    };
    expect(missingBody.error.code).toBe('VARIABLE_NOT_ALLOWED');
    expect(missingBody.error.details).toEqual([{ variable: 'order_no', reason: 'MISSING' }]);

    const undeclared = await request.post(`/api/v1/reply-templates/${template?.id}/render`, {
      headers: authHeaders(login.accessToken),
      data: { variables: { customer_name: '张先生', order_no: 'SO-1', extra: '注入' } },
    });
    expect(undeclared.status()).toBe(400);
    const undeclaredBody = (await undeclared.json()) as {
      error: { code: string; details: { variable: string; reason: string }[] };
    };
    expect(undeclaredBody.error.code).toBe('VARIABLE_NOT_ALLOWED');
    expect(undeclaredBody.error.details).toEqual([{ variable: 'extra', reason: 'NOT_DECLARED' }]);

    const rendered = await request.post(`/api/v1/reply-templates/${template?.id}/render`, {
      headers: authHeaders(login.accessToken),
      data: { variables: { customer_name: '<b>张先生</b>', order_no: 'SO-2026-0001' } },
    });
    expect(rendered.status()).toBe(200);
    const renderedBody = (await rendered.json()) as { templateId: string; body: string };
    expect(renderedBody.templateId).toBe(template?.id);
    expect(renderedBody.body).toContain('&lt;b&gt;张先生&lt;/b&gt;');
    expect(renderedBody.body).not.toContain('<b>');
    expect(renderedBody.body).toContain('SO-2026-0001');
  });

  test('工单侧边栏完成检索—引用—模板渲染，缺变量时禁止插入', async ({ page, request }) => {
    const lead = await loginViaApi(request, 'lead-a@example.com');
    const agent = await loginViaApi(request, 'agent-a@example.com');

    const token = `kb${randomUUID().replace(/-/g, '').slice(0, 10)}`;
    const title = `发票指引-${token}`;
    const article = await createArticle(request, lead.accessToken, {
      slug: `invoice-${token}`,
      title,
      body: `订单完成后可在 ${token} 页面申请开具发票。`,
    });
    await publishArticle(request, lead.accessToken, article.id, 1);

    const ticket = await createTicket(request, agent.accessToken, `知识引用-${randomUUID()}`);

    await loginViaUi(page, 'agent-a@example.com');
    await page.goto(`/tickets/${ticket.id}?projectId=${PROJECT_A1}`);
    await expect(page.getByTestId('kb-sidebar')).toBeVisible();

    await page.getByTestId('kb-sidebar-search').fill(token);
    await page.getByTestId('kb-sidebar-search-button').click();
    await expect(page.getByTestId('kb-sidebar-insert')).toHaveCount(1);
    await page.getByTestId('kb-sidebar-insert').click();

    const reply = page.getByTestId('message-input');
    await expect(reply).toHaveValue(new RegExp(title));
    await expect(reply).toHaveValue(new RegExp(token));

    // 选择模板后变量缺失：按钮禁用并提示具体变量。
    await page.getByTestId('kb-template-select').selectOption({ label: '退款指引' });
    await expect(page.getByTestId('kb-template-missing')).toContainText('customer_name');
    await expect(page.getByTestId('kb-template-render')).toBeDisabled();

    await page.getByTestId('kb-template-var-customer_name').fill('张先生');
    await page.getByTestId('kb-template-var-order_no').fill('SO-2026-0001');
    await expect(page.getByTestId('kb-template-missing')).toHaveCount(0);
    await page.getByTestId('kb-template-render').click();

    await expect(reply).toHaveValue(/SO-2026-0001/);
    await expect(reply).toHaveValue(new RegExp(token));
  });
});