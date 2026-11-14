# 企业客服工单平台技术架构

## 1 设计概览

### 1.1 目的与范围

本文描述企业客服工单平台的技术架构：系统分层、模块边界、接口契约、数据模型、权限模型、并发与幂等策略、部署拓扑和工程流水线。读者是参与设计评审、开发、测试和运维的工程师。

本文不覆盖产品需求细节、交互稿、排期与迭代计划，也不包含逐行实现代码。排期、里程碑和版本节奏另行管理。

### 1.2 需求约束

上游只有一段口头需求，没有 PRD。以下条目按需求原文拆解，作为设计输入；标注 `[Hypothesis]` 的部分需要在评审时确认。

| 编号 | 需求 | 设计落点 | 证据 |
|---|---|---|---|
| R1 | Node.js + React 全栈 | NestJS 服务端 + React/TS 前端，单一仓库 | `[Data-backed]` |
| R2 | 服务端权限校验，页面隐藏不等于已授权 | 全局 Guard + 资源级策略 + 仓储租户过滤 + 数据库 RLS 兜底 | `[Data-backed]` |
| R3 | 多租户与项目隔离 | `tenant_id` 贯穿所有业务表，项目作为二级隔离边界 | `[Data-backed]` |
| R4 | 字段级权限 | 字段策略表 + 读时投影 + 写时白名单 | `[Data-backed]` |
| R5 | 记录变更审计 | 同事务写入的追加型 `audit_log`，记录字段级 diff | `[Data-backed]` |
| R6 | 知识库与回复模板 | 带版本的文档模型，模板变量在服务端渲染 | `[Data-backed]` |
| R7 | 幂等与并发更新 | `Idempotency-Key` + 唯一约束 + 乐观锁版本号 | `[Data-backed]` |
| R8 | 数据库迁移脚本 | Prisma Migrate 管理版本，SQL 迁移承载 RLS 与索引 | `[Data-backed]` |
| R9 | 单租户内并发客服规模 | 单实例 200 并发请求以内，P95 读接口 ≤ 200ms `[Hypothesis]` | `[Hypothesis]` |
| R10 | 无外部消息中间件预算 | 事务内 Outbox 取代 MQ，后续可平移到独立消费者 | `[Hypothesis]` |

### 1.3 设计目标

一致性优先于极致吞吐。工单状态、审计记录、幂等结果三者在同一个数据库事务内提交，任何一项失败则整体回滚，避免出现"工单建了但审计丢了"或"重复建单"这类客服场景不可接受的错误。

隔离性由数据库层兜底。应用层的 Guard 可能因为新增接口漏写而失效，因此租户隔离在 PostgreSQL 行级安全策略（RLS）上再落一层，应用角色与迁移角色分离，业务连接无法绕过。

权限按字段收敛。客服、主管、租户外包等角色的差异主要体现在"能看哪些字段"和"能改哪些字段"，而不是"能进哪些页面"，所以权限模型以字段为最小粒度，页面级菜单仅作为交互便利。

### 1.4 术语

| 术语 | 含义 |
|---|---|
| 租户（Tenant） | 一家签约企业，是计费、数据归属和隔离的最高边界 |
| 项目（Project） | 租户内的业务分组，如"售前咨询""售后维修"，工单必须归属一个项目 |
| 成员（Membership） | 用户在某租户内的身份，携带角色集合，用户可跨租户 |
| 字段策略（Field Policy） | 描述某角色对某资源某字段的读/写能力 |
| 幂等键（Idempotency Key） | 客户端生成的一次性请求标识，用于抑制重复提交 |
| Outbox | 与业务数据同事务写入的事件表，由后台任务投递 |

## 2 系统架构

### 2.1 架构风格

采用模块化单体（modular monolith）。NestJS 应用按领域拆成独立模块，模块之间只通过公开的服务接口和领域事件交互，不跨模块直接访问对方的表。选择单体而非微服务的理由：工单创建需要同时写工单、消息、审计、幂等记录，跨服务会引入分布式事务或最终一致补偿；当前租户规模下单体足以承载，拆分的运维成本换不来收益 `[Expert judgment]`。模块边界按领域划分，未来需要拆分时按模块切口外移，不需要重写业务逻辑。

前端是独立的 React 单页应用，由 Nginx 托管静态资源，通过 `/api` 反向代理到后端，同源部署避免跨域 Cookie 问题。

### 2.2 架构图

```mermaid
graph TB
    subgraph Client["客户端"]
        Browser["React SPA<br/>React + TypeScript"]
    end

    subgraph Edge["接入层"]
        Nginx["Nginx<br/>静态资源 / TLS / 反向代理"]
    end

    subgraph App["NestJS 应用（模块化单体）"]
        Guard["全局管线<br/>AuthGuard / TenantGuard / Throttler"]
        Ticket["TicketModule<br/>工单与消息"]
        IAM["IamModule<br/>租户、成员、角色、字段策略"]
        KB["KnowledgeModule<br/>知识库与回复模板"]
        Audit["AuditModule<br/>变更审计"]
        Idem["IdempotencyModule<br/>幂等请求记录"]
        Outbox["OutboxModule<br/>事件投递"]
        Common["CommonModule<br/>配置、日志、异常过滤器"]
    end

    subgraph Data["数据层"]
        PG[("PostgreSQL<br/>业务表 + RLS + 审计表")]
        Redis[("Redis<br/>会话索引 / 限流 / 缓存")]
    end

    subgraph Ops["运维支撑"]
        Worker["后台任务进程<br/>Outbox 投递、过期清理"]
        CI["GitHub Actions<br/>lint / test / e2e / build"]
    end

    Browser -->|HTTPS| Nginx
    Nginx -->|/api| Guard
    Guard --> Ticket
    Guard --> IAM
    Guard --> KB
    Ticket --> PG
    Ticket --> Audit
    IAM --> PG
    KB --> PG
    Audit --> PG
    Idem --> PG
    Ticket --> Outbox
    Outbox --> PG
    Worker --> PG
    App --> Redis
    CI --> App
```

图中每个模块只允许访问自己的仓储；`AuditModule` 和 `IdempotencyModule` 提供的是被其他模块调用的写入能力，不允许反向依赖业务模块。`OutboxModule` 只负责落表和投递，不承载业务判断。Redis 是可降级依赖：会话与限流受阻时，系统退化为仅校验 JWT 签名，功能受影响但不阻断主流程。

### 2.3 组件职责

