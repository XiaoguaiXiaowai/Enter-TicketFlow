/**
 * 服务端与前端共享的接口契约。I0 只有健康检查与统一错误结构，
 * 后续迭代的 DTO 类型也在这里声明，避免两侧各写一份。
 */

export const API_PREFIX = 'api';

export interface HealthLiveResponse {
  status: 'ok';
  uptimeSeconds: number;
}

export interface MigrationsSummary {
  applied: number;
  expected: number;
  pending: string[];
}

export interface HealthReadyResponse {
  status: 'ok';
  database: 'up';
  migrationVersion: string;
  checks: {
    migrations: MigrationsSummary;
    redis: 'up' | 'degraded';
  };
}

export interface ApiErrorBody {
  error: {
    code: string;
    message: string;
    requestId: string;
    details?: unknown;
  };
}

export interface HealthErrorBody extends ApiErrorBody {
  error: {
    code: 'NOT_READY';
    message: string;
    requestId: string;
    details?: {
      database?: 'down';
      migrations?: MigrationsSummary;
    };
  };
}

// ===== I1 认证、租户与权限 =====

export interface UserSummary {
  id: string;
  email: string;
}

export interface TenantSummary {
  id: string;
  code: string;
  name: string;
}

export interface ProjectSummary {
  id: string;
  code: string;
  name: string;
}

export interface RoleSummary {
  code: string;
  name: string;
}

export interface PermissionSummary {
  resource: string;
  action: string;
}

export interface FieldPolicySummary {
  resource: string;
  field: string;
  canRead: boolean;
  canWrite: boolean;
  masked: boolean;
}

export interface LoginRequest {
  email: string;
  password: string;
  tenantCode: string;
}

export interface LoginResponse {
  accessToken: string;
  expiresInSeconds: number;
  user: UserSummary;
  tenant: TenantSummary;
}

export interface MePermissionsResponse {
  user: UserSummary;
  tenant: TenantSummary;
  membership: {
    id: string;
    status: string;
  };
  roles: RoleSummary[];
  permissions: PermissionSummary[];
  fields: FieldPolicySummary[];
  projects: ProjectSummary[];
}

// ===== I2 工单核心与审计 =====

export type TicketStatus = 'OPEN' | 'PENDING' | 'RESOLVED' | 'CLOSED';
export type TicketPriority = 'LOW' | 'NORMAL' | 'HIGH' | 'URGENT';
export type TicketSource = 'WEB' | 'EMAIL' | 'PHONE' | 'API';
export type MessageVisibility = 'PUBLIC' | 'INTERNAL';
export type AuditAction = 'CREATE' | 'UPDATE' | 'PUBLISH' | 'ARCHIVE';

export const TICKET_STATUSES: readonly TicketStatus[] = ['OPEN', 'PENDING', 'RESOLVED', 'CLOSED'];
export const TICKET_PRIORITIES: readonly TicketPriority[] = ['LOW', 'NORMAL', 'HIGH', 'URGENT'];
export const TICKET_SOURCES: readonly TicketSource[] = ['WEB', 'EMAIL', 'PHONE', 'API'];

/** 基字段始终返回，敏感字段按调用者的字段策略投影。 */
export interface TicketResponse {
  id: string;
  ticketNo: string;
  subject: string;
  description: string;
  status: TicketStatus;
  priority: TicketPriority;
  source: TicketSource;
  customerName: string;
  tags: string[];
  version: number;
  createdAt: string;
  updatedAt: string;
  customerPhone?: string;
  internalNote?: string;
  refundAmount?: number;
  assigneeId?: string;
}

export interface TicketMessageResponse {
  id: string;
  seq: number;
  visibility: MessageVisibility;
  body: string;
  authorId: string;
  createdAt: string;
}

export interface TicketDetailResponse extends TicketResponse {
  messages: TicketMessageResponse[];
}

export interface TicketListResponse {
  items: TicketResponse[];
  nextCursor: string | null;
}

export interface CreateTicketRequest {
  subject: string;
  description: string;
  priority?: TicketPriority;
  customerName: string;
  customerPhone?: string;
  assigneeId?: string;
  tags?: string[];
  source?: TicketSource;
}

