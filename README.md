# 企业客服工单平台

面向多租户企业的客服工单系统。服务端完成认证、租户隔离、权限求值与字段级投影，覆盖工单全生命周期、变更审计、知识库与回复模板，并提供限流、指标、告警、Outbox 投递与加密备份等运行能力。

- 设计文档：[技术架构](docs/architecture.md) · [迭代计划](docs/iteration-plan.md)
- 当前进度：I0 工程基座、I1 认证与权限、I2 工单与审计、I3 知识库与模板、I4 运行加固均已验收；I5 安全与合规能力列为候选。

## 功能概览

| 能力             | 说明                                                                                      |
| ---------------- | ----------------------------------------------------------------------------------------- |
| 多租户与项目隔离 | 所有业务表带 `tenant_id`，项目作为二级边界；应用层过滤 + PostgreSQL 行级安全（RLS）双保险 |
| 认证与会话       | 15 分钟 JWT access token + HttpOnly 刷新 Cookie；刷新即轮换，登出通过会话版本号立即失效   |
| 权限模型         | 角色-资源-动作授权 + 字段级读写策略；默认拒绝，字段可整体隐藏或脱敏                       |
| 工单闭环         | 建单、列表、详情、状态机流转、公开回复、内部备注、负责人与优先级、乐观锁并发控制          |
| 幂等与并发       | 创建与追加消息使用 `Idempotency-Key`（24 小时）；更新使用 `If-Match` + `version`          |
| 审计             | 与业务同事务写入字段级 diff，只追加不更新；按角色限制可查询范围                           |
| 知识库           | 文章 + 版本模型，草稿/发布/归档；全文检索（`tsvector` + `pg_trgm`）只返回已发布内容       |
| 回复模板         | 服务端渲染 `{{variable}}`，变量白名单校验，HTML 转义                                      |
| 运行能力         | Redis 限流与自动降级、结构化日志、Prometheus 指标、告警、Outbox Worker、AES-256 加密备份  |
| 前端             | 登录、会话恢复、工单工作台、知识库管理、工单侧边栏检索与模板引用                          |

## 技术栈

| 层         | 选型                                                      |
| ---------- | --------------------------------------------------------- |
| 运行时     | Node.js ≥ 22.12，pnpm 11.21（workspace）                  |
| 后端       | NestJS 11、TypeScript 5.9、Prisma 6、Zod、class-validator |
| 数据库     | PostgreSQL 16（RLS、`jsonb`、GIN 全文索引、唯一约束）     |
| 缓存与限流 | Redis 7（不可用时降级为进程内计数）                       |
| 前端       | React 19、React Router 7、Vite 7                          |
| 接入层     | Nginx 1.27（静态资源、`/api` 反代、安全响应头）           |
| 测试       | Vitest 3（单元/集成）、Playwright 1.65（端到端）          |
| 编排与 CI  | Docker Compose、GitHub Actions                            |

## 系统架构

```mermaid
graph TB
    Browser["React SPA<br/>apps/web"] -->|HTTP| Nginx["Nginx<br/>静态资源 + /api 反代"]
    Nginx --> API["NestJS API<br/>apps/api"]
    Nginx --> Web["web 容器<br/>静态产物"]

    subgraph App["NestJS 模块化单体"]
        Guard["全局管线<br/>Auth → Project → Policy → RateLimit"]
        Ticket["TicketsModule<br/>工单 / 消息 / 审计"]
        Knowledge["KnowledgeModule<br/>知识库 / 回复模板"]
        Iam["IamModule<br/>租户 / 成员 / 角色 / 字段策略"]
        Idem["IdempotencyModule"]
        Outbox["OutboxModule"]
        Obs["ObservabilityModule<br/>日志 / 指标 / 告警"]
    end

    API --> Guard
    Guard --> Ticket
    Guard --> Knowledge
    Guard --> Iam
    Ticket --> Idem
    Ticket --> Outbox
    Ticket --> PG[("PostgreSQL 16<br/>业务表 + RLS + 审计")]
    Knowledge --> PG
    Iam --> PG
    Outbox --> PG
    API --> Redis[("Redis 7<br/>限流 / 缓存")]
    Worker["worker 进程<br/>Outbox 投递 / 过期清理"] --> PG
    Worker --> Redis
```

