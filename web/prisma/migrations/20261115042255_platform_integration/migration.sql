-- AlterTable
ALTER TABLE "users" ADD COLUMN     "disabled_at" TIMESTAMP(3);

-- CreateTable
CREATE TABLE "platform_tenant_mappings" (
    "id" SERIAL NOT NULL,
    "organization_id" UUID NOT NULL,
    "tenant_id" INTEGER NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'active',
    "organization_status" TEXT NOT NULL DEFAULT 'active',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "platform_tenant_mappings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "platform_user_mappings" (
    "id" SERIAL NOT NULL,
    "platform_user_id" UUID NOT NULL,
    "user_id" INTEGER NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "platform_user_mappings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "platform_processed_events" (
    "event_id" UUID NOT NULL,
    "type" TEXT NOT NULL,
    "processed_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "platform_processed_events_pkey" PRIMARY KEY ("event_id")
);

-- CreateIndex
CREATE UNIQUE INDEX "platform_tenant_mappings_organization_id_key" ON "platform_tenant_mappings"("organization_id");

-- CreateIndex
CREATE UNIQUE INDEX "platform_tenant_mappings_tenant_id_key" ON "platform_tenant_mappings"("tenant_id");

-- CreateIndex
CREATE UNIQUE INDEX "platform_user_mappings_platform_user_id_key" ON "platform_user_mappings"("platform_user_id");

-- CreateIndex
CREATE UNIQUE INDEX "platform_user_mappings_user_id_key" ON "platform_user_mappings"("user_id");