export interface UpdateTicketRequest {
  status?: TicketStatus;
  priority?: TicketPriority;
  assigneeId?: string | null;
  tags?: string[];
  internalNote?: string | null;
  refundAmount?: number | null;
  customerPhone?: string;
}

export interface AppendMessageRequest {
  body: string;
  visibility: MessageVisibility;
  templateId?: string;
  templateVariables?: Record<string, string>;
}

export interface AppendMessageResponse {
  id: string;
  seq: number;
  visibility: MessageVisibility;
  createdAt: string;
}

export interface TicketAuditEntry {
  id: string;
  action: AuditAction;
  actorId: string;
  requestId: string;
  ip: string | null;
  before: Record<string, unknown> | null;
  after: Record<string, unknown> | null;
  changedFields: string[];
  createdAt: string;
}

export interface TicketAuditResponse {
  items: TicketAuditEntry[];
}

export interface TicketListQuery {
  status?: TicketStatus;
  assigneeId?: string;
  limit?: number;
  cursor?: string;
}

export const PERMISSION = {
  TICKET_LIST: 'ticket:list',
  TICKET_READ: 'ticket:read',
  TICKET_CREATE: 'ticket:create',
  TICKET_UPDATE: 'ticket:update',
  TICKET_REPLY: 'ticket:reply',
  TICKET_NOTE: 'ticket:note',
  TICKET_CLOSE: 'ticket:close',
  AUDIT_READ: 'audit:read',
  AUDIT_READ_ALL: 'audit:read_all',
  KB_READ: 'kb:read',
  KB_WRITE: 'kb:write',
  KB_PUBLISH: 'kb:publish',
  TEMPLATE_USE: 'template:use',
} as const;

export const RESOURCE = {
  TICKET: 'ticket',
  AUDIT: 'audit',
  KB: 'kb',
  TEMPLATE: 'template',
} as const;

/** 审计记录中的资源类型，与权限资源名解耦（权限用 `kb`，审计细化到表实体）。 */
export const AUDIT_RESOURCE = {
  KB_ARTICLE: 'kb_article',
} as const;

/** 字段级权限覆盖的字段，基字段（id、subject、version）始终返回。 */
export const TICKET_SENSITIVE_FIELDS = [
  'customerPhone',
  'internalNote',
  'refundAmount',
  'assigneeId',
] as const;

// ===== I3 知识库与回复模板 =====

export type KbVersionStatus = 'DRAFT' | 'PUBLISHED' | 'ARCHIVED';

/** 检索结果只包含已发布版本的内容；status 为该版本的发布状态。 */
export interface KbArticleSummary {
  id: string;
  slug: string;
  title: string;
  status: KbVersionStatus;
  version: number;
  versionNo: number;
  publishedVersionId: string | null;
  updatedAt: string;
  snippet: string | null;
  score: number;
}

export interface KbArticleListResponse {
  items: KbArticleSummary[];
  nextCursor: string | null;
}

export interface KbArticleVersionResponse {
  id: string;
  versionNo: number;
  title: string;
  body: string;
  status: KbVersionStatus;
  authorId: string;
  publishedAt: string | null;
  createdAt: string;
}

export interface KbArticleResponse {
  id: string;
  slug: string;
  version: number;
  publishedVersionId: string | null;
  archivedAt: string | null;
  createdAt: string;
  updatedAt: string;
  versions: KbArticleVersionResponse[];
}

export interface CreateKbArticleRequest {
  slug: string;
  title: string;
  body: string;
}

export interface UpdateKbArticleRequest {
  title: string;
  body: string;
}

export interface PublishKbArticleRequest {
  versionNo: number;
  comment?: string;
}

export interface PublishKbArticleResponse {
  id: string;
  publishedVersionId: string;
  version: number;
  versionNo: number;
}

export interface ReplyTemplateSummary {
  id: string;
  name: string;
  body: string;
  variables: string[];
  version: number;
  updatedAt: string;
}

export interface ReplyTemplateListResponse {
  items: ReplyTemplateSummary[];
}

export interface RenderReplyTemplateRequest {
  variables: Record<string, string>;
}

export interface RenderReplyTemplateResponse {
  templateId: string;
  body: string;
  missingVariables: string[];
}

export interface KbArticleListQuery {
  q?: string;
  limit?: number;
  cursor?: string;
}