NestJS 按领域拆模块，模块之间通过服务接口交互；API 进程参与请求处理，`worker` 进程只负责 Outbox 投递与过期数据清理。数据库账号分为三个角色：

| 角色           | 用途               | 约束                        |
| -------------- | ------------------ | --------------------------- |
| `app_migrator` | 执行 DDL 与迁移    | 仅迁移任务使用              |
| `app_rw`       | API 运行时读写     | 无 DDL 权限、无 `BYPASSRLS` |
| `app_worker`   | 后台任务跨租户扫描 | 按批次显式设置租户上下文    |

## 目录结构

```text
.
├── apps/
│   ├── api/                  # NestJS 后端
│   │   ├── prisma/           # schema 与 SQL 迁移（含 RLS、索引）
│   │   ├── src/
│   │   │   ├── auth/         # 登录、刷新、登出、Guard、令牌
│   │   │   ├── tickets/      # 工单、消息、状态机、审计入口
│   │   │   ├── knowledge/    # 知识库文章、版本、模板渲染
│   │   │   ├── iam/          # 成员、角色、权限与字段策略求值
│   │   │   ├── idempotency/  # 幂等键占位与响应快照
│   │   │   ├── outbox/       # 事件落表、投递、重试
│   │   │   ├── ratelimit/    # 限流与 Redis 降级
│   │   │   ├── observability/# 指标、告警、访问日志
│   │   │   ├── scripts/      # 建角色、迁移、检查、压测脚本
│   │   │   ├── seed.ts       # 演示租户与账号
│   │   │   ├── main.ts       # API 入口
│   │   │   └── worker.ts     # Worker 入口
│   │   └── test/             # 单元与集成测试
│   └── web/                  # React 前端
│       └── src/
│           ├── auth/         # 会话上下文
│           ├── lib/          # API 客户端（内存 token + 自动刷新）
│           └── pages/        # 登录、工作台、知识库
├── packages/shared/          # 前后端共享 DTO 与权限常量
├── docs/                     # 架构与迭代文档
├── docker/                   # Nginx、备份脚本
├── tests/e2e/                # Playwright 端到端用例
├── docker-compose.yml
└── .github/workflows/ci.yml
```

## 快速开始

### 前置条件

- Node.js ≥ 22.12（仓库 `engines` 约束）
- pnpm 11.21：`corepack enable`
- Docker 与 Docker Compose

### 方式一：Docker Compose（推荐）

```bash
cp .env.example .env

# 构建镜像并初始化数据库（建角色 → 迁移 → 授权）
docker compose --profile tools build
docker compose --profile tools run --rm migrate
docker compose --profile tools run --rm seed

# 启动 API、Worker、Web、Nginx、PostgreSQL、Redis
docker compose up -d --build

# 健康检查
curl -i http://localhost/api/health/live
curl -i http://localhost/api/health/ready
```

启动后：

| 地址                                | 用途                                 |
| ----------------------------------- | ------------------------------------ |
| `http://localhost/`                 | 前端页面                             |
| `http://localhost/api/docs`         | Swagger / OpenAPI                    |
| `http://localhost/api/docs-json`    | OpenAPI JSON                         |
| `http://localhost/api/health/live`  | 存活检查（不访问数据库）             |
| `http://localhost/api/health/ready` | 就绪检查（数据库可用且迁移版本一致） |

`migrate` 与 `seed` 属于 `tools` profile，只在需要时执行，不会随 `docker compose up` 启动。`/api/metrics` 在 Nginx 边缘固定返回 404，仅供集群内 Prometheus 直接抓取 `api:3000`。