| 组件 | 负责 | 不负责 |
|---|---|---|
| Nginx | 静态资源、TLS 终止、`/api` 反代、基础安全响应头 | 业务鉴权、请求体校验 |
| 全局管线 | 认证、租户解析、限流、请求上下文（requestId、actor、tenantId） | 具体资源授权判断 |
| TicketModule | 工单生命周期、消息追加、状态机、分配 | 组织架构维护、模板内容管理 |
| IamModule | 租户、项目、成员、角色、字段策略的维护与求值 | 工单业务规则 |
| KnowledgeModule | 知识库文章版本、发布状态、模板变量解析 | 工单状态流转 |
| AuditModule | 追加审计记录、提供字段 diff 写入接口 | 审计查询的权限判断由 Iam 提供 |
| IdempotencyModule | 幂等键占位、结果快照、过期清理 | 业务校验 |
| OutboxModule | 事件落表、投递、重试与死信标记 | 业务事件内容生成 |
| Worker | 定时投递 Outbox、清理过期幂等键与会话 | 对外提供 HTTP 接口 |

### 2.4 技术选型

| 选型 | 用途 | 理由 |
|---|---|---|
| NestJS | 服务端框架 | 内置模块、依赖注入、Guard/Interceptor/Pipe 管线，适合把鉴权、租户、审计统一挂在管线而不是散落在 controller `[Expert judgment]` |
| PostgreSQL | 主数据库 | 需要行级安全策略、`jsonb` 存审计快照、`tsvector` 做知识库检索、部分唯一索引做幂等，这些能力在单一存储内即可满足，减少组件 `[Expert judgment]` |
| Prisma | ORM 与迁移 | 类型安全查询、迁移文件版本化；RLS 与复杂索引通过原生 SQL 迁移补充 `[Expert judgment]` |
| React + TypeScript | 前端 | 与后端共享 DTO 类型定义，字段级权限的可见性枚举可由同一份策略生成 `[Expert judgment]` |
| JWT + 服务端会话 | 认证 | 短期 access token 做无状态校验，refresh token 落库以便即时撤销与设备管理 `[Expert judgment]` |
| Docker Compose | 本地与预发编排 | 单机可拉起 web、api、postgres、redis、worker，环境一致，成本低于 Kubernetes `[Expert judgment]` |
| GitHub Actions | 持续集成 | 与代码托管同源，矩阵跑单测、集成测试、Playwright，避免额外 CI 平台 `[Expert judgment]` |
| Playwright | 端到端测试 | 多角色、多租户的权限场景需要在真实浏览器里验证"隐藏的按钮确实无法通过接口操作" `[Expert judgment]` |
| Redis | 会话索引、限流计数、热点缓存 | 计数与短期状态需要低延迟和自动过期；数据可重建，允许丢失 `[Expert judgment]` |

版本号不在本文固定。NestJS、Prisma、React 的具体版本以仓库锁文件为准，评审时不引用未确认的版本号。

## 3 隔离与权限架构

### 3.1 认证与会话

登录成功后签发两个凭据。access token 是 JWT，有效期 15 分钟，载荷只放稳定标识：`sub`（用户）、`sid`（会话）、`tid`（当前租户）、`sv`（会话版本）。角色和字段权限不写进 token，因为权限调整必须立即生效，而 JWT 在过期前无法修改；把角色放进 token 会逼出"等 15 分钟"或"维护黑名单"两种坏结果。

refresh token 是随机不透明字符串，数据库只存其 SHA-256 摘要，字段包含 `user_id`、`tenant_id`、`expires_at`、`revoked_at`。每次刷新都轮换，旧摘要立即被新摘要覆盖；客户端若持旧 token 重试会得到 401，需要重新登录。浏览器端 access token 放内存，refresh token 放 `HttpOnly + Secure + SameSite=Lax` Cookie，前端不读取。

会话表承担三件事：登出即时生效、设备列表与强制下线、`sv` 版本号校验。校验 JWT 签名之后，全局 Guard 比较 `sv` 与数据库中的会话版本，不一致则拒绝。这样即使 token 尚未过期，撤权也能立刻生效。

### 3.2 请求上下文

所有请求经过一条固定管线，顺序不可调整：

1. `RequestContextMiddleware` 生成 `requestId`，用 AsyncLocalStorage 建立请求上下文。
2. `AuthGuard` 校验 JWT 签名、过期时间、`sv`，加载会话与成员关系。
3. `TenantGuard` 从会话确定租户，不接受请求体或查询参数里的 `tenantId`；若请求头带 `X-Project-Id`，校验该项目属于当前租户且用户是成员。
4. `PolicyGuard` 按 `@RequirePermission(resource, action, field?)` 元数据求值。
5. `ValidationPipe` 按 DTO 白名单校验，未声明字段直接拒绝，避免批量赋值。
6. Controller 调用应用服务，服务通过仓储访问数据，仓储自动附加租户与项目条件。
7. 数据库连接执行 RLS 策略，作为最后一道隔离。

租户标识只有一个可信来源：服务端会话。客户端传 `tenantId` 一律忽略；需要切换租户时走独立接口重新签发会话，避免一个请求里出现两个租户身份。

### 3.3 授权求值

权限判定的签名是 `can(actor, action, resource, field?) => boolean`，默认拒绝。求值顺序：先看成员关系是否存在，再看角色是否对该资源该动作有授权，最后看字段是否可读写。没有"继承自上级角色"的隐式规则，角色之间的差异全部落在显式授权行上，避免排错时追一条链路。

```ts
// 权限求值的最小形态，实际实现位于 IamModule
type Decision =
  | { allowed: true }
  | { allowed: false; reason: 'NO_MEMBERSHIP' | 'NO_PERMISSION' | 'FIELD_DENIED' };

async function can(ctx: RequestContext, action: Action, resource: Resource, field?: string): Promise<Decision> {
  if (!ctx.membership) return { allowed: false, reason: 'NO_MEMBERSHIP' };

  const grant = await policyCache.hasAction(ctx.tenantId, ctx.membership.roleIds, resource, action);
  if (!grant) return { allowed: false, reason: 'NO_PERMISSION' };

  if (field) {
    const policy = await fieldPolicyCache.get(ctx.tenantId, ctx.membership.roleIds, resource, field);
    const allowed = action === 'read' ? policy?.canRead : action === 'write' ? policy?.canWrite : true;
    if (!allowed) return { allowed: false, reason: 'FIELD_DENIED' };
  }

  return { allowed: true };
}
```

授权判断必须发生在服务端，并且与数据读取在同一请求内完成。前端可以用同一份策略生成按钮可见性，但那只是交互优化：任何写接口即使被直接调用，也要能返回 403。

### 3.4 多租户与项目隔离

隔离分两个维度。租户是硬边界，所有业务表都带 `tenant_id`，且 `tenant_id` 不可更新；项目是租户内的软边界，工单、知识库文章、回复模板都归属项目，成员按项目授权。跨租户读取在应用层表现为 404（不暴露资源存在性），跨项目读取在同租户内表现为 403，便于前端给出"需要项目权限"的提示。

隔离依赖三层，任何一层都不单独承担安全责任：

| 层 | 机制 | 拦截目标 |
|---|---|---|
| 路由层 | `TenantGuard` 校验成员关系与项目归属 | 无租户身份的请求 |
| 应用层 | 仓储强制注入 `tenant_id`、`project_id` 条件 | 遗漏过滤条件的查询 |
| 数据库层 | RLS 策略基于 `current_setting('app.tenant_id')` | 应用层漏写条件时的越权 |

