import { Global, Module } from '@nestjs/common';

import { WorkerPrismaService } from './worker-prisma.service';

@Global()
@Module({
  providers: [WorkerPrismaService],
  exports: [WorkerPrismaService],
})
export class WorkerPrismaModule {}