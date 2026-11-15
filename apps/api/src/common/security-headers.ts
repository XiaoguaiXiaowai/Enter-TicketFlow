import type { NextFunction, Request, Response } from 'express';

const API_CSP = "default-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'";

/**
 * API 统一安全响应头。浏览器侧页面的 CSP/HSTS 由 Nginx 下发，
 * 这里覆盖 API 与静态资源，避免绕过 Nginx 直连时失去防护。
 * Swagger UI 依赖内联脚本，因此 docs 路径只加基础头。
 */
export function securityHeadersMiddleware(req: Request, res: Response, next: NextFunction): void {
  res.setHeader('x-content-type-options', 'nosniff');
  res.setHeader('x-frame-options', 'DENY');
  res.setHeader('referrer-policy', 'no-referrer');
  res.setHeader('cross-origin-resource-policy', 'same-origin');
  res.setHeader('permissions-policy', 'camera=(), microphone=(), geolocation=()');

  const path = req.originalUrl.split('?')[0] ?? '';
  if (!path.startsWith('/api/docs')) {
    res.setHeader('content-security-policy', API_CSP);
  }

  if (process.env.NODE_ENV === 'production') {
    res.setHeader('strict-transport-security', 'max-age=31536000; includeSubDomains');
  }

  next();
}