CREATE TABLE "stored_files" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"file_name" text NOT NULL,
	"content_type" text NOT NULL,
	"size_bytes" bigint NOT NULL,
	"sha256" text NOT NULL,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone,
	CONSTRAINT "stored_files_kind_check" CHECK ("stored_files"."kind" in ('contract'))
);
--> statement-breakpoint
ALTER TABLE "stored_files" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "tenants" DROP CONSTRAINT "tenants_status_check";--> statement-breakpoint
DROP INDEX "vehicle_categories_preset_key";--> statement-breakpoint
ALTER TABLE "tenants" ADD COLUMN "status_reason" text;--> statement-breakpoint
ALTER TABLE "tenants" ADD COLUMN "status_changed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "stored_files" ADD CONSTRAINT "stored_files_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stored_files" ADD CONSTRAINT "stored_files_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "stored_files_organization_id_idx" ON "stored_files" USING btree ("organization_id","kind");--> statement-breakpoint
CREATE UNIQUE INDEX "pedestrian_rules_tenant_zone_key" ON "pedestrian_rules" USING btree ("tenant_id",coalesce("zone_id", '00000000-0000-0000-0000-000000000000'::uuid)) WHERE "pedestrian_rules"."deleted_at" is null;--> statement-breakpoint
CREATE UNIQUE INDEX "vehicle_categories_preset_key" ON "vehicle_categories" USING btree ("organization_id",coalesce("site_id", '00000000-0000-0000-0000-000000000000'::uuid),"preset_code") WHERE "vehicle_categories"."preset_code" is not null and "vehicle_categories"."deleted_at" is null;--> statement-breakpoint
ALTER TABLE "tenants" ADD CONSTRAINT "tenants_status_check" CHECK ("tenants"."status" in ('active', 'blocked_new_passes', 'blocked_entry', 'blocked_full', 'archived'));--> statement-breakpoint
CREATE POLICY "organization_isolation" ON "stored_files" AS PERMISSIVE FOR ALL TO public USING ("organization_id" = nullif(current_setting('app.organization_id', true), '')::uuid) WITH CHECK ("organization_id" = nullif(current_setting('app.organization_id', true), '')::uuid);