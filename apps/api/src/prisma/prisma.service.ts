import { Injectable, type OnModuleDestroy } from '@nestjs/common';
import { Prisma, PrismaClient } from '@prisma/client';

import { getEnv } from '../config/runtime';
import { writeLog } from '../common/logger';

/**
 * 连接按需建立：数据库不可用时进程仍能启动，
 * 由 /health/ready 返回 503，而不是让容器反复重启。
 *
 * 所有访问含 tenant_id 的业务表都必须走 withTenant：
 * 事务内设置 app.tenant_id，RLS 策略据此过滤，事务结束自动失效。
 */
@Injectable()
export class PrismaService extends PrismaClient implements OnModuleDestroy {
  constructor() {
    super({ datasourceUrl: getEnv().DATABASE_URL });
  }

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

  async onModuleDestroy(): Promise<void> {
    try {
      await this.$disconnect();
    } catch (error: unknown) {
      writeLog('warn', 'failed to disconnect prisma', {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
}
