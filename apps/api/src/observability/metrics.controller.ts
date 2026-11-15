import { Controller, Get, Header } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';

import { Public } from '../common/decorators';
import { MetricsService } from './metrics.service';

@ApiTags('运维')
@Public()
@Controller('metrics')
export class MetricsController {
  constructor(private readonly metrics: MetricsService) {}

  /** Prometheus 抓取入口：文本格式，不包含任何业务内容。 */
  @Get()
  @Header('Cache-Control', 'no-store')
  @Header('Content-Type', 'text/plain; version=0.0.4; charset=utf-8')
  @ApiOperation({ summary: 'Prometheus 指标' })
  scrape(): string {
    return this.metrics.render();
  }
}