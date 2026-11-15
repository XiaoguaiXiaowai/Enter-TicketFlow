import { PrismaClient, type Prisma } from '@prisma/client';

/**
 * 含 tenant_id 的表全部启用 RLS，访问时必须先设置 app.tenant_id。
 * 事务结束上下文自动失效，避免连接复用时串租户。
 * API（app_rw）与 Worker（app_worker）使用同一套访问语义，仅连接串不同。
 */
export abstract class TenantScopedClient extends PrismaClient {
  async withTenant<T>(
    tenantId: string,
    fn: (tx: Prisma.TransactionClient) => Promise<T>,
  ): Promise<T> {
    return this.$transaction(
      async (tx) => {
        await tx.$queryRaw`SELECT set_config('app.tenant_id', ${tenantId}, true)`;
        return fn(tx);
      },
      // 工单号计数器与消息 seq 会串行化并发写入；预留足够等待时间，避免高并发批量建单时事务超时。
      { maxWait: 10_000, timeout: 20_000 },
    );
  }
}