import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

import { Injectable } from '@nestjs/common';
import jwt from 'jsonwebtoken';

import { getEnv } from '../config/runtime';
import type { AccessTokenClaims } from './auth.types';

export const REFRESH_COOKIE_NAME = 'refresh_token';

interface RefreshTokenParts {
  sessionId: string;
  tenantId: string;
  secret: string;
}

/**
 * access token 为短期 JWT，只放稳定标识；
 * refresh token 是不透明随机串，数据库只保存 SHA-256 摘要。
 */
@Injectable()
export class TokenService {
  signAccessToken(claims: {
    userId: string;
    sessionId: string;
    tenantId: string;
    tokenVersion: number;
  }): { token: string; expiresInSeconds: number } {
    const env = getEnv();
    const token = jwt.sign(
      {
        sub: claims.userId,
        sid: claims.sessionId,
        tid: claims.tenantId,
        sv: claims.tokenVersion,
      },
      env.JWT_SECRET,
      { algorithm: 'HS256', expiresIn: env.ACCESS_TOKEN_TTL_SECONDS },
    );

    return { token, expiresInSeconds: env.ACCESS_TOKEN_TTL_SECONDS };
  }

  verifyAccessToken(raw: string): AccessTokenClaims | null {
    try {
      const payload = jwt.verify(raw, getEnv().JWT_SECRET, { algorithms: ['HS256'] });
      if (typeof payload === 'string') {
        return null;
      }
      const { sub, sid, tid, sv, iat, exp } = payload;
      if (
        typeof sub !== 'string' ||
        typeof sid !== 'string' ||
        typeof tid !== 'string' ||
        typeof sv !== 'number' ||
        typeof iat !== 'number' ||
        typeof exp !== 'number'
      ) {
        return null;
      }
      return { sub, sid, tid, sv, iat, exp };
    } catch {
      return null;
    }
  }

  createRefreshToken(sessionId: string, tenantId: string): { token: string; hash: string } {
    const secret = randomBytes(32).toString('base64url');
    const token = `${sessionId}.${tenantId}.${secret}`;
    return { token, hash: this.hashRefreshSecret(secret) };
  }

  parseRefreshToken(token: string): RefreshTokenParts | null {
    const parts = token.split('.');
    if (parts.length !== 3) {
      return null;
    }
    const [sessionId, tenantId, secret] = parts as [string, string, string];
    if (!isUuid(sessionId) || !isUuid(tenantId) || secret.length < 16) {
      return null;
    }
    return { sessionId, tenantId, secret };
  }

  hashRefreshSecret(secret: string): string {
    return createHash('sha256').update(secret).digest('hex');
  }

  matchesRefreshSecret(secret: string, expectedHash: string): boolean {
    const actual = Buffer.from(this.hashRefreshSecret(secret), 'hex');
    const expected = Buffer.from(expectedHash, 'hex');
    if (actual.length !== expected.length) {
      return false;
    }
    return timingSafeEqual(actual, expected);
  }

  refreshCookieOptions(): {
    httpOnly: true;
    secure: boolean;
    sameSite: 'lax';
    path: string;
    maxAge: number;
  } {
    const env = getEnv();
    return {
      httpOnly: true,
      secure: env.NODE_ENV === 'production',
      sameSite: 'lax',
      path: '/api/v1/auth',
      maxAge: env.REFRESH_TOKEN_TTL_SECONDS * 1000,
    };
  }

  refreshTtlSeconds(): number {
    return getEnv().REFRESH_TOKEN_TTL_SECONDS;
  }
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function isUuid(value: string): boolean {
  return UUID_PATTERN.test(value);
}
