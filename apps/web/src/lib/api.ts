import type {
  ApiErrorBody,
  AppendMessageRequest,
  AppendMessageResponse,
  CreateTicketRequest,
  LoginRequest,
  LoginResponse,
  MePermissionsResponse,
  TicketAuditResponse,
  TicketDetailResponse,
  TicketListQuery,
  TicketListResponse,
  TicketResponse,
  UpdateTicketRequest,
} from '@ticket/shared';

// 后端统一挂在 /api/v1 下（健康检查除外），前端默认与之一致。
const API_BASE = import.meta.env.VITE_API_BASE_URL ?? '/api/v1';

export class ApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly requestId: string | undefined;
  readonly details: unknown;

  constructor(status: number, body: ApiErrorBody | null) {
    super(body?.error.message ?? `请求失败（HTTP ${status}）`);
    this.name = 'ApiError';
    this.status = status;
    this.code = body?.error.code ?? `HTTP_${status}`;
    this.requestId = body?.error.requestId;
    this.details = body?.error.details;
  }
}

interface RequestOptions {
  method?: string;
  body?: unknown;
  projectId?: string;
  allowRefresh?: boolean;
  headers?: Record<string, string>;
}

// access token 只存在内存，不落 localStorage；页面刷新依赖 HttpOnly Cookie 重新签发。
let accessToken: string | null = null;
let pendingRefresh: Promise<LoginResponse> | null = null;

export function setAccessToken(token: string | null): void {
  accessToken = token;
}

export function hasAccessToken(): boolean {
  return accessToken !== null;
}

async function send(path: string, options: RequestOptions): Promise<Response> {
  const headers: Record<string, string> = { Accept: 'application/json', ...options.headers };
  if (options.body !== undefined) {
    headers['Content-Type'] = 'application/json';
  }
  if (accessToken !== null) {
    headers.Authorization = `Bearer ${accessToken}`;
  }
  if (options.projectId !== undefined) {
    headers['X-Project-Id'] = options.projectId;
  }

  return fetch(`${API_BASE}${path}`, {
    method: options.method ?? 'GET',
    credentials: 'include',
    headers,
    ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
  });
}

async function parseError(response: Response): Promise<ApiError> {
  let body: ApiErrorBody | null = null;
  try {
    body = (await response.json()) as ApiErrorBody;
  } catch {
    body = null;
  }
  return new ApiError(response.status, body);
}

async function request<T>(path: string, options: RequestOptions = {}): Promise<T> {
  const allowRefresh = options.allowRefresh ?? true;
  const response = await send(path, options);

  if (response.status === 401 && allowRefresh && !path.startsWith('/auth/')) {
    try {
      await refreshSession();
    } catch {
      throw await parseError(response);
    }
    return request<T>(path, { ...options, allowRefresh: false });
  }

  if (!response.ok) {
    throw await parseError(response);
  }
  if (response.status === 204) {
    return undefined as T;
  }
  return (await response.json()) as T;
}

async function performRefresh(): Promise<LoginResponse> {
  const response = await send('/auth/refresh', { method: 'POST', allowRefresh: false });
  if (!response.ok) {
    accessToken = null;
    throw await parseError(response);
  }
  const body = (await response.json()) as LoginResponse;
  accessToken = body.accessToken;
  return body;
}

/** 并发调用共享同一次刷新，避免轮换后的旧 Cookie 被重复使用。 */
export function refreshSession(): Promise<LoginResponse> {
  if (pendingRefresh === null) {
    pendingRefresh = performRefresh().finally(() => {
      pendingRefresh = null;
    });
  }
  return pendingRefresh;
}

export async function login(payload: LoginRequest): Promise<LoginResponse> {
  const body = await request<LoginResponse>('/auth/login', {
    method: 'POST',
    body: payload,
    allowRefresh: false,
  });
  accessToken = body.accessToken;
  return body;
}

export async function logout(): Promise<void> {
  try {
    await request<void>('/auth/logout', { method: 'POST' });
  } finally {
    accessToken = null;
  }
}

export function fetchMyPermissions(): Promise<MePermissionsResponse> {
  return request<MePermissionsResponse>('/me/permissions');
}

export function fetchTickets(
  projectId: string,
  query: TicketListQuery = {},
): Promise<TicketListResponse> {
  const params = new URLSearchParams();
  if (query.status !== undefined) {
    params.set('status', query.status);
  }
  if (query.assigneeId !== undefined) {
    params.set('assigneeId', query.assigneeId);
  }
  if (query.limit !== undefined) {
    params.set('limit', String(query.limit));
  }
  if (query.cursor !== undefined) {
    params.set('cursor', query.cursor);
  }
  const qs = params.toString();
  return request<TicketListResponse>(`/tickets${qs === '' ? '' : `?${qs}`}`, { projectId });
}

export function fetchTicket(ticketId: string, projectId: string): Promise<TicketDetailResponse> {
  return request<TicketDetailResponse>(`/tickets/${encodeURIComponent(ticketId)}`, { projectId });
}

export function createTicket(
  projectId: string,
  payload: CreateTicketRequest,
  idempotencyKey: string,
): Promise<TicketResponse> {
  return request<TicketResponse>('/tickets', {
    method: 'POST',
    body: payload,
    projectId,
    headers: { 'Idempotency-Key': idempotencyKey },
  });
}

export function updateTicket(
  ticketId: string,
  projectId: string,
  payload: UpdateTicketRequest,
  version: number,
): Promise<TicketResponse> {
  return request<TicketResponse>(`/tickets/${encodeURIComponent(ticketId)}`, {
    method: 'PATCH',
    body: payload,
    projectId,
    headers: { 'If-Match': `"${version}"` },
  });
}

export function appendTicketMessage(
  ticketId: string,
  projectId: string,
  payload: AppendMessageRequest,
  idempotencyKey: string,
): Promise<AppendMessageResponse> {
  return request<AppendMessageResponse>(`/tickets/${encodeURIComponent(ticketId)}/messages`, {
    method: 'POST',
    body: payload,
    projectId,
    headers: { 'Idempotency-Key': idempotencyKey },
  });
}

export function fetchTicketAudit(
  ticketId: string,
  projectId: string,
): Promise<TicketAuditResponse> {
  return request<TicketAuditResponse>(`/tickets/${encodeURIComponent(ticketId)}/audit`, {
    projectId,
  });
}

/** 浏览器环境优先使用 crypto.randomUUID，非安全上下文时退化为随机串。 */
export function newIdempotencyKey(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return `idem-${Date.now()}-${Math.random().toString(36).slice(2, 12)}`;
}
