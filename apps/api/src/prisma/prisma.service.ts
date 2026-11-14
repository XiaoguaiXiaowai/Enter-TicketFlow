import { Injectable, type OnModuleDestroy } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';

import { getEnv } from '../config/runtime';
import { writeLog } from '../common/logger';

/**
 * 连接按需建立：数据库不可用时进程仍能启动，
 * 由 /health/ready 返回 503，而不是让容器反复重启。
 */
@Injectable()
export class PrismaService extends PrismaClient implements OnModuleDestroy {
  constructor() {
    super({ datasourceUrl: getEnv().DATABASE_URL });
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
