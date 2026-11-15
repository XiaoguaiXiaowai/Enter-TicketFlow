import { randomUUID } from 'node:crypto';

import { Injectable } from '@nestjs/common';

import type { LoginResponse, TenantSummary, UserSummary } from '@ticket/shared';
import { writeLog } from '../common/logger';
import { AppException } from '../common/errors';
import { PrismaService } from '../prisma/prisma.service';
import type { Actor } from './auth.types';
import type { LoginDto } from './auth.dto';
import { PasswordService } from './password.service';
import { TokenService } from './token.service';

export interface RequestMeta {
  ip: string | undefined;
  userAgent: string | undefined;
}

export interface IssuedCredentials {
  body: LoginResponse;
  refreshToken: string;
}

@Injectable()
export class AuthService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly passwords: PasswordService,
    private readonly tokens: TokenService,
  ) {}

  async login(dto: LoginDto, meta: RequestMeta): Promise<IssuedCredentials> {
    const tenant = await this.prisma.tenant.findUnique({
      where: { code: dto.tenantCode },
      select: { id: true, code: true, name: true, status: true },
    });

    const user = await this.prisma.user.findUnique({
      where: { email: dto.email.toLowerCase() },
      select: { id: true, email: true, passwordHash: true },
    });

    // 账号不存在时仍然执行一次哈希校验，避免通过响应耗时判断账号是否存在。
    const passwordOk =
      user === null
        ? await this.burnPasswordCheck(dto.password)
        : await this.passwords.verify(user.passwordHash, dto.password);

    if (
      tenant === null ||
      tenant.status !== 'ACTIVE' ||
      user === null ||
      !passwordOk
    ) {
      writeLog('info', 'login rejected', { tenantCode: dto.tenantCode });
      throw AppException.unauthorized('AUTH_INVALID_CREDENTIALS', '账号或密码错误');
    }

    const membership = await this.prisma.withTenant(tenant.id, (tx) =>
      tx.membership.findUnique({
        where: { tenantId_userId: { tenantId: tenant.id, userId: user.id } },
        select: { id: true, status: true },
      }),
    );

    if (membership === null || membership.status !== 'ACTIVE') {
      throw AppException.unauthorized('AUTH_INVALID_CREDENTIALS', '账号或密码错误');
    }

    return this.issue(tenant, { id: user.id, email: user.email }, meta);
  }

  async refresh(rawToken: string | undefined, meta: RequestMeta): Promise<IssuedCredentials> {
    if (rawToken === undefined) {
      throw AppException.unauthorized('REFRESH_TOKEN_MISSING', '缺少刷新凭据');
    }

    const parts = this.tokens.parseRefreshToken(rawToken);
    if (parts === null) {
      throw AppException.unauthorized('REFRESH_TOKEN_INVALID', '刷新凭据无效');
    }

    const data = await this.prisma.withTenant(parts.tenantId, async (tx) => {
      const session = await tx.session.findFirst({
        where: { id: parts.sessionId, tenantId: parts.tenantId },
      });
      if (session === null) {
        return null;
      }
      const user = await tx.user.findUnique({ where: { id: session.userId } });
      const tenant = await tx.tenant.findUnique({ where: { id: parts.tenantId } });
      const membership = await tx.membership.findUnique({
        where: { tenantId_userId: { tenantId: parts.tenantId, userId: session.userId } },
        select: { id: true, status: true },
      });
      return { session, user, tenant, membership };
    });

    if (data === null) {
      throw AppException.unauthorized('REFRESH_TOKEN_INVALID', '刷新凭据无效');
    }

    const { session, user, tenant, membership } = data;
    const now = Date.now();

    if (
      user === null ||
      tenant === null ||
      tenant.status !== 'ACTIVE' ||
      membership === null ||
      membership.status !== 'ACTIVE'
    ) {
      throw AppException.unauthorized('REFRESH_TOKEN_INVALID', '刷新凭据无效');
    }
    if (
      session.revokedAt !== null ||
      session.expiresAt.getTime() <= now ||
      !this.tokens.matchesRefreshSecret(parts.secret, session.refreshTokenHash)
    ) {
      throw AppException.unauthorized('REFRESH_TOKEN_INVALID', '刷新凭据无效');
    }

    // refresh 轮换：旧摘要立即被覆盖，旧 token 再次使用会因摘要不匹配返回 401。
    const rotated = this.tokens.createRefreshToken(session.id, session.tenantId);
    await this.prisma.withTenant(session.tenantId, (tx) =>
      tx.session.update({
        where: { id: session.id },
        data: {
          refreshTokenHash: rotated.hash,
          lastUsedAt: new Date(),
          ...(meta.ip === undefined ? {} : { ip: meta.ip }),
          ...(meta.userAgent === undefined ? {} : { userAgent: meta.userAgent }),
        },
      }),
    );

    const access = this.tokens.signAccessToken({
      userId: user.id,
      sessionId: session.id,
      tenantId: session.tenantId,
      tokenVersion: session.tokenVersion,
    });

    return {
      body: {
        accessToken: access.token,
        expiresInSeconds: access.expiresInSeconds,
        user: { id: user.id, email: user.email },
        tenant: { id: tenant.id, code: tenant.code, name: tenant.name },
      },
      refreshToken: rotated.token,
    };
  }

  async logout(actor: Actor): Promise<void> {
    await this.prisma.withTenant(actor.tenantId, (tx) =>
      tx.session.update({
        where: { id: actor.sessionId },
        data: {
          revokedAt: new Date(),
          tokenVersion: { increment: 1 },
        },
      }),
    );
  }

  private async issue(
    tenant: TenantSummary,
    user: UserSummary,
    meta: RequestMeta,
  ): Promise<IssuedCredentials> {
    const sessionId = randomUUID();
    const created = this.tokens.createRefreshToken(sessionId, tenant.id);
    const expiresAt = new Date(Date.now() + this.tokens.refreshTtlSeconds() * 1000);

    await this.prisma.withTenant(tenant.id, (tx) =>
      tx.session.create({
        data: {
          id: sessionId,
          tenantId: tenant.id,
          userId: user.id,
          refreshTokenHash: created.hash,
          expiresAt,
          ip: meta.ip ?? null,
          userAgent: meta.userAgent ?? null,
        },
      }),
    );

    const access = this.tokens.signAccessToken({
      userId: user.id,
      sessionId,
      tenantId: tenant.id,
      tokenVersion: 1,
    });

    return {
      body: {
        accessToken: access.token,
        expiresInSeconds: access.expiresInSeconds,
        user,
        tenant,
      },
      refreshToken: created.token,
    };
  }

  private async burnPasswordCheck(plain: string): Promise<boolean> {
    const dummy =
      '$argon2id$v=19$m=19456,t=2,p=1$c29tZXNhbHRzb21lc2FsdA$0v6zr8PRx1s0d5aQ0hPf0lQ8Kz1WQ3nZB0oP1Yw7Z2M';
    await this.passwords.verify(dummy, plain);
    return false;
  }
}
