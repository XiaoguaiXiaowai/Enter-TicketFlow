import { Controller, Get } from '@nestjs/common';
import type { HealthLiveResponse, HealthReadyResponse } from '@ticket/shared';

import { HealthService } from './health.service';

@Controller('health')
export class HealthController {
  constructor(private readonly health: HealthService) {}

  /** 存活检查：只反映进程状态，不访问数据库。 */
  @Get('live')
  live(): HealthLiveResponse {
    return this.health.live();
  }

  /** 就绪检查：数据库可用且迁移与代码版本一致时返回 200，否则 503。 */
  @Get('ready')
  ready(): Promise<HealthReadyResponse> {
    return this.health.ready();
  }
}
