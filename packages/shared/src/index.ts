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