### 方式二：本地进程开发

Compose 默认不向宿主机暴露 PostgreSQL / Redis 端口，本地开发可自行启动实例并映射端口，例如：

```bash
docker run -d --name ticket-postgres \
  -e POSTGRES_DB=ticket \
  -e POSTGRES_USER=postgres \
  -e POSTGRES_PASSWORD=local_dev_superuser \
  -p 5432:5432 postgres:16-alpine

docker run -d --name ticket-redis -p 6379:6379 redis:7-alpine
```

将 `.env` 中连接串的主机名由 `postgres` / `redis` 改为 `localhost`：

```bash
DATABASE_URL=postgresql://app_rw:local_dev_rw@localhost:5432/ticket?schema=public
MIGRATE_DATABASE_URL=postgresql://app_migrator:local_dev_migrator@localhost:5432/ticket?schema=public
WORKER_DATABASE_URL=postgresql://app_worker:local_dev_worker@localhost:5432/ticket?schema=public
REDIS_URL=redis://localhost:6379
```

然后安装依赖并启动：

```bash
pnpm install
pnpm db:generate

# 建数据库角色、执行迁移、授权
pnpm --filter @ticket/api db:prepare
# 写入演示租户、账号、角色、字段策略与模板
pnpm --filter @ticket/api db:seed

# 终端 A：API（默认 3000）
pnpm --filter @ticket/api dev
# 终端 B：前端（默认 5173，/api 代理到 3000）
pnpm --filter @ticket/web dev
```

后端按以下顺序加载 `.env`：当前目录、`../../.env`、仓库根目录。配置缺失或非法时进程直接退出，并打印缺失的键名。

## 演示账号

种子脚本可重复执行，账号密码统一取 `SEED_DEFAULT_PASSWORD`（`.env.example` 默认 `local_dev_seed_password`）。登录时必须同时提供 `tenantCode`。

| 账号                       | 租户编码   | 角色     | 可访问项目                       |
| -------------------------- | ---------- | -------- | -------------------------------- |
| `agent-a@example.com`      | `tenant-a` | 客服     | SUP（客服支持）、SVC（售后服务） |
| `lead-a@example.com`       | `tenant-a` | 客服主管 | SUP、SVC                         |
| `contractor-a@example.com` | `tenant-a` | 外包坐席 | SUP                              |
| `agent-b@example.com`      | `tenant-b` | 客服     | B2C（B2C 支持）                  |

`agent-a@example.com` 同时是租户 B 的外包坐席：换用 `tenantCode=tenant-b` 登录后角色与可见字段会自动变化，可用于验证多租户身份。

### 角色与字段策略

| 字段            | 客服  | 客服主管 | 外包坐席               |
| --------------- | ----- | -------- | ---------------------- |
| `customerPhone` | 读/写 | 读/写    | 仅读，后四位脱敏       |
| `internalNote`  | 读/写 | 读/写    | 不可读写（字段不返回） |
| `refundAmount`  | 仅读  | 读/写    | 不可读写（字段不返回） |
| `assigneeId`    | 仅读  | 读/写    | 不可读写（字段不返回） |

动作权限差异：

- 客服：`ticket:list/read/create/update/reply/note`、`audit:read`、`kb:read`、`template:use`
- 客服主管：在客服基础上增加 `ticket:close`、`audit:read_all`、`kb:write`、`kb:publish`
- 外包坐席：`ticket:list/read/reply`、`kb:read`、`template:use`

字段策略同时作用于读取与写入：读时未授权字段不会出现在响应中（而不是返回 `null`）；写时未授权字段返回 `403 FIELD_DENIED`，DTO 未声明字段返回 `400`。

## 接口概览

所有业务接口统一挂在 `/api` 前缀下。除登录、刷新、健康检查与指标外，均要求：

```http
Authorization: Bearer <accessToken>
```

涉及项目的接口还要求 `X-Project-Id` 请求头；租户身份只来自服务端会话，客户端传入的 `tenantId` 不会被采信。

