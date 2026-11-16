import { Module } from '@nestjs/common';

import { AuditModule } from '../audit/audit.module';
import { IamModule } from '../iam/iam.module';
import { IdempotencyModule } from '../idempotency/idempotency.module';
import { KnowledgeModule } from '../knowledge/knowledge.module';
import { OutboxModule } from '../outbox/outbox.module';
import { TicketsController } from './tickets.controller';
import { TicketsService } from './tickets.service';

@Module({
  imports: [IamModule, IdempotencyModule, AuditModule, OutboxModule, KnowledgeModule],
  controllers: [TicketsController],
  providers: [TicketsService],
})
export class TicketsModule {}
