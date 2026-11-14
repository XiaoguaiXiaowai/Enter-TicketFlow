-- I0 基线迁移：只建立后续迭代依赖的数据库扩展，不建任何业务表。
CREATE EXTENSION IF NOT EXISTS pgcrypto;
CREATE EXTENSION IF NOT EXISTS pg_trgm;