每个事务开始时执行 `SET LOCAL app.tenant_id = $1`，RLS 策略要求行上的 `tenant_id` 与设置值相等。应用连接使用非超级用户角色，且没有 `BYPASSRLS` 权限；迁移连接使用独立角色，只用于 DDL。后台任务跨租户处理时使用单独的 worker 角色，按批次显式设置租户上下文，不做全局豁免。

### 3.5 字段级权限

字段策略表 `field_policies` 以 `(tenant_id, role_id, resource, field)` 为唯一键，包含 `can_read`、`can_write` 两个布尔值。读取时由序列化层按策略投影，未授权的字段不出现在响应里，而不是返回 `null`——`null` 会让前端误以为业务值为空。写入时按策略生成白名单，DTO 里出现未授权字段返回 403，出现未知字段返回 400，两种情况错误码分开，便于定位是越权还是拼错。

一个典型的字段矩阵：

| 字段 | 客服 | 客服主管 | 外包坐席 |
|---|---|---|---|
| `customer_phone` | 读/写 | 读/写 | 仅读后四位（由投影函数处理） |
| `internal_note` | 读/写 | 读/写 | 不可读、不可写 |
| `refund_amount` | 仅读 | 读/写 | 不可读 |
| `assignee_id` | 仅读 | 读/写 | 不可读 |
| `tenant_id` | 不可写 | 不可写 | 不可写 |

脱敏属于字段策略的一部分，不放在前端。投影函数按字段类型分派：手机号、身份证、金额分别有独立的脱敏器，输出结构在接口层统一，避免每个接口各写一遍。

### 3.6 越权防护的验证方式

权限相关的端到端用例必须覆盖反向场景：用 A 租户的 token 请求 B 租户的工单 ID，期望 404；用外包角色直接调用内部备注写接口，期望 403；构造带 `tenantId` 的请求体尝试改写归属，期望该字段被忽略且数据不变；把响应中不应出现的字段列入断言黑名单。这些用例放在 Playwright 的权限套件里，随 CI 每次执行。

## 4 模块设计与关键流程

### 4.1 模块边界

| 模块 | 单句职责 | 依赖 | 不属于该模块 |
|---|---|---|---|
| IamModule | 维护租户、项目、成员、角色与字段策略并回答授权问题 | 无业务模块 | 工单、知识库的任何读写 |
| TicketModule | 管理工单生命周期与消息追加 | Iam、Audit、Idempotency、Outbox | 组织与权限数据维护 |
| KnowledgeModule | 管理知识库文章版本、发布状态与回复模板渲染 | Iam、Audit | 工单状态流转、消息投递 |
| AuditModule | 以追加方式记录字段级变更 | 无 | 审计数据的查询鉴权 |
| IdempotencyModule | 占用幂等键并保存首次成功的响应快照 | 无 | 业务结果正确性 |
| OutboxModule | 落表并投递领域事件，失败重试 | 无 | 事件内容生成 |

依赖方向单向：Ticket 和 Knowledge 依赖 Iam 与 Audit，反向不允许。`AuditModule` 不依赖任何一个业务模块，它只接受调用方传入的 `resource`、`resourceId`、`before`、`after` 和 `actor`。

### 4.2 工单创建流程

创建工单是全系统唯一需要同时满足幂等、权限、审计和项目归属的写入路径，其他流程参照它的处理方式。

```mermaid
sequenceDiagram
    participant C as React SPA
    participant G as 全局管线
    participant T as TicketService
    participant I as IdempotencyService
    participant DB as PostgreSQL
    participant O as OutboxService

    C->>G: POST /v1/tickets (Idempotency-Key)
    G->>G: 认证 / 租户解析 / 权限求值
    G->>T: create(dto, ctx)
    T->>DB: BEGIN
    T->>I: begin(key, requestHash)（使用同一事务客户端）
    alt 键已存在且请求体一致
        I-->>T: 返回首次响应快照
        T->>DB: ROLLBACK
        T-->>C: 200 重复请求，返回原结果
    else 键已存在但请求体不同
        I-->>T: 冲突
        T->>DB: ROLLBACK
        T-->>C: 409 IDEMPOTENCY_KEY_REUSED
    else 键不存在
        I->>DB: INSERT idempotency_keys (PENDING)
        T->>DB: INSERT tickets (ticket_no 唯一)
        T->>DB: INSERT audit_logs (CREATE)
        T->>DB: INSERT outbox_events
        T->>DB: UPDATE idempotency_keys (COMPLETED + 响应快照)
        T->>DB: COMMIT
        T->>O: 立即尝试投递（失败由 Worker 补偿）
        T-->>C: 201 Created
    end
```

幂等键的占位与业务写入在同一个事务内完成，因此不会出现"键占了但工单没建"的空洞。当两个相同键的请求同时到达时，唯一索引让第二个 `INSERT` 阻塞到第一个事务结束，随后读到 `COMPLETED` 状态并返回快照；如果第一个事务回滚，第二个会插入成功并正常建单。这个行为依赖 `idempotency_keys` 上的唯一约束，而不是应用层的先查后写。

工单号由数据库序列生成，格式为 `{项目编码}-{序号}`，并在 `(tenant_id, project_id, ticket_no)` 上建唯一索引，即使应用层出现并发也不会产生重号。

### 4.3 工单状态机

状态迁移集中在 `TicketStateMachine` 中，迁移表是唯一事实来源，Controller 不允许直接写 `status` 字段。

```mermaid
stateDiagram-v2
    [*] --> OPEN
    OPEN --> PENDING: 等待客户回复
    PENDING --> OPEN: 客户回复
    OPEN --> RESOLVED: 标记解决
    PENDING --> RESOLVED: 标记解决
    RESOLVED --> OPEN: 客户重新打开
    RESOLVED --> CLOSED: 超期自动关闭
    OPEN --> CLOSED: 主管关闭
```

每次迁移校验三件事：当前状态是否允许目标状态、当前角色是否有该动作的权限、工单版本号是否与请求携带的版本一致。三者任一不满足则拒绝，不写入任何数据。

### 4.4 并发更新

工单、知识库文章、回复模板都带 `version` 整数列，每次更新 `version = version + 1`，并在 `WHERE` 子句中校验旧版本。更新影响行数为 0 时返回 `409 VERSION_CONFLICT`，附带当前版本号与最后修改人，前端提示"该工单已被他人更新"并允许刷新后重试。

选择乐观锁而不是悲观锁，原因是客服场景的冲突概率低，长时间持锁会让多人协作时页面卡住；乐观锁只在真正冲突时让一个请求重试，代价更小 `[Expert judgment]`。消息追加是纯新增，不做版本校验，避免两条消息因为并发而互相阻塞；消息顺序由 `created_at` 加自增 `seq` 保证。