| 方法与路径                                 | 用途                                      | 权限                                       |
| ------------------------------------------ | ----------------------------------------- | ------------------------------------------ |
| `POST /api/v1/auth/login`                  | 登录，返回 access token 并写入刷新 Cookie | 公开                                       |
| `POST /api/v1/auth/refresh`                | 轮换刷新凭据并重新签发 access token       | 刷新 Cookie                                |
| `POST /api/v1/auth/logout`                 | 撤销当前会话                              | 已认证                                     |
| `GET /api/v1/me/permissions`               | 当前角色、动作权限、字段策略与项目列表    | 已认证                                     |
| `GET /api/v1/tickets`                      | 工单列表（游标分页、状态/负责人筛选）     | `ticket:list`                              |
| `POST /api/v1/tickets`                     | 创建工单                                  | `ticket:create`                            |
| `GET /api/v1/tickets/{id}`                 | 工单详情（含最近 50 条可见消息）          | `ticket:read`                              |
| `PATCH /api/v1/tickets/{id}`               | 更新状态、负责人、优先级等                | `ticket:update`（关闭需 `ticket:close`）   |
| `POST /api/v1/tickets/{id}/messages`       | 追加公开回复或内部备注                    | `ticket:reply`，内部备注另需 `ticket:note` |
| `GET /api/v1/tickets/{id}/audit`           | 查询工单审计                              | `audit:read`（主管可查全部）               |
| `GET /api/v1/kb/articles`                  | 检索已发布文章                            | `kb:read`                                  |
| `POST /api/v1/kb/articles`                 | 新建草稿                                  | `kb:write`                                 |
| `GET /api/v1/kb/articles/{id}`             | 文章详情与历史版本                        | `kb:read`                                  |
| `PATCH /api/v1/kb/articles/{id}`           | 编辑生成新草稿版本                        | `kb:write`                                 |
| `POST /api/v1/kb/articles/{id}/publish`    | 发布最新版本                              | `kb:publish`                               |
| `DELETE /api/v1/kb/articles/{id}`          | 归档文章（保留已发布版本）                | `kb:write`                                 |
| `GET /api/v1/reply-templates`              | 当前项目模板列表                          | `template:use`                             |
| `POST /api/v1/reply-templates/{id}/render` | 渲染模板变量（无副作用）                  | `template:use`                             |
| `GET /api/health/live`                     | 存活检查                                  | 公开                                       |
| `GET /api/health/ready`                    | 就绪检查                                  | 公开                                       |
| `GET /api/metrics`                         | Prometheus 指标                           | 公开，但仅在容器网络内可达                 |

### 幂等与并发约定

| 操作                | 请求头                          | 行为                                                                                                                   |
| ------------------- | ------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| 创建工单 / 追加消息 | `Idempotency-Key`（必填）       | 同键同请求体在 24 小时内返回首次结果（`200` + `Idempotent-Replay: true`）；同键不同体返回 `409 IDEMPOTENCY_KEY_REUSED` |
| 更新工单            | `If-Match: "<version>"`（必填） | 版本不匹配返回 `409 VERSION_CONFLICT` 并附当前版本；缺少该头返回 `412`                                                 |
| 发布知识库版本      | 无                              | 重复发布同一最新版本幂等；目标不是最新版本返回 `409`                                                                   |

工单状态机：

```text
OPEN     → PENDING / RESOLVED / CLOSED
PENDING  → OPEN / RESOLVED
RESOLVED → OPEN / CLOSED
CLOSED   → （终态）
```

### 错误结构

```json
{
  "error": {
    "code": "FIELD_DENIED",
    "message": "无权修改字段 refundAmount",
    "requestId": "0f4c1f52-6c0e-4a57-9c1b-4b4c7d2f0a11",
    "details": [{ "field": "refundAmount", "reason": "WRITE_NOT_ALLOWED" }]
  }
}
```

