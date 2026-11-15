import { Module } from '@nestjs/common';

import { IamService } from './iam.service';
import { PermissionCacheService } from './permission-cache.service';

@Module({
  providers: [IamService, PermissionCacheService],
  exports: [IamService, PermissionCacheService],
})
export class IamModule {}