```sql
-- 乐观更新，影响行数为 0 即代表冲突
UPDATE tickets
SET status = $1, assignee_id = $2, version = version + 1, updated_at = now()
WHERE id = $3
  AND tenant_id = current_setting('app.tenant_id')::uuid
  AND version = $4;
```

### 4.5 审计

审计表只追加，不提供更新与删除接口，数据库层面也不授予应用角色 `UPDATE`、`DELETE` 权限。每条记录包含 `tenant_id`、`project_id`、`resource`、`resource_id`、`action`、`actor_id`、`request_id`、`ip`、`before`、`after`、`changed_fields`、`created_at`。

`before` 与 `after` 用 `jsonb` 存变更字段的子集，不存整行。子集由写入方按字段策略计算：只记录本次实际改变且调用方有权看到的字段，避免审计表成为绕过字段权限的读取入口。审计写入与业务写入同事务，业务回滚则审计一并回滚；这一点优先于"审计永不丢失"的极端要求，因为回滚意味着变更从未发生。

审计查询本身也走权限求值：普通客服只能看自己经手工单的审计，主管可看项目内全部，租户管理员可看租户内全部。查询接口不分页返回全量，必须带时间范围且上限 200 条。

### 4.6 知识库与回复模板

知识库文章采用"文章 + 版本"两表结构。`kb_articles` 保存稳定标识、所属项目、当前发布版本指针；`kb_article_versions` 保存标题、正文、状态（草稿/已发布/归档）、作者。编辑产生新版本草稿，发布时把指针指向新版本，历史版本保留可回溯。这样可以做到"编辑不影响线上客服看到的答案"，也满足发布前审核。

检索使用 PostgreSQL 全文索引：`to_tsvector('simple', title || ' ' || body)` 建 GIN 索引，配合 `pg_trgm` 支持中文短语的模糊匹配。中文分词质量有限，因此检索结果同时返回关键词高亮片段，客服可据此判断相关性；不引入外部搜索引擎，避免多一个有状态组件 `[Expert judgment]`。

回复模板是知识库的一种资源类型，正文含 `{{customer_name}}` 形式的变量。渲染在服务端进行，变量白名单由模板定义声明，未声明的变量渲染失败而不是留空；渲染结果不回写模板，只作为消息内容写入工单。模板同样按项目隔离，跨项目不可见。

### 4.7 同步事务与 Outbox 的边界

Outbox 只承载"通知外部"这类可以延迟、可以重试的动作，例如邮件提醒、Webhook。工单本身的状态、审计、幂等结果不经过 Outbox，走同步事务。这样拆分的理由是：客服看到"工单已关闭"时，审计必须已经存在；而邮件晚几秒送达可以接受 `[Expert judgment]`。Worker 每 5 秒拉取一批 `PENDING` 事件，使用 `FOR UPDATE SKIP LOCKED` 避免多实例重复投递，失败按指数退避重试，超过 8 次标记 `DEAD` 并记录原因。

## 5 接口设计

### 5.1 接口清单

所有接口前缀 `/v1`，除登录与刷新外均要求 `Authorization: Bearer <access token>`。涉及项目的接口要求 `X-Project-Id` 请求头。

| 编号 | 方法与路径 | 用途 | 所需权限 |
|---|---|---|---|
| A1 | `POST /v1/auth/login` | 登录，签发 access/refresh | 公开 |
| A2 | `POST /v1/auth/refresh` | 轮换 refresh token | 携带 refresh Cookie |
| A3 | `POST /v1/auth/logout` | 撤销当前会话 | 已认证 |
| A4 | `GET /v1/me/permissions` | 返回当前成员的角色与字段策略摘要 | 已认证 |
| T1 | `GET /v1/tickets` | 工单列表，按项目过滤 | `ticket:list` |
| T2 | `POST /v1/tickets` | 创建工单 | `ticket:create` |
| T3 | `GET /v1/tickets/{id}` | 工单详情，按字段策略投影 | `ticket:read` |
| T4 | `PATCH /v1/tickets/{id}` | 更新状态、负责人等字段 | 按字段策略 |
| T5 | `POST /v1/tickets/{id}/messages` | 追加回复或内部备注 | `ticket:reply` / `ticket:note` |
| T6 | `GET /v1/tickets/{id}/audit` | 查询该工单审计 | `audit:read` |
| K1 | `GET /v1/kb/articles` | 知识库检索 | `kb:read` |
| K2 | `POST /v1/kb/articles` | 新建文章草稿 | `kb:write` |
| K3 | `POST /v1/kb/articles/{id}/publish` | 发布指定版本 | `kb:publish` |
| K4 | `POST /v1/reply-templates/{id}/render` | 渲染模板变量 | `template:use` |

### 5.2 创建工单

| 项目 | 内容 |
|---|---|
| 方法与路径 | `POST /v1/tickets` |
| 认证 | Bearer token；`X-Project-Id` 必填；需要 `ticket:create` |
| 请求头 | `Idempotency-Key` 必填，UUID v4，同一键 24 小时内有效 |
| 请求体 | `subject`（string，1–200，必填）、`description`（string，1–20000，必填）、`priority`（enum `LOW/NORMAL/HIGH/URGENT`，默认 `NORMAL`）、`customerName`（string，1–100，必填）、`customerPhone`（string，6–32，可选）、`assigneeId`（uuid，可选）、`tags`（string[]，最多 10 个）、`source`（enum `WEB/EMAIL/PHONE/API`，默认 `WEB`） |
| 成功响应 | `201 Created`，返回 `{ id, ticketNo, status, version, createdAt, fields: { ... } }`，`fields` 已按调用者字段策略投影 |
| 重复请求 | 同键同请求体返回 `200`，响应体与首次一致，附带 `Idempotent-Replay: true` |
| 错误码 | `400 VALIDATION_FAILED`、`401 UNAUTHORIZED`、`403 FORBIDDEN`、`403 FIELD_DENIED`、`404 PROJECT_NOT_FOUND`、`409 IDEMPOTENCY_KEY_REUSED`、`429 RATE_LIMITED` |
| 事务边界 | 工单、审计、幂等结果、Outbox 事件同一事务提交 |

请求示例与响应示例只列关键字段，完整 schema 由 DTO 与 `class-validator` 装饰器定义，OpenAPI 文档从装饰器生成，避免文档与实现分叉。

```json
{
  "subject": "无法登录管理后台",
  "description": "输入正确密码后提示账号被锁定",
  "priority": "HIGH",
  "customerName": "张伟",
  "customerPhone": "13800001234",
  "source": "PHONE"
}
```

### 5.3 更新工单

