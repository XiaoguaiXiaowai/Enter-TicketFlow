import { Global, Module } from '@nestjs/common';

import { PrismaModule } from '../prisma/prisma.module';
import { AlertsService } from './alerts.service';
import { BusinessMetricsService } from './business-metrics.service';
import { MetricsController } from './metrics.controller';
import { MetricsService } from './metrics.service';

@Global()
@Module({
  imports: [PrismaModule],
  controllers: [MetricsController],
  providers: [MetricsService, BusinessMetricsService, AlertsService],
  exports: [MetricsService],
})
export class ObservabilityModule {}