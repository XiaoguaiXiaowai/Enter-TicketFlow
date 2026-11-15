import type { Request } from 'express';

export interface ActorRole {
  id: string;
  code: string;
  name: string;
}

export interface Actor {
  userId: string;
  email: string;
  sessionId: string;
  tenantId: string;
  tenantCode: string;
  membershipId: string;
  roles: ActorRole[];
  projectIds: string[];
}

export interface AuthenticatedRequest extends Request {
  actor?: Actor;
  /** 由 ProjectGuard 校验后写入，Controller 只读。 */
  projectId?: string;
}

export interface AccessTokenClaims {
  sub: string;
  sid: string;
  tid: string;
  sv: number;
  iat: number;
  exp: number;
}