| 项目 | 内容 |
|---|---|
| 方法与路径 | `PATCH /v1/tickets/{id}` |
| 认证 | Bearer token；`X-Project-Id` 必填；字段级写权限 |
| 请求头 | `If-Match: "<version>"` 必填，值为客户端上次读到的版本号 |
| 请求体 | 允许字段：`status`、`assigneeId`、`priority`、`tags`。至少一个字段，未声明字段返回 400 |
| 成功响应 | `200 OK`，返回更新后的完整投影与新的 `version` |
| 错误码 | `400 VALIDATION_FAILED`、`400 INVALID_TRANSITION`、`403 FIELD_DENIED`、`404 NOT_FOUND`、`409 VERSION_CONFLICT`、`412 PRECONDITION_REQUIRED` |
| 并发语义 | `version` 与 `If-Match` 不一致直接拒绝，不做自动合并 |

`PATCH` 不走幂等键。原因是一次成功更新已经改变了版本号，重复提交的第二次请求会因 `If-Match` 不匹配得到 409，天然不会产生重复副作用。而创建工单没有这个天然屏障，必须依赖幂等键。

### 5.4 追加消息

| 项目 | 内容 |
|---|---|
| 方法与路径 | `POST /v1/tickets/{id}/messages` |
| 认证 | 公开回复需 `ticket:reply`，内部备注需 `ticket:note` |
| 请求头 | `Idempotency-Key` 必填 |
| 请求体 | `body`（string，1–10000，必填）、`visibility`（enum `PUBLIC/INTERNAL`，必填）、`templateId`（uuid，可选）、`templateVariables`（object，可选） |
| 成功响应 | `201 Created`，返回 `{ id, seq, visibility, createdAt }` |
| 错误码 | `400 VALIDATION_FAILED`、`400 TEMPLATE_VARIABLE_MISSING`、`403 FIELD_DENIED`、`409 TICKET_CLOSED`、`409 IDEMPOTENCY_KEY_REUSED` |

### 5.5 响应与错误约定

成功响应直接返回资源对象，列表使用 `{ items, nextCursor }` 游标分页，不使用 offset，避免工单持续新增时翻页重复或漏项。错误响应统一结构：

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

错误码与 HTTP 状态码的对应关系固定：参数问题 400，未认证 401，已认证但无权限 403，资源不存在或不可见 404，状态冲突与版本冲突 409，缺少前置条件 412，限流 429，未预期异常 500。未知字段一律 400，不静默丢弃，否则前端拼错字段时会以为写入成功。

### 5.6 知识库与模板接口

| 项目 | K1 检索 | K2 新建草稿 | K3 发布版本 | K4 渲染模板 |
|---|---|---|---|---|
| 方法与路径 | `GET /v1/kb/articles` | `POST /v1/kb/articles` | `POST /v1/kb/articles/{id}/publish` | `POST /v1/reply-templates/{id}/render` |
| 认证与权限 | Bearer；`kb:read` | Bearer；`kb:write` | Bearer；`kb:publish` | Bearer；`template:use` |
| 请求 | `q`（可选，≤100）、`cursor`、`limit`（默认 20，上限 50） | `slug`、`title`、`body`、`projectId` | `versionNo`、`comment`（可选） | `variables`（object，键必须在模板声明的白名单内） |
| 成功响应 | `200`，`{ items: [{ id, title, snippet, score }], nextCursor }` | `201`，`{ id, versionNo, status: "DRAFT" }` | `200`，`{ id, publishedVersionId, version }` | `200`，`{ body, missingVariables: [] }` |
| 错误码 | `400 VALIDATION_FAILED`、`403 FORBIDDEN` | `409 SLUG_TAKEN`、`403 FIELD_DENIED` | `404 NOT_FOUND`、`409 VERSION_CONFLICT`、`422 EMPTY_BODY` | `400 VARIABLE_NOT_ALLOWED`、`404 TEMPLATE_NOT_FOUND` |

检索只返回已发布版本的内容，草稿不进索引。发布使用文章级 `version` 做乐观锁，两个管理员同时发布时后提交者收到 409。渲染接口不写库，只返回渲染结果，调用方再把结果作为消息正文提交到 T5，因此渲染本身不需要幂等键。

### 5.7 接口演进

`/v1` 内部只做向后兼容的增量变更：新增可选字段、新增枚举值、新增接口。破坏性变更走 `/v2`，旧版本至少保留一个租户续约周期。新增枚举值时前端必须按未知值兜底显示，不在前端硬编码枚举全集。

## 6 数据设计

### 6.1 数据模型

```mermaid
erDiagram
    TENANTS ||--o{ PROJECTS : owns
    TENANTS ||--o{ MEMBERSHIPS : has
    USERS ||--o{ MEMBERSHIPS : joins
    PROJECTS ||--o{ MEMBERSHIP_PROJECTS : grants
    MEMBERSHIPS ||--o{ MEMBERSHIP_PROJECTS : scoped_to
    MEMBERSHIPS }o--o{ ROLES : assigned
    ROLES ||--o{ ROLE_PERMISSIONS : contains
    ROLES ||--o{ FIELD_POLICIES : defines
    PROJECTS ||--o{ TICKETS : contains
    TICKETS ||--o{ TICKET_MESSAGES : has
    TICKETS ||--o{ AUDIT_LOGS : logs
    PROJECTS ||--o{ KB_ARTICLES : contains
    KB_ARTICLES ||--o{ KB_ARTICLE_VERSIONS : versions
    KB_ARTICLES ||--o{ REPLY_TEMPLATES : templates
    TENANTS ||--o{ IDEMPOTENCY_KEYS : scopes
    TENANTS ||--o{ OUTBOX_EVENTS : emits
    USERS ||--o{ SESSIONS : holds

    TENANTS {
        uuid id PK
        string name
        string status
    }
    PROJECTS {
        uuid id PK
        uuid tenant_id FK
        string code
        string name
    }
    TICKETS {
        uuid id PK
        uuid tenant_id FK
        uuid project_id FK
        string ticket_no
        string status
        string priority
        uuid assignee_id
        int version
        string customer_name
        string customer_phone
        datetime created_at
    }
    TICKET_MESSAGES {
        uuid id PK
        uuid tenant_id FK
        uuid ticket_id FK
        bigint seq
        string visibility
        text body
        uuid author_id
    }
    AUDIT_LOGS {
        uuid id PK
        uuid tenant_id FK
        string resource
        uuid resource_id
        string action
        jsonb changed_fields
        uuid actor_id
        datetime created_at
    }
```

实体关系里有两处需要注意。成员与项目是多对多，成员可以在同一租户内被授予部分项目，而不是默认全租户可见；角色挂在成员上而不是用户上，同一个人在不同租户可以有不同角色。审计表通过 `resource` 加 `resource_id` 关联任意资源，不建外键，原因是审计要能记录已删除资源的历史，外键会阻止删除或级联清除审计。

### 6.2 关键表定义