400 参数或状态迁移错误、401 未认证、403 无权或字段受限、404 不存在或跨租户不可见、409 幂等/版本冲突、412 缺前置条件、422 空正文、429 限流、500 未预期异常。跨租户资源统一表现为 404，不暴露资源是否存在。

## 数据模型

核心实体与关系：

```mermaid
erDiagram
    TENANTS ||--o{ PROJECTS : owns
    TENANTS ||--o{ MEMBERSHIPS : has
    USERS ||--o{ MEMBERSHIPS : joins
    MEMBERSHIPS ||--o{ MEMBERSHIP_PROJECTS : scoped_to
    MEMBERSHIPS ||--o{ MEMBERSHIP_ROLES : assigned
    ROLES ||--o{ ROLE_PERMISSIONS : contains
    ROLES ||--o{ FIELD_POLICIES : defines
    PROJECTS ||--o{ TICKETS : contains
    TICKETS ||--o{ TICKET_MESSAGES : has
    PROJECTS ||--o{ KB_ARTICLES : contains
    KB_ARTICLES ||--o{ KB_ARTICLE_VERSIONS : versions
    PROJECTS ||--o{ REPLY_TEMPLATES : contains
    TENANTS ||--o{ AUDIT_LOGS : logs
    TENANTS ||--o{ IDEMPOTENCY_KEYS : scopes
    TENANTS ||--o{ OUTBOX_EVENTS : emits
    USERS ||--o{ SESSIONS : holds
```

要点：

- 成员与项目是多对多，成员只对已授权项目可见；角色挂在成员上，同一用户在不同租户可拥有不同角色。
- `tickets` 通过 `(tenant_id, project_id, ticket_no)` 唯一约束保证工单号不重复，`version` 支持乐观锁，`message_seq` 为工单内消息序号。
- `audit_logs` 只追加，通过 `resource` + `resource_id` 关联资源，不建外键，应用角色无 `UPDATE` / `DELETE` 权限。
- `idempotency_keys` 以 `(tenant_id, key)` 唯一，记录请求哈希、状态与首次响应快照。
- 知识库采用“文章 + 版本”，`kb_articles.published_version_id` 指向线上版本；检索使用 `to_tsvector` GIN 索引，并以 `pg_trgm` 兜底中文短语。
- 所有含 `tenant_id` 的业务表启用 `ROW LEVEL SECURITY` 与 `FORCE ROW LEVEL SECURITY`，事务开始时设置 `app.tenant_id`。

## 工程命令

| 命令                                          | 说明                                             |
| --------------------------------------------- | ------------------------------------------------ |
| `pnpm build`                                  | 生成 Prisma Client 并构建全部工作区              |
| `pnpm lint` / `pnpm format`                   | ESLint / Prettier                                |
| `pnpm typecheck`                              | 生成 Client、构建 shared、检查脚本与各工作区类型 |
| `pnpm check`                                  | lint + typecheck + 配置键一致性检查              |
| `pnpm test`                                   | 运行各工作区单元测试                             |
| `pnpm test:integration`                       | 集成测试（需要真实 PostgreSQL）                  |
| `pnpm test:e2e`                               | Playwright 端到端测试                            |
| `pnpm check:env`                              | 校验 `.env.example` 与配置 schema 的键集合一致   |
| `pnpm hooks:install`                          | 启用仓库内 Git hooks                             |
| `pnpm --filter @ticket/api db:prepare`        | 建角色 → 迁移 → 授权（可重复执行）               |
| `pnpm --filter @ticket/api db:seed`           | 写入演示数据                                     |
| `pnpm --filter @ticket/api check:rls`         | 校验所有含 `tenant_id` 的表已启用 RLS            |
| `pnpm --filter @ticket/api check:permissions` | 扫描控制器，检查写接口是否声明权限               |
| `pnpm --filter @ticket/api perf:check`        | 按性能预算压测核心接口                           |
| `pnpm --filter @ticket/api outbox:status`     | 查看 Outbox 积压与状态                           |

