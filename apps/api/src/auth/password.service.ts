import { Injectable } from '@nestjs/common';
import { Algorithm, hash, verify } from '@node-rs/argon2';

import { getEnv } from '../config/runtime';

/**
 * 密码只以 Argon2id 哈希落库。参数来自配置，便于按硬件评估调整。
 * 每次哈希使用随机盐，同一密码两次哈希结果不同。
 */
@Injectable()
export class PasswordService {
  private options(): {
    algorithm: Algorithm;
    memoryCost: number;
    timeCost: number;
    parallelism: number;
  } {
    const env = getEnv();
    return {
      algorithm: Algorithm.Argon2id,
      memoryCost: env.ARGON2_MEMORY_KIB,
      timeCost: env.ARGON2_TIME_COST,
      parallelism: env.ARGON2_PARALLELISM,
    };
  }

  hash(plain: string): Promise<string> {
    return hash(plain, this.options());
  }

  async verify(hashValue: string, plain: string): Promise<boolean> {
    if (!hashValue.startsWith('$argon2id$')) {
      return false;
    }
    try {
      return await verify(hashValue, plain);
    } catch {
      return false;
    }
  }
}
