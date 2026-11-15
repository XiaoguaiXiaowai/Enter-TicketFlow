import { Module } from '@nestjs/common';

import { WorkerPrismaModule } from '../prisma/worker-prisma.module';
import { OutboxDeliveryService } from './outbox-delivery.service';
import { OutboxWorkerService } from './outbox-worker.service';

/**
 * 只有 worker 进程导入本模块：API 进程只负责落表，投递循环不应在 API 内启动，
 * 否则每个 API 实例都会成为额外的消费者，抢占事件并放大数据库压力。
 */
@Module({
  imports: [WorkerPrismaModule],
  providers: [OutboxDeliveryService, OutboxWorkerService],
})
export class OutboxWorkerModule {}