| 表 | 关键列 | 约束与说明 |
|---|---|---|
| `tenants` | `id`、`name`、`status`、`created_at` | `status` 为 `ACTIVE/SUSPENDED`；`name` 加唯一索引 |
| `projects` | `id`、`tenant_id`、`code`、`name` | 唯一 `(tenant_id, code)`；`code` 用于工单号前缀 |
| `users` | `id`、`email`、`password_hash`、`locale` | 邮箱全局唯一；密码用 Argon2id |
| `memberships` | `id`、`tenant_id`、`user_id`、`status` | 唯一 `(tenant_id, user_id)`；`status` 为 `ACTIVE/INVITED/DISABLED` |
| `membership_projects` | `membership_id`、`project_id` | 唯一 `(membership_id, project_id)`，定义项目可见范围 |
| `membership_roles` | `membership_id`、`role_id` | 唯一 `(membership_id, role_id)`，成员可同时持有多个角色 |
| `roles` | `id`、`tenant_id`、`code`、`name` | 唯一 `(tenant_id, code)`；系统角色不可删除，只能改授权 |
| `role_permissions` | `role_id`、`resource`、`action` | 唯一 `(role_id, resource, action)` |
| `field_policies` | `id`、`tenant_id`、`role_id`、`resource`、`field`、`can_read`、`can_write` | 唯一 `(role_id, resource, field)`；无记录视为不可读写 |
| `tickets` | `id`、`tenant_id`、`project_id`、`ticket_no`、`status`、`priority`、`assignee_id`、`version`、`customer_name`、`customer_phone`、`created_at`、`updated_at` | 唯一 `(tenant_id, project_id, ticket_no)`；`version` 默认 1 |
| `ticket_messages` | `id`、`tenant_id`、`ticket_id`、`seq`、`visibility`、`body`、`author_id`、`created_at` | 唯一 `(ticket_id, seq)`；`seq` 由工单维度序列生成 |
| `audit_logs` | `id`、`tenant_id`、`project_id`、`resource`、`resource_id`、`action`、`actor_id`、`request_id`、`ip`、`before`、`after`、`changed_fields`、`created_at` | 只追加；无外键；按月分区可选 |
| `idempotency_keys` | `id`、`tenant_id`、`key`、`endpoint`、`request_hash`、`status`、`response_snapshot`、`expires_at` | 唯一 `(tenant_id, key)`；`status` 为 `PENDING/COMPLETED` |
| `kb_articles` | `id`、`tenant_id`、`project_id`、`slug`、`published_version_id`、`version` | 唯一 `(project_id, slug)` |
| `kb_article_versions` | `id`、`article_id`、`version_no`、`title`、`body`、`status`、`author_id` | 唯一 `(article_id, version_no)` |
| `reply_templates` | `id`、`tenant_id`、`project_id`、`name`、`body`、`variables`、`version` | `variables` 为 `jsonb` 数组，声明可渲染变量 |
| `sessions` | `id`、`user_id`、`tenant_id`、`refresh_token_hash`、`token_version`、`user_agent`、`ip`、`last_used_at`、`expires_at`、`revoked_at` | 用于撤销、设备列表与刷新轮换 |
| `outbox_events` | `id`、`tenant_id`、`type`、`payload`、`status`、`attempts`、`available_at`、`created_at` | 索引 `(status, available_at)` |

`tickets` 上的 `customer_phone` 与外部传入的自由文本字段在入库前做格式归一，查询时按字段策略决定是否脱敏输出。审计表如果是高写入量场景，可按 `created_at` 做月度分区，分区键加入主键；当前规模不预先分区，避免迁移复杂度 `[Hypothesis]`。

### 6.3 索引策略

| 索引 | 目标查询 | 理由 |
|---|---|---|
| `tickets (tenant_id, project_id, status, updated_at DESC)` | 工单列表按状态筛选 | 覆盖最常见的列表条件，避免全表扫描 |
| `tickets (tenant_id, assignee_id, status)` | 我的待办 | 坐席工作台的主查询 |
| `ticket_messages (ticket_id, seq)` | 会话时间线 | 唯一索引兼作排序 |
| `audit_logs (tenant_id, resource, resource_id, created_at DESC)` | 单条记录审计 | 详情页追溯 |
| `audit_logs (tenant_id, created_at DESC)` | 租户审计流 | 管理员按时间浏览 |
| `idempotency_keys (expires_at)` | 过期清理 | Worker 批量删除 |
| `kb_article_versions` 上的 GIN `to_tsvector` | 知识库检索 | 全文匹配 |
| `outbox_events (status, available_at)` | 待投递事件 | 部分索引只含 `PENDING` |

不在 `status` 这类低基数列上单独建索引，选择性不足，扫描成本高于顺序读。索引随迁移脚本一起版本化，禁止在控制台手工创建后不回填迁移文件，否则预发与生产会出现结构漂移。

### 6.4 行级安全与迁移脚本

RLS 策略通过原生 SQL 迁移建立，写在 Prisma 迁移目录下的 `.sql` 文件中，由 `prisma migrate` 按顺序执行。策略对每张含 `tenant_id` 的业务表统一处理：

```sql
-- migrations/20260101000000_enable_rls/migration.sql
ALTER TABLE tickets ENABLE ROW LEVEL SECURITY;
ALTER TABLE tickets FORCE ROW LEVEL SECURITY;

CREATE POLICY tickets_tenant_isolation ON tickets
  USING (tenant_id = current_setting('app.tenant_id', true)::uuid)
  WITH CHECK (tenant_id = current_setting('app.tenant_id', true)::uuid);

-- 应用角色无 BYPASSRLS，只能读写本租户数据
GRANT SELECT, INSERT, UPDATE ON tickets TO app_rw;
REVOKE UPDATE, DELETE ON audit_logs FROM app_rw;
```

`FORCE ROW LEVEL SECURITY` 让表所有者同样受策略约束，避免应用恰好用所有者账号连接时隔离失效。`current_setting` 的第二个参数为 `true` 时，未设置变量会返回 `NULL` 而不是报错；此时条件不成立，查询返回空集，属于安全失败方向。连接池在每次事务开始时设置租户变量，事务结束即失效，不会把上一个租户的上下文带给下一个请求。

### 6.5 迁移流程

迁移文件由 Prisma 生成骨架，涉及 RLS、部分索引、函数和触发器的部分手写 SQL 补充，且手写部分必须有回滚说明。流程约束如下：

1. 迁移只前进，不回滚生产数据。回滚以新增一个补偿迁移实现，保留变更历史。
2. 采用扩展—收缩模式：加列先允许 `NULL` 或带默认值，代码双写或兼容读，确认无旧版本实例后再加非空约束，最后清理旧列。单个迁移内不同时做加列与删列。
3. CI 中对干净库执行全量迁移，再用 `prisma migrate diff` 比较迁移结果与 schema 文件，不一致则失败。这样能拦住"改了 schema 没生成迁移"的情况。
4. 迁移在应用启动前以独立任务执行，应用容器不做自动迁移，避免多副本同时执行 DDL 造成锁竞争。
5. 种子数据（系统角色、默认字段策略、演示租户）由独立 seed 脚本维护，可重复执行，使用 `ON CONFLICT DO NOTHING` 保证幂等。

