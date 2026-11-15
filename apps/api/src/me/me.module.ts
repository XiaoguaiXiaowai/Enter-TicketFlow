import { Module } from '@nestjs/common';

import { IamModule } from '../iam/iam.module';
import { MeController } from './me.controller';

@Module({
  imports: [IamModule],
  controllers: [MeController],
})
export class MeModule {}
