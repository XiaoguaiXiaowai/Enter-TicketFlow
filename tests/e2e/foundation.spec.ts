import { expect, test } from '@playwright/test';

test.describe('@foundation I0 工程基座', () => {
  test('健康检查可用，未登录访问首页进入登录页且无前端异常', async ({ page, request }) => {
    const live = await request.get('/api/health/live');
    expect(live.status()).toBe(200);

    const ready = await request.get('/api/health/ready');
    expect(ready.status()).toBe(200);

    const body = (await ready.json()) as {
      status: string;
      database: string;
      migrationVersion: string;
      checks: { migrations: { applied: number; expected: number; pending: string[] } };
    };
    expect(body.status).toBe('ok');
    expect(body.database).toBe('up');
    expect(body.migrationVersion).not.toBe('');
    expect(body.checks.migrations.applied).toBe(body.checks.migrations.expected);
    expect(body.checks.migrations.pending).toEqual([]);

    const consoleErrors: string[] = [];
    const serverErrors: string[] = [];
    page.on('console', (message) => {
      if (message.type() === 'error' && !message.text().includes('Failed to load resource')) {
        consoleErrors.push(message.text());
      }
    });
    page.on('response', (response) => {
      if (response.status() >= 500) {
        serverErrors.push(`${response.status()} ${response.url()}`);
      }
    });

    await page.goto('/');
    await expect(page.getByRole('heading', { name: '登录' })).toBeVisible();
    await expect(page.getByTestId('login-form')).toBeVisible();

    expect(consoleErrors).toEqual([]);
    expect(serverErrors).toEqual([]);
  });

  test('前端深层路由直接访问回退到 index.html 并进入登录页', async ({ page }) => {
    const response = await page.goto('/tickets/123');
    expect(response?.status()).toBe(200);
    await expect(page.getByRole('heading', { name: '登录' })).toBeVisible();
  });

  test('静态资源长缓存，index.html 不缓存', async ({ page, request }) => {
    const indexResponse = await request.get('/index.html');
    expect(indexResponse.status()).toBe(200);
    expect(indexResponse.headers()['cache-control']).toContain('no-cache');

    const html = await indexResponse.text();
    const assetMatch = /src="(\/assets\/[^"]+\.js)"/.exec(html);
    expect(assetMatch).not.toBeNull();

    const assetResponse = await request.get(assetMatch?.[1] ?? '/assets/missing.js');
    expect(assetResponse.status()).toBe(200);
    expect(assetResponse.headers()['cache-control']).toContain('immutable');

    await page.goto('/');
  });
});
