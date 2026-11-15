import {
  Body,
  Controller,
  Header,
  HttpCode,
  Post,
  Req,
  Res,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiNoContentResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';
import type { Request, Response } from 'express';

import type { LoginResponse } from '@ticket/shared';
import { Public } from '../common/decorators';
import type { AuthenticatedRequest } from './auth.types';
import { LoginDto } from './auth.dto';
import { AuthService, type RequestMeta } from './auth.service';
import { REFRESH_COOKIE_NAME, TokenService } from './token.service';

@ApiTags('认证')
@Controller('v1/auth')
export class AuthController {
  constructor(
    private readonly auth: AuthService,
    private readonly tokens: TokenService,
  ) {}

  @Public()
  @Post('login')
  @HttpCode(200)
  @Header('Cache-Control', 'no-store')
  @ApiOperation({ summary: '账号密码登录，签发访问令牌并写入刷新 Cookie' })
  @ApiOkResponse({ description: '登录成功，返回短期访问令牌' })
  @ApiUnauthorizedResponse({ description: '账号或密码错误' })
  async login(
    @Body() dto: LoginDto,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ): Promise<LoginResponse> {
    const issued = await this.auth.login(dto, requestMeta(req));
    res.cookie(REFRESH_COOKIE_NAME, issued.refreshToken, this.tokens.refreshCookieOptions());
    return issued.body;
  }

  @Public()
  @Post('refresh')
  @HttpCode(200)
  @Header('Cache-Control', 'no-store')
  @ApiOperation({ summary: '使用 HttpOnly 刷新 Cookie 轮换访问令牌' })
  @ApiOkResponse({ description: '刷新成功，旧刷新凭据立即失效' })
  @ApiUnauthorizedResponse({ description: '刷新凭据无效、已撤销或已过期' })
  async refresh(
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ): Promise<LoginResponse> {
    const cookies = req.cookies as Record<string, string | undefined> | undefined;
    const issued = await this.auth.refresh(cookies?.[REFRESH_COOKIE_NAME], requestMeta(req));
    res.cookie(REFRESH_COOKIE_NAME, issued.refreshToken, this.tokens.refreshCookieOptions());
    return issued.body;
  }

  @Post('logout')
  @HttpCode(204)
  @Header('Cache-Control', 'no-store')
  @ApiBearerAuth()
  @ApiOperation({ summary: '撤销当前会话，递增会话版本使旧访问令牌立即失效' })
  @ApiNoContentResponse({ description: '已撤销' })
  @ApiUnauthorizedResponse({ description: '未认证' })
  async logout(
    @Req() req: AuthenticatedRequest,
    @Res({ passthrough: true }) res: Response,
  ): Promise<void> {
    if (req.actor === undefined) {
      return;
    }
    await this.auth.logout(req.actor);
    const options = this.tokens.refreshCookieOptions();
    res.clearCookie(REFRESH_COOKIE_NAME, {
      httpOnly: options.httpOnly,
      secure: options.secure,
      sameSite: options.sameSite,
      path: options.path,
    });
    res.status(204);
  }
}

function requestMeta(req: Request): RequestMeta {
  const agent = req.headers['user-agent'];
  return {
    ip: req.ip,
    userAgent: typeof agent === 'string' ? agent : undefined,
  };
}
