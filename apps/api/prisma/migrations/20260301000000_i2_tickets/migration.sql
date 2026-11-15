-- CreateEnum
CREATE TYPE "ticket_status" AS ENUM ('OPEN', 'PENDING', 'RESOLVED', 'CLOSED');

-- CreateEnum
CREATE TYPE "ticket_priority" AS ENUM ('LOW', 'NORMAL', 'HIGH', 'URGENT');

-- CreateEnum
CREATE TYPE "ticket_source" AS ENUM ('WEB', 'EMAIL', 'PHONE', 'API');

-- CreateEnum
CREATE TYPE "message_visibility" AS ENUM ('PUBLIC', 'INTERNAL');

-- CreateEnum
CREATE TYPE "idempotency_status" AS ENUM ('PENDING', 'COMPLETED');

-- CreateEnum
CREATE TYPE "outbox_status" AS ENUM ('PENDING', 'DELIVERED', 'DEAD');

-- CreateTable
CREATE TABLE "tickets" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "project_id" UUID NOT NULL,
    "ticket_no" TEXT NOT NULL,
    "subject" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "status" "ticket_status" NOT NULL DEFAULT 'OPEN',
    "priority" "ticket_priority" NOT NULL DEFAULT 'NORMAL',
    "source" "ticket_source" NOT NULL DEFAULT 'WEB',
    "customer_name" TEXT NOT NULL,
    "customer_phone" TEXT,
    "internal_note" TEXT,
    "refund_amount" DECIMAL(12,2),
    "assignee_id" UUID,
    "tags" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "version" INTEGER NOT NULL DEFAULT 1,
    "message_seq" INTEGER NOT NULL DEFAULT 0,
    "created_by" UUID NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "tickets_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ticket_counters" (
    "tenant_id" UUID NOT NULL,
    "project_id" UUID NOT NULL,
    "next_value" INTEGER NOT NULL DEFAULT 1,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ticket_counters_pkey" PRIMARY KEY ("tenant_id","project_id")
);

-- CreateTable
CREATE TABLE "ticket_messages" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "ticket_id" UUID NOT NULL,
    "seq" INTEGER NOT NULL,
    "visibility" "message_visibility" NOT NULL,
    "body" TEXT NOT NULL,
    "author_id" UUID NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ticket_messages_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "audit_logs" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "project_id" UUID,
    "resource" TEXT NOT NULL,
    "resource_id" UUID NOT NULL,
    "action" TEXT NOT NULL,
    "actor_id" UUID NOT NULL,
    "request_id" TEXT NOT NULL,
    "ip" TEXT,
    "before" JSONB,
    "after" JSONB,
    "changed_fields" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "audit_logs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "idempotency_keys" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "key" TEXT NOT NULL,
    "endpoint" TEXT NOT NULL,
    "request_hash" TEXT NOT NULL,
    "status" "idempotency_status" NOT NULL DEFAULT 'PENDING',
    "status_code" INTEGER,
    "response_snapshot" JSONB,
    "expires_at" TIMESTAMP(3) NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "idempotency_keys_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "outbox_events" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "type" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "status" "outbox_status" NOT NULL DEFAULT 'PENDING',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "available_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "last_error" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "outbox_events_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "tickets_tenant_id_project_id_status_updated_at_idx" ON "tickets"("tenant_id", "project_id", "status", "updated_at" DESC);

-- CreateIndex
CREATE INDEX "tickets_tenant_id_project_id_updated_at_id_idx" ON "tickets"("tenant_id", "project_id", "updated_at" DESC, "id" DESC);

-- CreateIndex
CREATE INDEX "tickets_tenant_id_assignee_id_status_idx" ON "tickets"("tenant_id", "assignee_id", "status");

-- CreateIndex
CREATE UNIQUE INDEX "tickets_tenant_id_project_id_ticket_no_key" ON "tickets"("tenant_id", "project_id", "ticket_no");

-- CreateIndex
CREATE INDEX "ticket_messages_ticket_id_seq_idx" ON "ticket_messages"("ticket_id", "seq");

-- CreateIndex
CREATE UNIQUE INDEX "ticket_messages_ticket_id_seq_key" ON "ticket_messages"("ticket_id", "seq");

-- CreateIndex
CREATE INDEX "audit_logs_tenant_id_resource_resource_id_created_at_idx" ON "audit_logs"("tenant_id", "resource", "resource_id", "created_at" DESC);

-- CreateIndex
CREATE INDEX "audit_logs_tenant_id_created_at_idx" ON "audit_logs"("tenant_id", "created_at" DESC);

-- CreateIndex
CREATE INDEX "idempotency_keys_expires_at_idx" ON "idempotency_keys"("expires_at");

-- CreateIndex
CREATE UNIQUE INDEX "idempotency_keys_tenant_id_key_key" ON "idempotency_keys"("tenant_id", "key");

-- CreateIndex
CREATE INDEX "outbox_events_status_available_at_idx" ON "outbox_events"("status", "available_at");

-- AddForeignKey
ALTER TABLE "tickets" ADD CONSTRAINT "tickets_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ticket_counters" ADD CONSTRAINT "ticket_counters_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ticket_messages" ADD CONSTRAINT "ticket_messages_ticket_id_fkey" FOREIGN KEY ("ticket_id") REFERENCES "tickets"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ===== I2 租户隔离：与 I1 相同的策略形态，未设置 app.tenant_id 时返回空集 =====
ALTER TABLE "tickets" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "tickets" FORCE ROW LEVEL SECURITY;
CREATE POLICY "tickets_tenant_isolation" ON "tickets"
  USING ("tenant_id" = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK ("tenant_id" = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

ALTER TABLE "ticket_counters" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "ticket_counters" FORCE ROW LEVEL SECURITY;
CREATE POLICY "ticket_counters_tenant_isolation" ON "ticket_counters"
  USING ("tenant_id" = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK ("tenant_id" = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

ALTER TABLE "ticket_messages" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "ticket_messages" FORCE ROW LEVEL SECURITY;
CREATE POLICY "ticket_messages_tenant_isolation" ON "ticket_messages"
  USING ("tenant_id" = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK ("tenant_id" = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

ALTER TABLE "audit_logs" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "audit_logs" FORCE ROW LEVEL SECURITY;
CREATE POLICY "audit_logs_tenant_isolation" ON "audit_logs"
  USING ("tenant_id" = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK ("tenant_id" = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

ALTER TABLE "idempotency_keys" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "idempotency_keys" FORCE ROW LEVEL SECURITY;
CREATE POLICY "idempotency_keys_tenant_isolation" ON "idempotency_keys"
  USING ("tenant_id" = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK ("tenant_id" = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

ALTER TABLE "outbox_events" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "outbox_events" FORCE ROW LEVEL SECURITY;
CREATE POLICY "outbox_events_tenant_isolation" ON "outbox_events"
  USING ("tenant_id" = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK ("tenant_id" = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

