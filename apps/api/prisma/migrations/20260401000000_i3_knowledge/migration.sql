-- ===== I3 知识库与回复模板 =====

-- CreateEnum
CREATE TYPE "kb_article_version_status" AS ENUM ('DRAFT', 'PUBLISHED', 'ARCHIVED');

-- CreateTable
CREATE TABLE "kb_articles" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "project_id" UUID NOT NULL,
    "slug" TEXT NOT NULL,
    "published_version_id" UUID,
    "version" INTEGER NOT NULL DEFAULT 1,
    "archived_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "kb_articles_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "kb_article_versions" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "article_id" UUID NOT NULL,
    "version_no" INTEGER NOT NULL,
    "title" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "status" "kb_article_version_status" NOT NULL DEFAULT 'DRAFT',
    "author_id" UUID NOT NULL,
    "published_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "kb_article_versions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "reply_templates" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "project_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "variables" JSONB NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 1,
    "archived_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "reply_templates_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "kb_articles_project_id_slug_key" ON "kb_articles"("project_id", "slug");

-- CreateIndex
CREATE INDEX "kb_articles_tenant_id_project_id_updated_at_id_idx" ON "kb_articles"("tenant_id", "project_id", "updated_at" DESC, "id" DESC);

-- CreateIndex
CREATE INDEX "kb_articles_tenant_id_published_version_id_idx" ON "kb_articles"("tenant_id", "published_version_id");

-- CreateIndex
CREATE UNIQUE INDEX "kb_article_versions_article_id_version_no_key" ON "kb_article_versions"("article_id", "version_no");

-- CreateIndex
CREATE INDEX "kb_article_versions_tenant_id_article_id_version_no_idx" ON "kb_article_versions"("tenant_id", "article_id", "version_no" DESC);

-- CreateIndex：pg_trgm 三元组索引，支撑中文短语的部分匹配（ILIKE）。
CREATE INDEX "kb_article_versions_title_trgm_idx" ON "kb_article_versions" USING GIN ("title" gin_trgm_ops);

-- CreateIndex
CREATE INDEX "kb_article_versions_body_trgm_idx" ON "kb_article_versions" USING GIN ("body" gin_trgm_ops);

-- CreateIndex
CREATE UNIQUE INDEX "reply_templates_project_id_name_key" ON "reply_templates"("project_id", "name");

-- CreateIndex
CREATE INDEX "reply_templates_tenant_id_project_id_updated_at_idx" ON "reply_templates"("tenant_id", "project_id", "updated_at" DESC);

-- AddForeignKey
ALTER TABLE "kb_articles" ADD CONSTRAINT "kb_articles_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "kb_article_versions" ADD CONSTRAINT "kb_article_versions_article_id_fkey" FOREIGN KEY ("article_id") REFERENCES "kb_articles"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "reply_templates" ADD CONSTRAINT "reply_templates_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- ===== I3 租户隔离：与 I1/I2 相同的策略形态，未设置 app.tenant_id 时返回空集 =====
ALTER TABLE "kb_articles" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "kb_articles" FORCE ROW LEVEL SECURITY;
CREATE POLICY "kb_articles_tenant_isolation" ON "kb_articles"
  USING ("tenant_id" = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK ("tenant_id" = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

ALTER TABLE "kb_article_versions" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "kb_article_versions" FORCE ROW LEVEL SECURITY;
CREATE POLICY "kb_article_versions_tenant_isolation" ON "kb_article_versions"
  USING ("tenant_id" = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK ("tenant_id" = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

ALTER TABLE "reply_templates" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "reply_templates" FORCE ROW LEVEL SECURITY;
CREATE POLICY "reply_templates_tenant_isolation" ON "reply_templates"
  USING ("tenant_id" = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK ("tenant_id" = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