## 7 一致性与失败处理

### 7.1 写路径的保护方式

不同写操作的风险不同，保护手段也不同。统一给所有写接口套幂等键会产生大量无意义的键记录，统一用版本号又会挡住纯追加操作，因此按操作类型分别处理。

| 写操作 | 重复提交的保护 | 并发冲突的保护 | 重复执行的结果 |
|---|---|---|---|
| 创建工单 | `Idempotency-Key` + 唯一约束 | 唯一索引 `ticket_no` | 返回首次结果，不新建 |
| 追加消息 | `Idempotency-Key` | 工单维度序列 `seq` | 返回首次结果，不重复追加 |
| 更新工单字段 | `If-Match` 版本号 | 乐观锁 `version` | 第二次返回 409 |
| 发布知识库版本 | 发布动作天然幂等 | 文章 `version` 乐观锁 | 指针已指向该版本时返回 200 |
| 分配负责人 | 目标值幂等 | `version` 乐观锁 | 重复分配同一人无副作用 |
| 标记已读 | 不需要 | 不需要 | 重复标记无副作用 |

幂等键记录保留 24 小时，过期由 Worker 每日清理。清理只删除 `COMPLETED` 且已过期的记录，`PENDING` 超过 10 分钟的记录保留并告警，因为它意味着有事务长时间未提交，属于需要排查的异常，不能静默删除。

### 7.2 错误分类与处理

| 故障 | 表现 | 处理 |
|---|---|---|
| 数据库连接瞬断 | 查询报连接错误 | 驱动层重试一次，仅限只读查询；写事务不自动重试，交给客户端用同一幂等键重放 |
| 唯一约束冲突 | 并发创建同号或同幂等键 | 识别约束名转为 409，不返回 500 |
| 死锁 | 事务被数据库中止 | 整个事务回滚，最多重试 2 次，第二次仍失败返回 503 并带 `Retry-After` |
| Redis 不可用 | 限流与会话缓存失效 | 降级为仅 JWT 校验，限流按本机内存计数，记录告警 |
| Outbox 投递失败 | 外部通知延迟 | 指数退避重试，8 次后转 `DEAD`，由运维视图暴露 |
| 第三方 Webhook 超时 | 响应慢 | 超时 3 秒，失败不阻塞主事务，全部走 Outbox |

异常过滤器按类型映射：领域异常映射到 4xx 并保留错误码，未知异常统一映射 500 并只返回 `requestId`，堆栈写日志不外泄。数据库错误原文不返回给客户端，避免泄露表结构。

### 7.3 超时与重试边界

HTTP 请求总预算 10 秒，数据库单语句 3 秒，外部调用 3 秒。超过预算的连接由 Nginx 切断并返回 504。重试只发生在三层：驱动层只读查询重试一次、Worker 投递重试、客户端用同一幂等键重放。写事务内部不做自动重试，因为无法判断失败发生在提交前还是提交后，盲目重试可能造成重复写入 `[Expert judgment]`。

## 8 部署架构

### 8.1 部署拓扑

```mermaid
graph LR
    subgraph Host["单台主机 / Docker Compose 网络"]
        NX["nginx:alpine<br/>:80 / :443"]
        WEB["web<br/>React 静态产物"]
        API["api<br/>NestJS 多副本"]
        WK["worker<br/>Outbox / 清理任务"]
        PG[("postgres:16<br/>数据卷")]
        RD[("redis:7<br/>数据卷")]
        MIG["migrate<br/>一次性任务"]
    end

    User["浏览器"] -->|443| NX
    NX --> WEB
    NX -->|/api| API
    API --> PG
    API --> RD
    WK --> PG
    MIG -->|启动前执行| PG
```

Compose 中的服务划分保持最小：`web` 只放构建产物，`api` 无状态可横向扩到 2–3 个副本，`worker` 单副本（依靠 `SKIP LOCKED` 也支持多副本），`postgres` 与 `redis` 挂命名卷。`migrate` 是 profile 为 `tools` 的一次性容器，部署流程先跑它再启动 `api`。Nginx 同时托管静态资源与反向代理，前端路由使用 history 模式时回退到 `index.html`。

### 8.2 服务定义要点

```yaml
services:
  api:
    build: { context: ., dockerfile: apps/api/Dockerfile }
    environment:
      DATABASE_URL: postgresql://app_rw:${DB_PASSWORD}@postgres:5432/ticket?schema=public
      REDIS_URL: redis://redis:6379
      JWT_PRIVATE_KEY_FILE: /run/secrets/jwt_private.pem
    depends_on:
      postgres: { condition: service_healthy }
      redis: { condition: service_healthy }
    healthcheck:
      test: ["CMD", "node", "dist/healthcheck.js"]
      interval: 15s
      timeout: 3s
      retries: 3
    restart: unless-stopped

  migrate:
    profiles: ["tools"]
    build: { context: ., dockerfile: apps/api/Dockerfile }
    command: ["npx", "prisma", "migrate", "deploy"]
    depends_on:
      postgres: { condition: service_healthy }
```

数据库账号分三个：`app_rw` 供应用读写且无 DDL 权限，`app_migrator` 供迁移使用，`app_worker` 供后台任务跨租户扫描。三者密码通过环境变量注入，不写进镜像。JWT 私钥以文件挂载或密钥文件注入，不放进环境变量，避免出现在 `docker inspect` 输出里。

### 8.3 运行与容量

单副本 API 的 Node 进程内存上限设为 1 GB，超过由容器 OOM 重启；连接池上限按 `副本数 × 10` 计算，保证不超过 PostgreSQL 的 `max_connections` 预留。扩副本是无状态的，但会话撤销依赖数据库与 Redis，因此任意副本都能处理任意请求。

健康检查分两个端点：`/health/live` 只判断进程存活，`/health/ready` 检查数据库连接与迁移版本是否匹配。就绪检查失败时摘除流量但不重启进程，避免迁移未完成时反复重启。

备份策略是每日一次 `pg_dump` 全量加持续 WAL 归档，保留 14 天；恢复演练每季度一次，验证从备份恢复到可登录、可查工单的时间。审计表与业务表同库同备份，不单独导出。

### 8.4 配置与环境

配置按环境分层：`.env.example` 声明所有键，CI 使用测试库地址，预发与生产通过部署平台注入。启动时用 schema 校验配置，缺键直接退出而不是用默认值兜底，避免生产误连测试库。日志、数据库连接串、JWT 密钥这三类配置每次启动写入启动日志的键名（不写值），便于核对环境。

## 9 工程流水线与测试

### 9.1 流水线阶段

GitHub Actions 按依赖关系串成一条流水线，后面的阶段只在前面全部通过后执行。缓存 `pnpm` 存储目录与 Playwright 浏览器二进制，把重复下载的时间压到最低。

