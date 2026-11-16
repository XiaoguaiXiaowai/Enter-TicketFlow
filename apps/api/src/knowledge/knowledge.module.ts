import { Module } from '@nestjs/common';

import { AuditModule } from '../audit/audit.module';
import { KnowledgeController, ReplyTemplatesController } from './knowledge.controller';
import { KnowledgeService } from './knowledge.service';

@Module({
  imports: [AuditModule],
  controllers: [KnowledgeController, ReplyTemplatesController],
  providers: [KnowledgeService],
  exports: [KnowledgeService],
})
export class KnowledgeModule {}
