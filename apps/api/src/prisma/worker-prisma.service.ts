import { Injectable, type OnModuleDestroy } from '@nestjs/common';

import { writeLog } from '../common/logger';
import { getEnv } from '../config/runtime';
import { TenantScopedClient } from './tenant-scoped-client';

/**
 * Worker 专用连接：使用 app_worker 角色与独立连接池，避免与 API 争抢连接。
 * RLS 仍然生效，投递前必须逐个租户设置上下文。
 */
@Injectable()
export class WorkerPrismaService extends TenantScopedClient implements OnModuleDestroy {
  constructor() {
    super({ datasourceUrl: getEnv().WORKER_DATABASE_URL });
  }

  async onModuleDestroy(): Promise<void> {
    try {
      await this.$disconnect();
    } catch (error: unknown) {
      writeLog('warn', 'failed to disconnect worker prisma', {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
}