## 测试

| 层次     | 工具                | 覆盖范围                                                                   |
| -------- | ------------------- | -------------------------------------------------------------------------- |
| 单元测试 | Vitest              | 权限投影、状态机、脱敏、异常过滤器、告警规则、限流                         |
| 集成测试 | Vitest + PostgreSQL | 租户过滤、RLS、幂等约束、乐观锁、Outbox 投递与重试                         |
| 端到端   | Playwright          | 登录与刷新、字段权限、跨租户隔离、幂等、并发冲突、知识库发布、安全头、限流 |

E2E 用例按标签组织，可只跑受影响的套件：

```bash
pnpm exec playwright test -g @foundation   # 工程基座与静态托管
pnpm exec playwright test -g @permissions  # 认证、租户、字段级权限
pnpm exec playwright test -g @idempotency  # 重复提交与幂等
pnpm exec playwright test -g @concurrency  # 乐观锁并发冲突
pnpm exec playwright test -g @audit        # 审计与列表
pnpm exec playwright test -g @kb           # 知识库与模板
pnpm exec playwright test -g @security     # 安全响应头与富文本清洗
pnpm exec playwright test -g @rate         # 限流与降级可见性
```

E2E 默认访问 `http://localhost`，可通过 `E2E_BASE_URL` 覆盖。本地缺少 Playwright 浏览器时，可设置 `PLAYWRIGHT_CHANNEL=chrome` 复用系统 Chrome。

## CI

[ci.yml](.github/workflows/ci.yml) 按依赖关系串行执行三个阶段：

1. `static`：安装依赖、lint、typecheck、配置校验、单元测试、生产依赖高危审计、权限声明扫描、构建。
2. `integration`：启动 PostgreSQL service，重复执行 `db:prepare` 验证迁移幂等，执行 `prisma migrate diff` 校验 schema 与迁移一致，写入 seed，运行集成测试与 RLS 覆盖检查。
3. `e2e`：复制 `.env.example`，按 `migrate → seed → up` 拉起 Compose，等待 `/api/health/ready` 通过后执行全量 Playwright；失败时上传 `playwright-report`、`test-results` 与容器日志。

## 运行与运维

### 配置

配置键的唯一事实来源是 [env.ts](apps/api/src/config/env.ts)，[.env.example](.env.example) 必须与其一一对应（由 `pnpm check:env` 校验）。主要分组：

| 分组     | 键示例                                                                      | 说明                                |
| -------- | --------------------------------------------------------------------------- | ----------------------------------- |
| 运行     | `NODE_ENV`、`API_PORT`、`LOG_LEVEL`                                         | 端口与日志级别                      |
| 数据库   | `POSTGRES_*`、`DATABASE_URL`、`MIGRATE_DATABASE_URL`、`WORKER_DATABASE_URL` | 三个运行时角色连接串                |
| Redis    | `REDIS_URL`、`REDIS_COMMAND_TIMEOUT_MS`                                     | 不可用时限流降级为进程内计数        |
| 限流     | `RATE_LIMIT_*`                                                              | 读写按租户+用户分桶；登录按账号锁定 |
| Outbox   | `OUTBOX_POLL_INTERVAL_MS`、`OUTBOX_MAX_ATTEMPTS`、`OUTBOX_WEBHOOK_URL`      | 空 Webhook 时只记录日志             |
| 指标告警 | `METRICS_INTERVAL_SECONDS`、`ALERT_*`                                       | 5xx 比例、Outbox 积压、登录失败阈值 |
| 认证     | `JWT_SECRET`、`ACCESS_TOKEN_TTL_SECONDS`、`REFRESH_TOKEN_TTL_SECONDS`       | 本地使用 HS256 对称密钥             |
| 密码哈希 | `ARGON2_*`                                                                  | Argon2id 参数                       |
| 备份     | `BACKUP_ENCRYPTION_PASSPHRASE`、`BACKUP_RETENTION_DAYS`                     | `tools` profile 使用                |

