CREATE TABLE "gate_actions" (
	"id" uuid PRIMARY KEY NOT NULL,
	"organization_id" uuid NOT NULL,
	"site_id" uuid NOT NULL,
	"gate_id" uuid NOT NULL,
	"type" text NOT NULL,
	"gate_account_id" uuid,
	"device_id" uuid,
	"user_id" uuid,
	"client_at" timestamp with time zone,
	"received_at" timestamp with time zone NOT NULL,
	"offline" boolean DEFAULT false NOT NULL,
	"request_hash" text NOT NULL,
	"outcome" text NOT NULL,
	"pass_id" uuid,
	"visit_id" uuid,
	"decision_id" bigint,
	"undo_of" uuid,
	"response" jsonb NOT NULL,
	CONSTRAINT "gate_actions_type_check" CHECK ("gate_actions"."type" in ('check_in', 'check_out', 'refuse', 'redirect', 'undo', 'passage')),
	CONSTRAINT "gate_actions_outcome_check" CHECK ("gate_actions"."outcome" in ('applied', 'merged', 'rejected'))
);
--> statement-breakpoint
ALTER TABLE "gate_actions" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "gate_decisions" DROP CONSTRAINT "gate_decisions_action_check";--> statement-breakpoint
ALTER TABLE "visits" DROP CONSTRAINT "visits_flags_check";--> statement-breakpoint
ALTER TABLE "organizations" ADD COLUMN "default_timezone" text;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "show_own_time" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "own_timezone" text;--> statement-breakpoint
ALTER TABLE "gate_actions" ADD CONSTRAINT "gate_actions_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "gate_actions" ADD CONSTRAINT "gate_actions_site_id_sites_id_fk" FOREIGN KEY ("site_id") REFERENCES "public"."sites"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "gate_actions" ADD CONSTRAINT "gate_actions_gate_id_gates_id_fk" FOREIGN KEY ("gate_id") REFERENCES "public"."gates"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "gate_actions" ADD CONSTRAINT "gate_actions_gate_account_id_gate_accounts_id_fk" FOREIGN KEY ("gate_account_id") REFERENCES "public"."gate_accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "gate_actions" ADD CONSTRAINT "gate_actions_device_id_gate_devices_id_fk" FOREIGN KEY ("device_id") REFERENCES "public"."gate_devices"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "gate_actions" ADD CONSTRAINT "gate_actions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "gate_actions" ADD CONSTRAINT "gate_actions_pass_id_passes_id_fk" FOREIGN KEY ("pass_id") REFERENCES "public"."passes"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "gate_actions" ADD CONSTRAINT "gate_actions_visit_id_visits_id_fk" FOREIGN KEY ("visit_id") REFERENCES "public"."visits"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "gate_actions" ADD CONSTRAINT "gate_actions_decision_id_gate_decisions_id_fk" FOREIGN KEY ("decision_id") REFERENCES "public"."gate_decisions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "gate_actions" ADD CONSTRAINT "gate_actions_undo_of_gate_actions_id_fk" FOREIGN KEY ("undo_of") REFERENCES "public"."gate_actions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "gate_actions_undo_of_key" ON "gate_actions" USING btree ("undo_of") WHERE "gate_actions"."undo_of" is not null;--> statement-breakpoint
CREATE INDEX "gate_actions_gate_id_received_at_idx" ON "gate_actions" USING btree ("gate_id","received_at" DESC NULLS LAST);--> statement-breakpoint
ALTER TABLE "users" ADD CONSTRAINT "users_own_time_check" CHECK (not "users"."show_own_time" or "users"."own_timezone" is not null);--> statement-breakpoint
ALTER TABLE "gate_decisions" ADD CONSTRAINT "gate_decisions_action_check" CHECK ("gate_decisions"."action" in ('check_in', 'check_out', 'refuse', 'redirect', 'request', 'override_request', 'none', 'undo', 'passage'));--> statement-breakpoint
ALTER TABLE "visits" ADD CONSTRAINT "visits_flags_check" CHECK ("visits"."flags" <@ array['no_checkin', 'after_expiry', 'over_stay', 'offline_over_quota', 'undone', 'pass_cancelled_meanwhile']::text[]);--> statement-breakpoint
CREATE POLICY "organization_isolation" ON "gate_actions" AS PERMISSIVE FOR ALL TO public USING ("organization_id" = nullif(current_setting('app.organization_id', true), '')::uuid) WITH CHECK ("organization_id" = nullif(current_setting('app.organization_id', true), '')::uuid);