CREATE TABLE "pass_form_settings" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"site_id" uuid NOT NULL,
	"level" text NOT NULL,
	"tenant_id" uuid,
	"user_id" uuid,
	"settings" jsonb NOT NULL,
	"updated_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "pass_form_settings_key" UNIQUE NULLS NOT DISTINCT("site_id","level","tenant_id","user_id"),
	CONSTRAINT "pass_form_settings_level_check" CHECK ("pass_form_settings"."level" in ('site', 'tenant', 'user')),
	CONSTRAINT "pass_form_settings_level_scope_check" CHECK (("pass_form_settings"."level" = 'site' and "pass_form_settings"."tenant_id" is null and "pass_form_settings"."user_id" is null)
        or ("pass_form_settings"."level" = 'tenant' and "pass_form_settings"."tenant_id" is not null and "pass_form_settings"."user_id" is null)
        or ("pass_form_settings"."level" = 'user' and "pass_form_settings"."tenant_id" is not null and "pass_form_settings"."user_id" is not null))
);
--> statement-breakpoint
ALTER TABLE "pass_form_settings" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "notifications" ADD COLUMN "read_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "pass_form_settings" ADD CONSTRAINT "pass_form_settings_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pass_form_settings" ADD CONSTRAINT "pass_form_settings_site_id_sites_id_fk" FOREIGN KEY ("site_id") REFERENCES "public"."sites"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pass_form_settings" ADD CONSTRAINT "pass_form_settings_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pass_form_settings" ADD CONSTRAINT "pass_form_settings_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "notifications_user_id_created_at_idx" ON "notifications" USING btree ("user_id","created_at" DESC NULLS LAST);--> statement-breakpoint
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_event_key" UNIQUE("event_id","user_id","kind","channel");--> statement-breakpoint
CREATE POLICY "organization_isolation" ON "pass_form_settings" AS PERMISSIVE FOR ALL TO public USING ("organization_id" = nullif(current_setting('app.organization_id', true), '')::uuid) WITH CHECK ("organization_id" = nullif(current_setting('app.organization_id', true), '')::uuid);--> statement-breakpoint
-- Этап 7b: `updated_at` новой таблицы ставит тот же триггер, что у остальных (миграция 0002).
CREATE TRIGGER "pass_form_settings_set_updated_at" BEFORE UPDATE ON "pass_form_settings" FOR EACH ROW EXECUTE FUNCTION "set_updated_at"();
