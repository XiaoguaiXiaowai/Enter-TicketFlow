import { Module } from '@nestjs/common';

import { OutboxService } from './outbox.service';

/**
 * 事件落表能力：与业务写入同事务，供业务模块使用。
 * 投递循环在 worker 进程的 OutboxWorkerModule 中注册。
 */
@Module({
  providers: [OutboxService],
  exports: [OutboxService],
})
export class OutboxModule {}