```yaml
name: ci
on:
  pull_request:
  push:
    branches: [main]

jobs:
  static:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: pnpm/action-setup@v4
      - uses: actions/setup-node@v4
        with: { node-version: 20, cache: pnpm }
      - run: pnpm install --frozen-lockfile
      - run: pnpm lint && pnpm typecheck

  integration:
    needs: static
    runs-on: ubuntu-latest
    services:
      postgres:
        image: postgres:16
        env:
          POSTGRES_USER: app_migrator
          POSTGRES_PASSWORD: test
          POSTGRES_DB: ticket_test
        options: >-
          --health-cmd "pg_isready -U app_migrator"
          --health-interval 5s --health-timeout 3s --health-retries 10
    steps:
      - uses: actions/checkout@v4
      - run: pnpm install --frozen-lockfile
      - run: pnpm prisma migrate deploy
      - run: pnpm prisma migrate diff --from-migrations prisma/migrations --to-schema-datamodel prisma/schema.prisma --shadow-database-url $SHADOW_DATABASE_URL --exit-code
      - run: pnpm test:unit -- --coverage
      - run: pnpm test:integration

  e2e:
    needs: integration
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - run: pnpm install --frozen-lockfile
      - run: pnpm exec playwright install --with-deps chromium
      - run: docker compose -f docker-compose.ci.yml up -d --build
      - run: pnpm exec playwright test
      - uses: actions/upload-artifact@v4
        if: failure()
        with: { name: playwright-report, path: playwright-report/ }
```

`static` 与 `integration` 分别覆盖类型错误与真实数据库行为，`e2e` 依赖前两者通过，避免在明显编译失败时浪费浏览器环境。`main` 分支要求这三项为必需检查，未通过不允许合并。

镜像构建放在主分支合并之后，构建产物打上提交 SHA 标签，部署时按标签拉取而不是 `latest`，保证回滚有明确目标。依赖漏洞扫描在构建阶段执行，高危项阻断发布，中低危记录待处理。

### 9.2 测试分层

| 层次 | 工具 | 覆盖内容 | 运行时机 |
|---|---|---|---|
| 单元测试 | Vitest | 权限求值、状态机、模板渲染、脱敏函数 | 每次提交 |
| 集成测试 | Vitest + 真实 PostgreSQL | 仓储的租户过滤、RLS 策略、幂等约束、乐观锁 | 每次提交 |
| 端到端 | Playwright | 登录、建单、回复、权限拒绝、并发冲突提示 | 每次 PR 与主分支 |

权限与幂等的核心断言必须落在集成层。这类逻辑依赖数据库的唯一约束、事务隔离和 RLS，用 mock 测出来的通过没有意义。集成测试每个文件使用独立 schema 或独立数据库，测试结束即销毁，避免互相污染。

### 9.3 端到端测试设计

Playwright 按角色建立 `storageState`，登录一次复用，避免每个用例都走登录流程。租户数据由 fixture 通过 API 创建，每次运行使用随机后缀，多个 worker 并行时互不干扰。

```ts
// tests/fixtures/tenant.ts 的形态
export const test = base.extend<{ tenant: TenantFixture }>({
  tenant: async ({ request }, use) => {
    const suffix = randomUUID().slice(0, 8);
    const tenant = await createTenant(request, `e2e-${suffix}`);
    await use(tenant);
    await deleteTenant(request, tenant.id); // 清理，失败不影响断言结果
  },
});
```

用例按标签分组：`@permissions` 覆盖越权拒绝，`@idempotency` 覆盖重复提交，`@concurrency` 覆盖双标签页同时更新，`@kb` 覆盖知识库发布与模板渲染。CI 全量执行；本地可只跑受影响的标签。失败时保留 trace、截图与视频，成功不保留，避免产物堆积。

并发用例的实现方式是两个浏览器上下文同时打开同一工单，各自提交不同修改，断言其中一个成功、另一个收到 409 提示且页面未丢失已输入内容。重复提交用例拦截网络层，把同一个请求发送两次，断言工单列表只多出一条。

## 10 安全、性能与可观测性

### 10.1 安全控制

传输层强制 HTTPS，Nginx 配置 HSTS、`X-Content-Type-Options`、`Referrer-Policy` 与限制性的 CSP。前端不使用 `dangerouslySetInnerHTML` 渲染工单正文或知识库内容，富文本统一在后端清洗后以结构化节点返回；必须渲染 HTML 的场景走白名单标签过滤。

限流按三档：登录接口按 IP 加账号双维度，5 次失败后锁定 10 分钟；写接口按用户每分钟 60 次；读接口按用户每分钟 300 次。计数在 Redis，超限返回 429 与 `Retry-After`。限流键包含租户，避免一个租户的突发流量挤占其他租户。

密码使用 Argon2id，参数在配置中声明并随硬件评估调整；登录失败提示统一为"账号或密码错误"，不区分账号是否存在。敏感配置只来自环境或密钥文件，仓库中不出现真实密钥，CI 用假值跑测试。

### 10.2 性能预算

| 场景 | 目标 | 实现要点 |
|---|---|---|
| 工单列表首屏 | P95 ≤ 300ms | 覆盖索引 + 游标分页，默认 20 条 |
| 工单详情 | P95 ≤ 200ms | 单次查询带出消息前 50 条，其余按需加载 |
| 创建工单 | P95 ≤ 400ms | 同步写四张表，无外部调用 |
| 权限求值 | P95 ≤ 5ms | 角色策略按租户缓存 60 秒，失效由变更事件触发 |
| 知识库检索 | P95 ≤ 500ms | GIN 索引 + 结果截断 20 条 |

缓存只用于权限策略和知识库热门文章，工单数据不缓存，避免出现"刚改完刷新看不到"的困惑。缓存失效采用主动删除而不是等过期，权限变更接口提交后立即清除该租户的策略键。

### 10.3 可观测性

日志使用结构化 JSON，每条包含 `timestamp`、`level`、`requestId`、`tenantId`、`userId`、`route`、`statusCode`、`durationMs`。业务日志与访问日志分开输出，审计日志只写数据库，不依赖日志系统承担合规职责。

指标按 RED 方式采集：请求速率、错误率、响应时长，按路由与租户维度打标签；另有数据库连接池占用、慢查询计数、Outbox 积压数、幂等键 `PENDING` 数四个业务指标。慢查询阈值 500ms，超过记录 SQL 指纹，不记录参数值。

告警只针对可行动的信号：5xx 比例连续 5 分钟超过 1%、Outbox 积压超过 100 条、就绪检查连续失败、登录失败率异常升高。每条告警附排查入口（对应日志查询与仪表盘链接），不发无处置动作的通告。

### 10.4 数据保护

客户手机号、邮箱等个人数据在数据库中按需加密存储，密钥由部署环境管理；导出功能单独授权并记录审计，导出文件带水印与有效期。租户注销时先冻结访问，再按保留期清理业务数据，审计记录保留至法定期限后归档。备份文件加密存储，恢复演练在隔离环境进行。