生产环境应替换所有示例密钥；仓库与镜像中不得出现真实凭据。

### 健康检查与指标

- `/api/health/live`：仅反映进程存活，不访问数据库。
- `/api/health/ready`：数据库可用且迁移版本与代码一致时返回 200，否则 503。
- `/api/metrics`：Prometheus 文本格式，包含 `http_requests_total`、`http_request_duration_ms`、`http_5xx_total`、`db_connections`、`outbox_pending_events`、`idempotency_pending_keys`、`open_tickets`、`redis_state`、`rate_limit_fallback_total` 等。
- 告警以 `type=alert` 的结构化日志输出，包含实测值、阈值与 `runbook` 路径；同类告警 5 分钟冷却。

### Outbox 与后台任务

工单创建等业务写入会在同一事务内落 `outbox_events`。`worker` 使用 `FOR UPDATE SKIP LOCKED` 批量认领，失败按指数退避重试，超过 `OUTBOX_MAX_ATTEMPTS`（默认 8）标记 `DEAD`；同时清理过期幂等键。

```bash
docker compose stop worker      # 事件保持 PENDING，业务写入不受影响
docker compose start worker     # 恢复投递
pnpm --filter @ticket/api outbox:status
```

### 限流与降级

- 写接口默认 60 次/分钟、读接口默认 300 次/分钟，按租户内用户计数，键中包含租户，租户之间互不影响。
- 登录同一账号连续失败 5 次后锁定 10 分钟，按账号而非 IP 聚合。
- Redis 不可用时自动切换为进程内固定窗口计数，响应与日志标记降级，指标 `rate_limit_fallback_total` 递增；恢复后自动回到集中计数。

### 备份与恢复演练

```bash
# 全量备份：pg_dump 自定义格式 + AES-256 加密 + SHA256 校验
docker compose --profile tools run --rm backup

# 在独立库恢复并核对数据，不触碰生产库
docker compose --profile tools run --rm restore-check
```

备份产物保存在 `pgbackup` 卷，默认保留 `BACKUP_RETENTION_DAYS` 天。

## 设计取舍

- **一致性优先**：工单、审计、幂等结果与 Outbox 事件在同一事务提交，避免“建了工单但审计丢失”或重复建单。
- **隔离三层兜底**：路由 Guard、仓储过滤、数据库 RLS 各司其职；应用层漏写条件时 RLS 仍能阻止越权。
- **权限以字段为最小粒度**：页面菜单隐藏只是交互优化，任何写接口被直接调用都必须返回 403。
- **按操作类型选择并发保护**：创建/追加消息用幂等键，更新用乐观锁，发布用文章版本；不统一套用同一种机制。
- **单体优先**：当前规模下模块化单体的运维成本低于微服务，模块边界保留未来拆分切口。

## 已知限制与后续计划

以下问题已在迭代计划中登记为发布后跟进项，不阻塞当前出口：

| 编号 | 说明                                                      |
| ---- | --------------------------------------------------------- |
| G1   | 慢查询（≥500ms）已有实现与阈值，但缺少运行时样本          |
| G2   | 改密、禁用成员尚无接口，会话失效目前只覆盖登出            |
| G3   | 备份无内置按日调度，需要宿主机 cron 或 systemd timer 触发 |
| G4   | 恢复演练只核对行数，尚未在恢复库上验证登录流程            |
| G5   | 无历史镜像标签，回滚演练待首次发布后执行                  |
| G6   | 发布检查单尚未建立                                        |

I5 候选方向：个人数据字段级加密、设备列表与强制下线、改密与成员禁用/启用，以及上述 G 项的收口。

## 相关文档

- [技术架构](docs/architecture.md)：分层、权限、接口契约、数据模型、部署拓扑与工程流水线
- [迭代计划](docs/iteration-plan.md)：I0–I4 交付边界、验证清单、验收登记与遗留问题
