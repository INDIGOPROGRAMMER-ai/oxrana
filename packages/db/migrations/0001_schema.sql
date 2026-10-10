-- Этап 2. Сгенерировано `drizzle-kit generate` из src/schema (DATA_MODEL §2), руками не правится:
-- таблицы, check, индексы, внешние ключи, политики RLS. Дополнения — в 0002.

CREATE TABLE "overage_charges" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"site_id" uuid NOT NULL,
	"tenant_id" uuid NOT NULL,
	"quota_id" uuid NOT NULL,
	"visit_id" uuid NOT NULL,
	"day" date NOT NULL,
	"tariff_rub" numeric(10, 2) NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "overage_charges_visit_id_day_key" UNIQUE("visit_id","day")
);
--> statement-breakpoint
ALTER TABLE "overage_charges" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "violations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"site_id" uuid NOT NULL,
	"tenant_id" uuid,
	"visit_id" uuid,
	"kind" text NOT NULL,
	"rule_ref" text,
	"fine_rub" numeric(10, 2),
	"photos" text[],
	"status" text DEFAULT 'draft' NOT NULL,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "violations_status_check" CHECK ("violations"."status" in ('draft', 'signed', 'disputed', 'cancelled'))
);
--> statement-breakpoint
ALTER TABLE "violations" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "blacklist" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"site_id" uuid,
	"plate_norm" text,
	"person_name" text,
	"reason" text NOT NULL,
	"valid_to" timestamp with time zone,
	"created_by" uuid,
	"deleted_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "blacklist_subject_check" CHECK ("blacklist"."plate_norm" is not null or "blacklist"."person_name" is not null)
);
--> statement-breakpoint
ALTER TABLE "blacklist" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "vehicle_categories" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"site_id" uuid,
	"preset_code" text,
	"name" text NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"dock_eligible" boolean DEFAULT false NOT NULL,
	"sort" integer NOT NULL,
	"deleted_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "vehicle_categories_preset_code_check" CHECK ("vehicle_categories"."preset_code" in ('car', 'light_truck', 'semi', 'truck_5t', 'special', 'bus', 'moto', 'trailer', 'minibus'))
);
--> statement-breakpoint
ALTER TABLE "vehicle_categories" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "visit_purposes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"site_id" uuid NOT NULL,
	"name" text NOT NULL,
	"max_stay_minutes" integer,
	"sort" integer,
	"deleted_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "visit_purposes" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "audit_log" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "audit_log_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"organization_id" uuid NOT NULL,
	"site_id" uuid,
	"at" timestamp with time zone DEFAULT now() NOT NULL,
	"actor_type" text NOT NULL,
	"actor_user_id" uuid,
	"actor_gate_account_id" uuid,
	"device_id" uuid,
	"request_id" text,
	"ip" "inet",
	"entity" text NOT NULL,
	"entity_id" uuid NOT NULL,
	"action" text NOT NULL,
	"diff" jsonb,
	"reason" text,
	"snapshot" jsonb,
	CONSTRAINT "audit_log_actor_type_check" CHECK ("audit_log"."actor_type" in ('user', 'gate_account', 'system', 'agent'))
);
--> statement-breakpoint
ALTER TABLE "audit_log" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "domain_events" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "domain_events_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"organization_id" uuid NOT NULL,
	"site_id" uuid,
	"at" timestamp with time zone DEFAULT now() NOT NULL,
	"type" text NOT NULL,
	"aggregate" text NOT NULL,
	"aggregate_id" uuid NOT NULL,
	"payload" jsonb NOT NULL
);
--> statement-breakpoint
ALTER TABLE "domain_events" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "notifications" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"channel" text NOT NULL,
	"payload" jsonb NOT NULL,
	"status" text NOT NULL,
	"sent_at" timestamp with time zone,
	"error" text,
	"event_id" bigint,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "notifications_status_check" CHECK ("notifications"."status" in ('queued', 'sent', 'failed', 'skipped'))
);
--> statement-breakpoint
ALTER TABLE "notifications" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "barrier_commands" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"site_id" uuid NOT NULL,
	"gate_id" uuid NOT NULL,
	"device_id" uuid NOT NULL,
	"type" text NOT NULL,
	"direction" text,
	"issued_at" timestamp with time zone DEFAULT now() NOT NULL,
	"issued_by_user_id" uuid,
	"issued_by_gate_account_id" uuid,
	"device_issued_from" uuid,
	"cause" text NOT NULL,
	"visit_id" uuid,
	"decision_id" bigint,
	"status" text DEFAULT 'queued' NOT NULL,
	"sent_at" timestamp with time zone,
	"finished_at" timestamp with time zone,
	"result" jsonb,
	CONSTRAINT "barrier_commands_type_check" CHECK ("barrier_commands"."type" in ('open', 'close', 'test')),
	CONSTRAINT "barrier_commands_cause_check" CHECK ("barrier_commands"."cause" in ('check_in', 'check_out', 'override', 'manual_test', 'auto_pass')),
	CONSTRAINT "barrier_commands_status_check" CHECK ("barrier_commands"."status" in ('queued', 'sent', 'done', 'failed', 'timeout'))
);
--> statement-breakpoint
ALTER TABLE "barrier_commands" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "hardware_devices" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"site_id" uuid NOT NULL,
	"gate_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"name" text NOT NULL,
	"adapter" text NOT NULL,
	"direction" text,
	"config" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"agent_device_id" uuid,
	"status" text DEFAULT 'unknown' NOT NULL,
	"last_seen_at" timestamp with time zone,
	"deleted_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "hardware_devices_kind_check" CHECK ("hardware_devices"."kind" in ('lpr_camera', 'barrier', 'qr_scanner', 'acs_controller', 'post_pc')),
	CONSTRAINT "hardware_devices_direction_check" CHECK ("hardware_devices"."direction" in ('in', 'out', 'both')),
	CONSTRAINT "hardware_devices_status_check" CHECK ("hardware_devices"."status" in ('online', 'offline', 'unknown'))
);
--> statement-breakpoint
ALTER TABLE "hardware_devices" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "hardware_events" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "hardware_events_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"organization_id" uuid NOT NULL,
	"site_id" uuid NOT NULL,
	"gate_id" uuid NOT NULL,
	"device_id" uuid,
	"type" text NOT NULL,
	"direction" text,
	"at" timestamp with time zone NOT NULL,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL,
	"plate_raw" text,
	"plate_norm" text,
	"confidence" real,
	"payload" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"photo_ref" text,
	"photo_expires_at" timestamp with time zone,
	"agent_seq" bigint,
	"matched_pass_id" uuid,
	"decision_id" bigint,
	CONSTRAINT "hardware_events_device_id_agent_seq_key" UNIQUE("device_id","agent_seq"),
	CONSTRAINT "hardware_events_type_check" CHECK ("hardware_events"."type" in ('plate_recognized', 'qr_scanned', 'barrier_state', 'heartbeat', 'acs_pass'))
);
--> statement-breakpoint
ALTER TABLE "hardware_events" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "docks" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"site_id" uuid NOT NULL,
	"zone_id" uuid,
	"number" text NOT NULL,
	"kind" text DEFAULT 'leveller' NOT NULL,
	"counts_in_quota" boolean DEFAULT true NOT NULL,
	"size" text,
	"deleted_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "docks_site_id_number_key" UNIQUE("site_id","number"),
	CONSTRAINT "docks_kind_check" CHECK ("docks"."kind" in ('leveller', 'ground_gate', 'other'))
);
--> statement-breakpoint
ALTER TABLE "docks" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "gates" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"site_id" uuid NOT NULL,
	"name" text NOT NULL,
	"kind" text NOT NULL,
	"admits" text DEFAULT 'vehicles_and_pedestrians' NOT NULL,
	"zone_id" uuid,
	"direction" text DEFAULT 'both' NOT NULL,
	"working_hours" jsonb,
	"auto_pass_on_allow" boolean DEFAULT false NOT NULL,
	"settings" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"sort" integer DEFAULT 100 NOT NULL,
	"deleted_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "gates_kind_check" CHECK ("gates"."kind" in ('perimeter', 'internal')),
	CONSTRAINT "gates_admits_check" CHECK ("gates"."admits" in ('vehicles_and_pedestrians', 'vehicles', 'pedestrians')),
	CONSTRAINT "gates_direction_check" CHECK ("gates"."direction" in ('in', 'out', 'both'))
);
--> statement-breakpoint
ALTER TABLE "gates" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "organizations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"slug" text NOT NULL,
	"settings" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"deleted_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "organizations_slug_unique" UNIQUE("slug")
);
--> statement-breakpoint
ALTER TABLE "organizations" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "parking_areas" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"site_id" uuid NOT NULL,
	"zone_id" uuid,
	"name" text NOT NULL,
	"spaces" integer,
	"deleted_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "parking_areas" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "sites" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"name" text NOT NULL,
	"address" text,
	"geo" "point",
	"timezone" text NOT NULL,
	"working_hours" jsonb,
	"settings" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"deleted_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "sites" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "zones" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"site_id" uuid NOT NULL,
	"name" text NOT NULL,
	"kind" text NOT NULL,
	"deleted_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "zones_kind_check" CHECK ("zones"."kind" in ('building', 'yard', 'parking', 'dock_area', 'office', 'other'))
);
--> statement-breakpoint
ALTER TABLE "zones" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "pass_batches" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"site_id" uuid NOT NULL,
	"tenant_id" uuid NOT NULL,
	"created_by" uuid NOT NULL,
	"total" integer NOT NULL,
	"created" integer NOT NULL,
	"errors" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "pass_batches" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "pass_change_requests" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"pass_id" uuid NOT NULL,
	"changes" jsonb NOT NULL,
	"reason" text,
	"status" text NOT NULL,
	"requested_by" uuid NOT NULL,
	"decided_by" uuid,
	"decided_at" timestamp with time zone,
	"decision_note" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "pass_change_requests_status_check" CHECK ("pass_change_requests"."status" in ('pending', 'approved', 'rejected', 'cancelled'))
);
--> statement-breakpoint
ALTER TABLE "pass_change_requests" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "pass_tokens" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"pass_id" uuid NOT NULL,
	"token_hash" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"revoked_at" timestamp with time zone,
	"consent_at" timestamp with time zone,
	"last_opened_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "pass_tokens_token_hash_unique" UNIQUE("token_hash")
);
--> statement-breakpoint
ALTER TABLE "pass_tokens" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "passes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"site_id" uuid NOT NULL,
	"tenant_id" uuid NOT NULL,
	"pass_type" text NOT NULL,
	"participant" text NOT NULL,
	"plate_raw" text,
	"plate_norm" text,
	"plate_country" text,
	"category_id" uuid,
	"brand" text,
	"person_name" text,
	"person_document" text,
	"driver_name" text,
	"driver_phone" text,
	"purpose_id" uuid,
	"destination_zone_id" uuid,
	"dock_id" uuid,
	"valid_from" timestamp with time zone,
	"valid_to" timestamp with time zone,
	"window_from" timestamp with time zone,
	"window_to" timestamp with time zone,
	"status" text NOT NULL,
	"comment" text,
	"created_by" uuid,
	"created_via" text NOT NULL,
	"created_by_gate_account_id" uuid,
	"batch_id" uuid,
	"approved_by" uuid,
	"approved_at" timestamp with time zone,
	"approval_note" text,
	"approval_changes" jsonb,
	"cancelled_reason" text,
	"closed_at" timestamp with time zone,
	"source_ref" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "passes_pass_type_check" CHECK ("passes"."pass_type" in ('single', 'multi', 'permanent')),
	CONSTRAINT "passes_participant_check" CHECK ("passes"."participant" in ('vehicle', 'pedestrian')),
	CONSTRAINT "passes_status_check" CHECK ("passes"."status" in ('draft', 'pending_approval', 'approved', 'rejected', 'cancelled', 'expired', 'used')),
	CONSTRAINT "passes_created_via_check" CHECK ("passes"."created_via" in ('web', 'pwa', 'bot', 'api', 'gate', 'import'))
);
--> statement-breakpoint
ALTER TABLE "passes" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "device_enrollments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"gate_account_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"code_hash" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"used_at" timestamp with time zone,
	"used_device_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "device_enrollments_code_hash_unique" UNIQUE("code_hash"),
	CONSTRAINT "device_enrollments_kind_check" CHECK ("device_enrollments"."kind" in ('post', 'agent'))
);
--> statement-breakpoint
ALTER TABLE "device_enrollments" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "gate_accounts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"site_id" uuid NOT NULL,
	"gate_id" uuid NOT NULL,
	"role_id" uuid NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "gate_accounts_gate_id_unique" UNIQUE("gate_id"),
	CONSTRAINT "gate_accounts_status_check" CHECK ("gate_accounts"."status" in ('active', 'disabled'))
);
--> statement-breakpoint
ALTER TABLE "gate_accounts" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "gate_devices" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"gate_account_id" uuid NOT NULL,
	"name" text NOT NULL,
	"kind" text DEFAULT 'post' NOT NULL,
	"token_hash" text NOT NULL,
	"enrolled_by" uuid,
	"enrolled_at" timestamp with time zone NOT NULL,
	"last_seen_at" timestamp with time zone,
	"last_ip" "inet",
	"app_version" text,
	"revoked_at" timestamp with time zone,
	"revoked_by" uuid,
	"revoke_reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "gate_devices_token_hash_unique" UNIQUE("token_hash"),
	CONSTRAINT "gate_devices_kind_check" CHECK ("gate_devices"."kind" in ('post', 'agent'))
);
--> statement-breakpoint
ALTER TABLE "gate_devices" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "invitations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"email" "citext",
	"phone" text,
	"full_name" text,
	"role_id" uuid NOT NULL,
	"site_id" uuid,
	"tenant_id" uuid,
	"token_hash" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"invited_by" uuid NOT NULL,
	"accepted_at" timestamp with time zone,
	"accepted_user_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "invitations_token_hash_unique" UNIQUE("token_hash")
);
--> statement-breakpoint
ALTER TABLE "invitations" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "login_codes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"code_hash" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"used_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "notification_preferences" (
	"user_id" uuid NOT NULL,
	"tenant_id" uuid,
	"kind" text NOT NULL,
	"channel" text NOT NULL,
	"enabled" boolean NOT NULL,
	CONSTRAINT "notification_preferences_key" UNIQUE NULLS NOT DISTINCT("user_id","tenant_id","kind","channel"),
	CONSTRAINT "notification_preferences_channel_check" CHECK ("notification_preferences"."channel" in ('email', 'push', 'telegram'))
);
--> statement-breakpoint
CREATE TABLE "push_subscriptions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"endpoint" text NOT NULL,
	"keys" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"failed_at" timestamp with time zone,
	CONSTRAINT "push_subscriptions_endpoint_unique" UNIQUE("endpoint")
);
--> statement-breakpoint
CREATE TABLE "role_assignments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"role_id" uuid NOT NULL,
	"site_id" uuid,
	"tenant_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "role_assignments_scope_key" UNIQUE NULLS NOT DISTINCT("user_id","role_id","site_id","tenant_id")
);
--> statement-breakpoint
ALTER TABLE "role_assignments" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "roles" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"name" text NOT NULL,
	"permissions" text[] DEFAULT '{}'::text[] NOT NULL,
	"is_template" boolean DEFAULT false NOT NULL,
	"deleted_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "roles" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "sessions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"token_hash" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_seen_at" timestamp with time zone,
	"expires_at" timestamp with time zone NOT NULL,
	"ip" "inet",
	"user_agent" text,
	"revoked_at" timestamp with time zone,
	CONSTRAINT "sessions_token_hash_unique" UNIQUE("token_hash")
);
--> statement-breakpoint
CREATE TABLE "shift_marks" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"gate_account_id" uuid NOT NULL,
	"device_id" uuid,
	"guard_name" text NOT NULL,
	"started_at" timestamp with time zone NOT NULL,
	"ended_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "shift_marks" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "telegram_links" (
	"user_id" uuid PRIMARY KEY NOT NULL,
	"chat_id" bigint NOT NULL,
	"linked_at" timestamp with time zone,
	CONSTRAINT "telegram_links_chat_id_unique" UNIQUE("chat_id")
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"full_name" text NOT NULL,
	"email" "citext",
	"phone" text,
	"password_hash" text,
	"status" text DEFAULT 'invited' NOT NULL,
	"locale" text DEFAULT 'ru' NOT NULL,
	"last_login_at" timestamp with time zone,
	"must_change_password" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "users_email_unique" UNIQUE("email"),
	CONSTRAINT "users_phone_unique" UNIQUE("phone"),
	CONSTRAINT "users_contact_check" CHECK ("users"."email" is not null or "users"."phone" is not null),
	CONSTRAINT "users_status_check" CHECK ("users"."status" in ('invited', 'active', 'disabled'))
);
--> statement-breakpoint
CREATE TABLE "approval_policies" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"site_id" uuid NOT NULL,
	"tenant_id" uuid,
	"creator_kind" text NOT NULL,
	"pass_type" text NOT NULL,
	"mode" text NOT NULL,
	"comment_required" boolean DEFAULT false NOT NULL,
	"escalation_hours" integer,
	"on_timeout" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "approval_policies_scope_key" UNIQUE NULLS NOT DISTINCT("site_id","tenant_id","creator_kind","pass_type"),
	CONSTRAINT "approval_policies_creator_kind_check" CHECK ("approval_policies"."creator_kind" in ('tenant', 'gate', 'admin')),
	CONSTRAINT "approval_policies_pass_type_check" CHECK ("approval_policies"."pass_type" in ('single', 'multi', 'permanent')),
	CONSTRAINT "approval_policies_mode_check" CHECK ("approval_policies"."mode" in ('allow', 'on_request', 'deny')),
	CONSTRAINT "approval_policies_on_timeout_check" CHECK ("approval_policies"."on_timeout" in ('reject', 'escalate'))
);
--> statement-breakpoint
ALTER TABLE "approval_policies" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "exceptions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"site_id" uuid NOT NULL,
	"tenant_id" uuid,
	"name" text NOT NULL,
	"match" jsonb NOT NULL,
	"waives" text[] NOT NULL,
	"guard_text" text,
	"basis" text,
	"basis_clause_id" uuid,
	"valid_from" timestamp with time zone DEFAULT now() NOT NULL,
	"valid_to" timestamp with time zone,
	"created_by" uuid,
	"deleted_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "exceptions_waives_check" CHECK ("exceptions"."waives" <@ array['inspection', 'quota', 'time_window', 'working_hours', 'routing']::text[])
);
--> statement-breakpoint
ALTER TABLE "exceptions" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "quota_categories" (
	"quota_id" uuid NOT NULL,
	"category_id" uuid NOT NULL,
	CONSTRAINT "quota_categories_quota_id_category_id_pk" PRIMARY KEY("quota_id","category_id")
);
--> statement-breakpoint
ALTER TABLE "quota_categories" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "quotas" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"site_id" uuid NOT NULL,
	"tenant_id" uuid NOT NULL,
	"participant" text DEFAULT 'vehicle' NOT NULL,
	"name" text NOT NULL,
	"capacity" integer NOT NULL,
	"capacity_from_docks" boolean DEFAULT false NOT NULL,
	"counting" text DEFAULT 'on_site' NOT NULL,
	"enforcement" text DEFAULT 'hard' NOT NULL,
	"overage_tariff_rub" numeric(10, 2),
	"overage_cap" integer,
	"schedule" jsonb,
	"basis_clause_id" uuid,
	"valid_from" timestamp with time zone DEFAULT now() NOT NULL,
	"valid_to" timestamp with time zone,
	"deleted_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "quotas_capacity_check" CHECK ("quotas"."capacity" >= 0),
	CONSTRAINT "quotas_participant_check" CHECK ("quotas"."participant" in ('vehicle', 'pedestrian')),
	CONSTRAINT "quotas_counting_check" CHECK ("quotas"."counting" in ('on_site', 'active_passes', 'per_day')),
	CONSTRAINT "quotas_enforcement_check" CHECK ("quotas"."enforcement" in ('hard', 'soft', 'warn'))
);
--> statement-breakpoint
ALTER TABLE "quotas" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "routing_rules" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"site_id" uuid NOT NULL,
	"tenant_id" uuid,
	"participant" text NOT NULL,
	"category_id" uuid,
	"destination_zone_id" uuid,
	"gate_id" uuid NOT NULL,
	"direction" text DEFAULT 'in' NOT NULL,
	"priority" integer DEFAULT 100 NOT NULL,
	"deleted_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "routing_rules_participant_check" CHECK ("routing_rules"."participant" in ('vehicle', 'pedestrian')),
	CONSTRAINT "routing_rules_direction_check" CHECK ("routing_rules"."direction" in ('in', 'out', 'both'))
);
--> statement-breakpoint
ALTER TABLE "routing_rules" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "time_window_policies" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"site_id" uuid NOT NULL,
	"tenant_id" uuid,
	"window_required" boolean DEFAULT false NOT NULL,
	"early_tolerance_min" integer DEFAULT 0 NOT NULL,
	"late_tolerance_min" integer,
	"on_violation" text DEFAULT 'hard' NOT NULL,
	"deleted_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "time_window_policies_on_violation_check" CHECK ("time_window_policies"."on_violation" in ('hard', 'warn'))
);
--> statement-breakpoint
ALTER TABLE "time_window_policies" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "time_window_policy_categories" (
	"policy_id" uuid NOT NULL,
	"category_id" uuid NOT NULL,
	CONSTRAINT "time_window_policy_categories_policy_id_category_id_pk" PRIMARY KEY("policy_id","category_id")
);
--> statement-breakpoint
ALTER TABLE "time_window_policy_categories" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "contract_clauses" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"contract_id" uuid NOT NULL,
	"ref" text NOT NULL,
	"summary" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "contract_clauses" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "contracts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"tenant_id" uuid NOT NULL,
	"number" text,
	"signed_on" date,
	"valid_from" date,
	"valid_to" date,
	"status" text DEFAULT 'active' NOT NULL,
	"file_ref" text,
	"notes" text,
	"deleted_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "contracts_status_check" CHECK ("contracts"."status" in ('draft', 'active', 'expired', 'terminated'))
);
--> statement-breakpoint
ALTER TABLE "contracts" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "fleet_vehicles" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"tenant_id" uuid NOT NULL,
	"plate_raw" text NOT NULL,
	"plate_norm" text NOT NULL,
	"plate_country" text NOT NULL,
	"category_id" uuid NOT NULL,
	"brand" text,
	"driver_name" text,
	"driver_phone" text,
	"deleted_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "fleet_vehicles" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "pedestrian_rules" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"site_id" uuid NOT NULL,
	"tenant_id" uuid NOT NULL,
	"zone_id" uuid,
	"document_required" boolean DEFAULT true NOT NULL,
	"escort" text NOT NULL,
	"escort_phone" text,
	"guard_text" text,
	"deleted_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "pedestrian_rules_escort_check" CHECK ("pedestrian_rules"."escort" in ('none', 'if_no_document', 'always'))
);
--> statement-breakpoint
ALTER TABLE "pedestrian_rules" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "tenant_dock_assignments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"tenant_id" uuid NOT NULL,
	"dock_id" uuid NOT NULL,
	"valid_from" date NOT NULL,
	"valid_to" date,
	"basis_clause_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "tenant_dock_assignments" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "tenant_parking_assignments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"tenant_id" uuid NOT NULL,
	"parking_area_id" uuid NOT NULL,
	"spaces" integer NOT NULL,
	"valid_from" date NOT NULL,
	"valid_to" date,
	"basis_clause_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "tenant_parking_assignments" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "tenants" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"site_id" uuid NOT NULL,
	"legal_name" text NOT NULL,
	"short_name" text NOT NULL,
	"inn" text,
	"is_operator" boolean DEFAULT false NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"trucks_dock_required" boolean DEFAULT false NOT NULL,
	"default_category_id" uuid,
	"responsible_phone" text,
	"emergency_phone" text,
	"color" text,
	"deleted_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "tenants_status_check" CHECK ("tenants"."status" in ('active', 'blocked_new_passes', 'blocked_entry', 'archived'))
);
--> statement-breakpoint
ALTER TABLE "tenants" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "gate_decisions" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "gate_decisions_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"organization_id" uuid NOT NULL,
	"site_id" uuid NOT NULL,
	"gate_id" uuid NOT NULL,
	"at" timestamp with time zone DEFAULT now() NOT NULL,
	"client_at" timestamp with time zone,
	"direction" text NOT NULL,
	"pass_id" uuid,
	"plate_query" text,
	"hardware_event_id" bigint,
	"verdict" text NOT NULL,
	"reasons" jsonb NOT NULL,
	"trace" jsonb NOT NULL,
	"engine_version" text NOT NULL,
	"action" text,
	"visit_id" uuid,
	"override_id" uuid,
	"gate_account_id" uuid,
	"device_id" uuid,
	"user_id" uuid,
	"offline" boolean DEFAULT false NOT NULL,
	"snapshot" jsonb NOT NULL,
	CONSTRAINT "gate_decisions_direction_check" CHECK ("gate_decisions"."direction" in ('in', 'out')),
	CONSTRAINT "gate_decisions_verdict_check" CHECK ("gate_decisions"."verdict" in ('allow', 'allow_overage', 'wait', 'wrong_gate', 'deny', 'no_pass')),
	CONSTRAINT "gate_decisions_action_check" CHECK ("gate_decisions"."action" in ('check_in', 'check_out', 'refuse', 'redirect', 'request', 'override_request', 'none', 'undo'))
);
--> statement-breakpoint
ALTER TABLE "gate_decisions" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "gate_passages" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "gate_passages_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"organization_id" uuid NOT NULL,
	"site_id" uuid NOT NULL,
	"gate_id" uuid NOT NULL,
	"at" timestamp with time zone NOT NULL,
	"pass_id" uuid,
	"direction" text,
	"decision_id" bigint,
	"gate_account_id" uuid,
	"device_id" uuid,
	"snapshot" jsonb NOT NULL,
	CONSTRAINT "gate_passages_direction_check" CHECK ("gate_passages"."direction" in ('in', 'out'))
);
--> statement-breakpoint
ALTER TABLE "gate_passages" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "gate_queue" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"site_id" uuid NOT NULL,
	"tenant_id" uuid NOT NULL,
	"gate_id" uuid NOT NULL,
	"pass_id" uuid NOT NULL,
	"quota_id" uuid NOT NULL,
	"queued_at" timestamp with time zone NOT NULL,
	"notified_at" timestamp with time zone,
	"left_at" timestamp with time zone,
	"left_reason" text,
	CONSTRAINT "gate_queue_left_reason_check" CHECK ("gate_queue"."left_reason" in ('entered', 'cancelled', 'timeout', 'redirected'))
);
--> statement-breakpoint
ALTER TABLE "gate_queue" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "gate_requests" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"site_id" uuid NOT NULL,
	"gate_id" uuid NOT NULL,
	"tenant_id" uuid,
	"participant" text NOT NULL,
	"plate_raw" text,
	"plate_norm" text,
	"category_id" uuid,
	"person_name" text,
	"status" text NOT NULL,
	"created_by_gate_account_id" uuid,
	"device_id" uuid,
	"answered_by" uuid,
	"answered_at" timestamp with time zone,
	"answer_note" text,
	"pass_id" uuid,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "gate_requests_participant_check" CHECK ("gate_requests"."participant" in ('vehicle', 'pedestrian')),
	CONSTRAINT "gate_requests_status_check" CHECK ("gate_requests"."status" in ('open', 'approved', 'rejected', 'timeout', 'cancelled'))
);
--> statement-breakpoint
ALTER TABLE "gate_requests" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "override_requests" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"site_id" uuid NOT NULL,
	"gate_id" uuid NOT NULL,
	"pass_id" uuid,
	"plate_norm" text,
	"direction" text NOT NULL,
	"verdict_code" text NOT NULL,
	"reasons" jsonb NOT NULL,
	"reason" text NOT NULL,
	"status" text NOT NULL,
	"requested_by_gate_account_id" uuid NOT NULL,
	"device_id" uuid,
	"decided_by" uuid,
	"decided_at" timestamp with time zone,
	"decision_note" text,
	"via" text,
	"valid_until" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "override_requests_direction_check" CHECK ("override_requests"."direction" in ('in', 'out')),
	CONSTRAINT "override_requests_verdict_code_check" CHECK ("override_requests"."verdict_code" in ('allow', 'allow_overage', 'wait', 'wrong_gate', 'deny', 'no_pass')),
	CONSTRAINT "override_requests_status_check" CHECK ("override_requests"."status" in ('pending', 'approved', 'rejected', 'expired', 'used')),
	CONSTRAINT "override_requests_via_check" CHECK ("override_requests"."via" in ('admin', 'senior_pin'))
);
--> statement-breakpoint
ALTER TABLE "override_requests" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "visits" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"site_id" uuid NOT NULL,
	"tenant_id" uuid NOT NULL,
	"pass_id" uuid,
	"participant" text NOT NULL,
	"category_id" uuid,
	"plate_norm" text,
	"snapshot" jsonb NOT NULL,
	"gate_in_id" uuid,
	"time_in" timestamp with time zone,
	"gate_account_in_id" uuid,
	"device_in_id" uuid,
	"gate_out_id" uuid,
	"time_out" timestamp with time zone,
	"gate_account_out_id" uuid,
	"device_out_id" uuid,
	"method_in" text,
	"method_out" text,
	"hardware_event_in_id" bigint,
	"hardware_event_out_id" bigint,
	"decision_in_id" bigint,
	"decision_out_id" bigint,
	"overage" boolean DEFAULT false NOT NULL,
	"overage_quota_id" uuid,
	"exception_id" uuid,
	"override_id" uuid,
	"flags" text[] DEFAULT '{}'::text[] NOT NULL,
	"client_time_in" timestamp with time zone,
	"client_time_out" timestamp with time zone,
	CONSTRAINT "visits_participant_check" CHECK ("visits"."participant" in ('vehicle', 'pedestrian')),
	CONSTRAINT "visits_method_in_check" CHECK ("visits"."method_in" in ('button', 'qr', 'lpr', 'auto', 'sync')),
	CONSTRAINT "visits_method_out_check" CHECK ("visits"."method_out" in ('button', 'qr', 'lpr', 'auto', 'sync')),
	CONSTRAINT "visits_flags_check" CHECK ("visits"."flags" <@ array['no_checkin', 'after_expiry', 'over_stay', 'offline_over_quota', 'undone']::text[])
);
--> statement-breakpoint
ALTER TABLE "visits" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "overage_charges" ADD CONSTRAINT "overage_charges_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "overage_charges" ADD CONSTRAINT "overage_charges_site_id_sites_id_fk" FOREIGN KEY ("site_id") REFERENCES "public"."sites"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "overage_charges" ADD CONSTRAINT "overage_charges_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "overage_charges" ADD CONSTRAINT "overage_charges_quota_id_quotas_id_fk" FOREIGN KEY ("quota_id") REFERENCES "public"."quotas"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "overage_charges" ADD CONSTRAINT "overage_charges_visit_id_visits_id_fk" FOREIGN KEY ("visit_id") REFERENCES "public"."visits"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "violations" ADD CONSTRAINT "violations_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "violations" ADD CONSTRAINT "violations_site_id_sites_id_fk" FOREIGN KEY ("site_id") REFERENCES "public"."sites"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "violations" ADD CONSTRAINT "violations_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "violations" ADD CONSTRAINT "violations_visit_id_visits_id_fk" FOREIGN KEY ("visit_id") REFERENCES "public"."visits"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "blacklist" ADD CONSTRAINT "blacklist_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "blacklist" ADD CONSTRAINT "blacklist_site_id_sites_id_fk" FOREIGN KEY ("site_id") REFERENCES "public"."sites"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "blacklist" ADD CONSTRAINT "blacklist_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "vehicle_categories" ADD CONSTRAINT "vehicle_categories_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "vehicle_categories" ADD CONSTRAINT "vehicle_categories_site_id_sites_id_fk" FOREIGN KEY ("site_id") REFERENCES "public"."sites"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "visit_purposes" ADD CONSTRAINT "visit_purposes_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "visit_purposes" ADD CONSTRAINT "visit_purposes_site_id_sites_id_fk" FOREIGN KEY ("site_id") REFERENCES "public"."sites"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "audit_log" ADD CONSTRAINT "audit_log_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "domain_events" ADD CONSTRAINT "domain_events_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_event_id_domain_events_id_fk" FOREIGN KEY ("event_id") REFERENCES "public"."domain_events"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "barrier_commands" ADD CONSTRAINT "barrier_commands_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "barrier_commands" ADD CONSTRAINT "barrier_commands_site_id_sites_id_fk" FOREIGN KEY ("site_id") REFERENCES "public"."sites"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "barrier_commands" ADD CONSTRAINT "barrier_commands_gate_id_gates_id_fk" FOREIGN KEY ("gate_id") REFERENCES "public"."gates"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "barrier_commands" ADD CONSTRAINT "barrier_commands_device_id_hardware_devices_id_fk" FOREIGN KEY ("device_id") REFERENCES "public"."hardware_devices"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "barrier_commands" ADD CONSTRAINT "barrier_commands_issued_by_user_id_users_id_fk" FOREIGN KEY ("issued_by_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "barrier_commands" ADD CONSTRAINT "barrier_commands_issued_by_gate_account_id_gate_accounts_id_fk" FOREIGN KEY ("issued_by_gate_account_id") REFERENCES "public"."gate_accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "barrier_commands" ADD CONSTRAINT "barrier_commands_device_issued_from_gate_devices_id_fk" FOREIGN KEY ("device_issued_from") REFERENCES "public"."gate_devices"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "barrier_commands" ADD CONSTRAINT "barrier_commands_visit_id_visits_id_fk" FOREIGN KEY ("visit_id") REFERENCES "public"."visits"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "barrier_commands" ADD CONSTRAINT "barrier_commands_decision_id_gate_decisions_id_fk" FOREIGN KEY ("decision_id") REFERENCES "public"."gate_decisions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hardware_devices" ADD CONSTRAINT "hardware_devices_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hardware_devices" ADD CONSTRAINT "hardware_devices_site_id_sites_id_fk" FOREIGN KEY ("site_id") REFERENCES "public"."sites"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hardware_devices" ADD CONSTRAINT "hardware_devices_gate_id_gates_id_fk" FOREIGN KEY ("gate_id") REFERENCES "public"."gates"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hardware_devices" ADD CONSTRAINT "hardware_devices_agent_device_id_gate_devices_id_fk" FOREIGN KEY ("agent_device_id") REFERENCES "public"."gate_devices"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hardware_events" ADD CONSTRAINT "hardware_events_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hardware_events" ADD CONSTRAINT "hardware_events_site_id_sites_id_fk" FOREIGN KEY ("site_id") REFERENCES "public"."sites"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hardware_events" ADD CONSTRAINT "hardware_events_gate_id_gates_id_fk" FOREIGN KEY ("gate_id") REFERENCES "public"."gates"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hardware_events" ADD CONSTRAINT "hardware_events_device_id_hardware_devices_id_fk" FOREIGN KEY ("device_id") REFERENCES "public"."hardware_devices"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hardware_events" ADD CONSTRAINT "hardware_events_matched_pass_id_passes_id_fk" FOREIGN KEY ("matched_pass_id") REFERENCES "public"."passes"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hardware_events" ADD CONSTRAINT "hardware_events_decision_id_gate_decisions_id_fk" FOREIGN KEY ("decision_id") REFERENCES "public"."gate_decisions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "docks" ADD CONSTRAINT "docks_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "docks" ADD CONSTRAINT "docks_site_id_sites_id_fk" FOREIGN KEY ("site_id") REFERENCES "public"."sites"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "docks" ADD CONSTRAINT "docks_zone_id_zones_id_fk" FOREIGN KEY ("zone_id") REFERENCES "public"."zones"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "gates" ADD CONSTRAINT "gates_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "gates" ADD CONSTRAINT "gates_site_id_sites_id_fk" FOREIGN KEY ("site_id") REFERENCES "public"."sites"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "gates" ADD CONSTRAINT "gates_zone_id_zones_id_fk" FOREIGN KEY ("zone_id") REFERENCES "public"."zones"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "parking_areas" ADD CONSTRAINT "parking_areas_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "parking_areas" ADD CONSTRAINT "parking_areas_site_id_sites_id_fk" FOREIGN KEY ("site_id") REFERENCES "public"."sites"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "parking_areas" ADD CONSTRAINT "parking_areas_zone_id_zones_id_fk" FOREIGN KEY ("zone_id") REFERENCES "public"."zones"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sites" ADD CONSTRAINT "sites_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "zones" ADD CONSTRAINT "zones_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "zones" ADD CONSTRAINT "zones_site_id_sites_id_fk" FOREIGN KEY ("site_id") REFERENCES "public"."sites"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pass_batches" ADD CONSTRAINT "pass_batches_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pass_batches" ADD CONSTRAINT "pass_batches_site_id_sites_id_fk" FOREIGN KEY ("site_id") REFERENCES "public"."sites"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pass_batches" ADD CONSTRAINT "pass_batches_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pass_change_requests" ADD CONSTRAINT "pass_change_requests_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pass_change_requests" ADD CONSTRAINT "pass_change_requests_pass_id_passes_id_fk" FOREIGN KEY ("pass_id") REFERENCES "public"."passes"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pass_tokens" ADD CONSTRAINT "pass_tokens_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pass_tokens" ADD CONSTRAINT "pass_tokens_pass_id_passes_id_fk" FOREIGN KEY ("pass_id") REFERENCES "public"."passes"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "passes" ADD CONSTRAINT "passes_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "passes" ADD CONSTRAINT "passes_site_id_sites_id_fk" FOREIGN KEY ("site_id") REFERENCES "public"."sites"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "passes" ADD CONSTRAINT "passes_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "passes" ADD CONSTRAINT "passes_category_id_vehicle_categories_id_fk" FOREIGN KEY ("category_id") REFERENCES "public"."vehicle_categories"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "passes" ADD CONSTRAINT "passes_purpose_id_visit_purposes_id_fk" FOREIGN KEY ("purpose_id") REFERENCES "public"."visit_purposes"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "passes" ADD CONSTRAINT "passes_destination_zone_id_zones_id_fk" FOREIGN KEY ("destination_zone_id") REFERENCES "public"."zones"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "passes" ADD CONSTRAINT "passes_dock_id_docks_id_fk" FOREIGN KEY ("dock_id") REFERENCES "public"."docks"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "passes" ADD CONSTRAINT "passes_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "passes" ADD CONSTRAINT "passes_created_by_gate_account_id_gate_accounts_id_fk" FOREIGN KEY ("created_by_gate_account_id") REFERENCES "public"."gate_accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "passes" ADD CONSTRAINT "passes_batch_id_pass_batches_id_fk" FOREIGN KEY ("batch_id") REFERENCES "public"."pass_batches"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "device_enrollments" ADD CONSTRAINT "device_enrollments_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "device_enrollments" ADD CONSTRAINT "device_enrollments_gate_account_id_gate_accounts_id_fk" FOREIGN KEY ("gate_account_id") REFERENCES "public"."gate_accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "device_enrollments" ADD CONSTRAINT "device_enrollments_used_device_id_gate_devices_id_fk" FOREIGN KEY ("used_device_id") REFERENCES "public"."gate_devices"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "gate_accounts" ADD CONSTRAINT "gate_accounts_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "gate_accounts" ADD CONSTRAINT "gate_accounts_site_id_sites_id_fk" FOREIGN KEY ("site_id") REFERENCES "public"."sites"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "gate_accounts" ADD CONSTRAINT "gate_accounts_gate_id_gates_id_fk" FOREIGN KEY ("gate_id") REFERENCES "public"."gates"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "gate_accounts" ADD CONSTRAINT "gate_accounts_role_id_roles_id_fk" FOREIGN KEY ("role_id") REFERENCES "public"."roles"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "gate_devices" ADD CONSTRAINT "gate_devices_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "gate_devices" ADD CONSTRAINT "gate_devices_gate_account_id_gate_accounts_id_fk" FOREIGN KEY ("gate_account_id") REFERENCES "public"."gate_accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "gate_devices" ADD CONSTRAINT "gate_devices_enrolled_by_users_id_fk" FOREIGN KEY ("enrolled_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invitations" ADD CONSTRAINT "invitations_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invitations" ADD CONSTRAINT "invitations_role_id_roles_id_fk" FOREIGN KEY ("role_id") REFERENCES "public"."roles"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invitations" ADD CONSTRAINT "invitations_site_id_sites_id_fk" FOREIGN KEY ("site_id") REFERENCES "public"."sites"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invitations" ADD CONSTRAINT "invitations_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invitations" ADD CONSTRAINT "invitations_accepted_user_id_users_id_fk" FOREIGN KEY ("accepted_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "login_codes" ADD CONSTRAINT "login_codes_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notification_preferences" ADD CONSTRAINT "notification_preferences_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notification_preferences" ADD CONSTRAINT "notification_preferences_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "push_subscriptions" ADD CONSTRAINT "push_subscriptions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "role_assignments" ADD CONSTRAINT "role_assignments_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "role_assignments" ADD CONSTRAINT "role_assignments_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "role_assignments" ADD CONSTRAINT "role_assignments_role_id_roles_id_fk" FOREIGN KEY ("role_id") REFERENCES "public"."roles"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "role_assignments" ADD CONSTRAINT "role_assignments_site_id_sites_id_fk" FOREIGN KEY ("site_id") REFERENCES "public"."sites"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "role_assignments" ADD CONSTRAINT "role_assignments_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "roles" ADD CONSTRAINT "roles_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shift_marks" ADD CONSTRAINT "shift_marks_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shift_marks" ADD CONSTRAINT "shift_marks_gate_account_id_gate_accounts_id_fk" FOREIGN KEY ("gate_account_id") REFERENCES "public"."gate_accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shift_marks" ADD CONSTRAINT "shift_marks_device_id_gate_devices_id_fk" FOREIGN KEY ("device_id") REFERENCES "public"."gate_devices"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "telegram_links" ADD CONSTRAINT "telegram_links_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "approval_policies" ADD CONSTRAINT "approval_policies_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "approval_policies" ADD CONSTRAINT "approval_policies_site_id_sites_id_fk" FOREIGN KEY ("site_id") REFERENCES "public"."sites"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "approval_policies" ADD CONSTRAINT "approval_policies_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "exceptions" ADD CONSTRAINT "exceptions_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "exceptions" ADD CONSTRAINT "exceptions_site_id_sites_id_fk" FOREIGN KEY ("site_id") REFERENCES "public"."sites"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "exceptions" ADD CONSTRAINT "exceptions_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "exceptions" ADD CONSTRAINT "exceptions_basis_clause_id_contract_clauses_id_fk" FOREIGN KEY ("basis_clause_id") REFERENCES "public"."contract_clauses"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "exceptions" ADD CONSTRAINT "exceptions_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "quota_categories" ADD CONSTRAINT "quota_categories_quota_id_quotas_id_fk" FOREIGN KEY ("quota_id") REFERENCES "public"."quotas"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "quota_categories" ADD CONSTRAINT "quota_categories_category_id_vehicle_categories_id_fk" FOREIGN KEY ("category_id") REFERENCES "public"."vehicle_categories"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "quotas" ADD CONSTRAINT "quotas_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "quotas" ADD CONSTRAINT "quotas_site_id_sites_id_fk" FOREIGN KEY ("site_id") REFERENCES "public"."sites"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "quotas" ADD CONSTRAINT "quotas_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "quotas" ADD CONSTRAINT "quotas_basis_clause_id_contract_clauses_id_fk" FOREIGN KEY ("basis_clause_id") REFERENCES "public"."contract_clauses"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "routing_rules" ADD CONSTRAINT "routing_rules_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "routing_rules" ADD CONSTRAINT "routing_rules_site_id_sites_id_fk" FOREIGN KEY ("site_id") REFERENCES "public"."sites"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "routing_rules" ADD CONSTRAINT "routing_rules_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "routing_rules" ADD CONSTRAINT "routing_rules_category_id_vehicle_categories_id_fk" FOREIGN KEY ("category_id") REFERENCES "public"."vehicle_categories"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "routing_rules" ADD CONSTRAINT "routing_rules_destination_zone_id_zones_id_fk" FOREIGN KEY ("destination_zone_id") REFERENCES "public"."zones"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "routing_rules" ADD CONSTRAINT "routing_rules_gate_id_gates_id_fk" FOREIGN KEY ("gate_id") REFERENCES "public"."gates"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "time_window_policies" ADD CONSTRAINT "time_window_policies_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "time_window_policies" ADD CONSTRAINT "time_window_policies_site_id_sites_id_fk" FOREIGN KEY ("site_id") REFERENCES "public"."sites"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "time_window_policies" ADD CONSTRAINT "time_window_policies_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "time_window_policy_categories" ADD CONSTRAINT "time_window_policy_categories_policy_id_fk" FOREIGN KEY ("policy_id") REFERENCES "public"."time_window_policies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "time_window_policy_categories" ADD CONSTRAINT "time_window_policy_categories_category_id_fk" FOREIGN KEY ("category_id") REFERENCES "public"."vehicle_categories"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "contract_clauses" ADD CONSTRAINT "contract_clauses_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "contract_clauses" ADD CONSTRAINT "contract_clauses_contract_id_contracts_id_fk" FOREIGN KEY ("contract_id") REFERENCES "public"."contracts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "contracts" ADD CONSTRAINT "contracts_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "contracts" ADD CONSTRAINT "contracts_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fleet_vehicles" ADD CONSTRAINT "fleet_vehicles_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fleet_vehicles" ADD CONSTRAINT "fleet_vehicles_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fleet_vehicles" ADD CONSTRAINT "fleet_vehicles_category_id_vehicle_categories_id_fk" FOREIGN KEY ("category_id") REFERENCES "public"."vehicle_categories"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pedestrian_rules" ADD CONSTRAINT "pedestrian_rules_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pedestrian_rules" ADD CONSTRAINT "pedestrian_rules_site_id_sites_id_fk" FOREIGN KEY ("site_id") REFERENCES "public"."sites"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pedestrian_rules" ADD CONSTRAINT "pedestrian_rules_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pedestrian_rules" ADD CONSTRAINT "pedestrian_rules_zone_id_zones_id_fk" FOREIGN KEY ("zone_id") REFERENCES "public"."zones"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tenant_dock_assignments" ADD CONSTRAINT "tenant_dock_assignments_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tenant_dock_assignments" ADD CONSTRAINT "tenant_dock_assignments_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tenant_dock_assignments" ADD CONSTRAINT "tenant_dock_assignments_dock_id_docks_id_fk" FOREIGN KEY ("dock_id") REFERENCES "public"."docks"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tenant_dock_assignments" ADD CONSTRAINT "tenant_dock_assignments_basis_clause_id_contract_clauses_id_fk" FOREIGN KEY ("basis_clause_id") REFERENCES "public"."contract_clauses"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tenant_parking_assignments" ADD CONSTRAINT "tenant_parking_assignments_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tenant_parking_assignments" ADD CONSTRAINT "tenant_parking_assignments_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tenant_parking_assignments" ADD CONSTRAINT "tenant_parking_assignments_parking_area_id_parking_areas_id_fk" FOREIGN KEY ("parking_area_id") REFERENCES "public"."parking_areas"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tenant_parking_assignments" ADD CONSTRAINT "tenant_parking_assignments_basis_clause_id_fk" FOREIGN KEY ("basis_clause_id") REFERENCES "public"."contract_clauses"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tenants" ADD CONSTRAINT "tenants_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tenants" ADD CONSTRAINT "tenants_site_id_sites_id_fk" FOREIGN KEY ("site_id") REFERENCES "public"."sites"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tenants" ADD CONSTRAINT "tenants_default_category_id_vehicle_categories_id_fk" FOREIGN KEY ("default_category_id") REFERENCES "public"."vehicle_categories"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "gate_decisions" ADD CONSTRAINT "gate_decisions_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "gate_decisions" ADD CONSTRAINT "gate_decisions_site_id_sites_id_fk" FOREIGN KEY ("site_id") REFERENCES "public"."sites"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "gate_decisions" ADD CONSTRAINT "gate_decisions_gate_id_gates_id_fk" FOREIGN KEY ("gate_id") REFERENCES "public"."gates"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "gate_decisions" ADD CONSTRAINT "gate_decisions_pass_id_passes_id_fk" FOREIGN KEY ("pass_id") REFERENCES "public"."passes"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "gate_decisions" ADD CONSTRAINT "gate_decisions_hardware_event_id_hardware_events_id_fk" FOREIGN KEY ("hardware_event_id") REFERENCES "public"."hardware_events"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "gate_decisions" ADD CONSTRAINT "gate_decisions_visit_id_visits_id_fk" FOREIGN KEY ("visit_id") REFERENCES "public"."visits"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "gate_decisions" ADD CONSTRAINT "gate_decisions_override_id_override_requests_id_fk" FOREIGN KEY ("override_id") REFERENCES "public"."override_requests"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "gate_decisions" ADD CONSTRAINT "gate_decisions_gate_account_id_gate_accounts_id_fk" FOREIGN KEY ("gate_account_id") REFERENCES "public"."gate_accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "gate_decisions" ADD CONSTRAINT "gate_decisions_device_id_gate_devices_id_fk" FOREIGN KEY ("device_id") REFERENCES "public"."gate_devices"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "gate_decisions" ADD CONSTRAINT "gate_decisions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "gate_passages" ADD CONSTRAINT "gate_passages_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "gate_passages" ADD CONSTRAINT "gate_passages_site_id_sites_id_fk" FOREIGN KEY ("site_id") REFERENCES "public"."sites"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "gate_passages" ADD CONSTRAINT "gate_passages_gate_id_gates_id_fk" FOREIGN KEY ("gate_id") REFERENCES "public"."gates"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "gate_passages" ADD CONSTRAINT "gate_passages_pass_id_passes_id_fk" FOREIGN KEY ("pass_id") REFERENCES "public"."passes"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "gate_passages" ADD CONSTRAINT "gate_passages_decision_id_gate_decisions_id_fk" FOREIGN KEY ("decision_id") REFERENCES "public"."gate_decisions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "gate_passages" ADD CONSTRAINT "gate_passages_gate_account_id_gate_accounts_id_fk" FOREIGN KEY ("gate_account_id") REFERENCES "public"."gate_accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "gate_passages" ADD CONSTRAINT "gate_passages_device_id_gate_devices_id_fk" FOREIGN KEY ("device_id") REFERENCES "public"."gate_devices"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "gate_queue" ADD CONSTRAINT "gate_queue_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "gate_queue" ADD CONSTRAINT "gate_queue_site_id_sites_id_fk" FOREIGN KEY ("site_id") REFERENCES "public"."sites"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "gate_queue" ADD CONSTRAINT "gate_queue_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "gate_queue" ADD CONSTRAINT "gate_queue_gate_id_gates_id_fk" FOREIGN KEY ("gate_id") REFERENCES "public"."gates"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "gate_queue" ADD CONSTRAINT "gate_queue_pass_id_passes_id_fk" FOREIGN KEY ("pass_id") REFERENCES "public"."passes"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "gate_queue" ADD CONSTRAINT "gate_queue_quota_id_quotas_id_fk" FOREIGN KEY ("quota_id") REFERENCES "public"."quotas"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "gate_requests" ADD CONSTRAINT "gate_requests_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "gate_requests" ADD CONSTRAINT "gate_requests_site_id_sites_id_fk" FOREIGN KEY ("site_id") REFERENCES "public"."sites"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "gate_requests" ADD CONSTRAINT "gate_requests_gate_id_gates_id_fk" FOREIGN KEY ("gate_id") REFERENCES "public"."gates"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "gate_requests" ADD CONSTRAINT "gate_requests_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "gate_requests" ADD CONSTRAINT "gate_requests_category_id_vehicle_categories_id_fk" FOREIGN KEY ("category_id") REFERENCES "public"."vehicle_categories"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "gate_requests" ADD CONSTRAINT "gate_requests_created_by_gate_account_id_gate_accounts_id_fk" FOREIGN KEY ("created_by_gate_account_id") REFERENCES "public"."gate_accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "gate_requests" ADD CONSTRAINT "gate_requests_device_id_gate_devices_id_fk" FOREIGN KEY ("device_id") REFERENCES "public"."gate_devices"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "gate_requests" ADD CONSTRAINT "gate_requests_answered_by_users_id_fk" FOREIGN KEY ("answered_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "gate_requests" ADD CONSTRAINT "gate_requests_pass_id_passes_id_fk" FOREIGN KEY ("pass_id") REFERENCES "public"."passes"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "override_requests" ADD CONSTRAINT "override_requests_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "override_requests" ADD CONSTRAINT "override_requests_site_id_sites_id_fk" FOREIGN KEY ("site_id") REFERENCES "public"."sites"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "override_requests" ADD CONSTRAINT "override_requests_gate_id_gates_id_fk" FOREIGN KEY ("gate_id") REFERENCES "public"."gates"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "override_requests" ADD CONSTRAINT "override_requests_pass_id_passes_id_fk" FOREIGN KEY ("pass_id") REFERENCES "public"."passes"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "override_requests" ADD CONSTRAINT "override_requests_device_id_gate_devices_id_fk" FOREIGN KEY ("device_id") REFERENCES "public"."gate_devices"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "override_requests" ADD CONSTRAINT "override_requests_decided_by_users_id_fk" FOREIGN KEY ("decided_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "override_requests" ADD CONSTRAINT "override_requests_requested_by_gate_account_id_fk" FOREIGN KEY ("requested_by_gate_account_id") REFERENCES "public"."gate_accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "visits" ADD CONSTRAINT "visits_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "visits" ADD CONSTRAINT "visits_site_id_sites_id_fk" FOREIGN KEY ("site_id") REFERENCES "public"."sites"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "visits" ADD CONSTRAINT "visits_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "visits" ADD CONSTRAINT "visits_pass_id_passes_id_fk" FOREIGN KEY ("pass_id") REFERENCES "public"."passes"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "visits" ADD CONSTRAINT "visits_category_id_vehicle_categories_id_fk" FOREIGN KEY ("category_id") REFERENCES "public"."vehicle_categories"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "visits" ADD CONSTRAINT "visits_gate_in_id_gates_id_fk" FOREIGN KEY ("gate_in_id") REFERENCES "public"."gates"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "visits" ADD CONSTRAINT "visits_gate_account_in_id_gate_accounts_id_fk" FOREIGN KEY ("gate_account_in_id") REFERENCES "public"."gate_accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "visits" ADD CONSTRAINT "visits_device_in_id_gate_devices_id_fk" FOREIGN KEY ("device_in_id") REFERENCES "public"."gate_devices"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "visits" ADD CONSTRAINT "visits_gate_out_id_gates_id_fk" FOREIGN KEY ("gate_out_id") REFERENCES "public"."gates"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "visits" ADD CONSTRAINT "visits_gate_account_out_id_gate_accounts_id_fk" FOREIGN KEY ("gate_account_out_id") REFERENCES "public"."gate_accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "visits" ADD CONSTRAINT "visits_device_out_id_gate_devices_id_fk" FOREIGN KEY ("device_out_id") REFERENCES "public"."gate_devices"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "visits" ADD CONSTRAINT "visits_hardware_event_in_id_hardware_events_id_fk" FOREIGN KEY ("hardware_event_in_id") REFERENCES "public"."hardware_events"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "visits" ADD CONSTRAINT "visits_hardware_event_out_id_hardware_events_id_fk" FOREIGN KEY ("hardware_event_out_id") REFERENCES "public"."hardware_events"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "visits" ADD CONSTRAINT "visits_decision_in_id_gate_decisions_id_fk" FOREIGN KEY ("decision_in_id") REFERENCES "public"."gate_decisions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "visits" ADD CONSTRAINT "visits_decision_out_id_gate_decisions_id_fk" FOREIGN KEY ("decision_out_id") REFERENCES "public"."gate_decisions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "visits" ADD CONSTRAINT "visits_overage_quota_id_quotas_id_fk" FOREIGN KEY ("overage_quota_id") REFERENCES "public"."quotas"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "visits" ADD CONSTRAINT "visits_exception_id_exceptions_id_fk" FOREIGN KEY ("exception_id") REFERENCES "public"."exceptions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "visits" ADD CONSTRAINT "visits_override_id_override_requests_id_fk" FOREIGN KEY ("override_id") REFERENCES "public"."override_requests"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "blacklist_organization_id_plate_norm_idx" ON "blacklist" USING btree ("organization_id","plate_norm");--> statement-breakpoint
CREATE UNIQUE INDEX "vehicle_categories_preset_key" ON "vehicle_categories" USING btree ("organization_id",coalesce("site_id", '00000000-0000-0000-0000-000000000000'::uuid),"preset_code") WHERE "vehicle_categories"."preset_code" is not null;--> statement-breakpoint
CREATE INDEX "audit_log_organization_id_at_idx" ON "audit_log" USING btree ("organization_id","at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "audit_log_entity_idx" ON "audit_log" USING btree ("entity","entity_id");--> statement-breakpoint
CREATE INDEX "domain_events_site_id_id_idx" ON "domain_events" USING btree ("site_id","id");--> statement-breakpoint
CREATE INDEX "barrier_commands_pending_idx" ON "barrier_commands" USING btree ("device_id","status") WHERE "barrier_commands"."status" in ('queued', 'sent');--> statement-breakpoint
CREATE INDEX "hardware_events_site_id_at_idx" ON "hardware_events" USING btree ("site_id","at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "passes_plate_norm_trgm_idx" ON "passes" USING gin ("plate_norm" gin_trgm_ops);--> statement-breakpoint
CREATE INDEX "passes_person_name_trgm_idx" ON "passes" USING gin ("person_name" gin_trgm_ops);--> statement-breakpoint
CREATE INDEX "passes_site_id_status_idx" ON "passes" USING btree ("site_id","status");--> statement-breakpoint
CREATE INDEX "passes_tenant_id_status_idx" ON "passes" USING btree ("tenant_id","status");--> statement-breakpoint
CREATE UNIQUE INDEX "fleet_vehicles_tenant_id_plate_norm_key" ON "fleet_vehicles" USING btree ("tenant_id","plate_norm") WHERE "fleet_vehicles"."deleted_at" is null;--> statement-breakpoint
CREATE INDEX "gate_decisions_site_id_at_idx" ON "gate_decisions" USING btree ("site_id","at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "gate_decisions_pass_id_idx" ON "gate_decisions" USING btree ("pass_id");--> statement-breakpoint
CREATE UNIQUE INDEX "gate_queue_waiting_pass_key" ON "gate_queue" USING btree ("pass_id") WHERE "gate_queue"."left_at" is null;--> statement-breakpoint
CREATE INDEX "visits_open_by_category_idx" ON "visits" USING btree ("site_id","tenant_id","category_id") WHERE "visits"."time_out" is null;--> statement-breakpoint
CREATE INDEX "visits_open_by_plate_idx" ON "visits" USING btree ("site_id","plate_norm") WHERE "visits"."time_out" is null;--> statement-breakpoint
CREATE INDEX "visits_pass_id_idx" ON "visits" USING btree ("pass_id");--> statement-breakpoint
CREATE POLICY "organization_isolation" ON "overage_charges" AS PERMISSIVE FOR ALL TO public USING ("organization_id" = nullif(current_setting('app.organization_id', true), '')::uuid) WITH CHECK ("organization_id" = nullif(current_setting('app.organization_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "organization_isolation" ON "violations" AS PERMISSIVE FOR ALL TO public USING ("organization_id" = nullif(current_setting('app.organization_id', true), '')::uuid) WITH CHECK ("organization_id" = nullif(current_setting('app.organization_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "organization_isolation" ON "blacklist" AS PERMISSIVE FOR ALL TO public USING ("organization_id" = nullif(current_setting('app.organization_id', true), '')::uuid) WITH CHECK ("organization_id" = nullif(current_setting('app.organization_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "organization_isolation" ON "vehicle_categories" AS PERMISSIVE FOR ALL TO public USING ("organization_id" = nullif(current_setting('app.organization_id', true), '')::uuid) WITH CHECK ("organization_id" = nullif(current_setting('app.organization_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "organization_isolation" ON "visit_purposes" AS PERMISSIVE FOR ALL TO public USING ("organization_id" = nullif(current_setting('app.organization_id', true), '')::uuid) WITH CHECK ("organization_id" = nullif(current_setting('app.organization_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "organization_isolation" ON "audit_log" AS PERMISSIVE FOR ALL TO public USING ("organization_id" = nullif(current_setting('app.organization_id', true), '')::uuid) WITH CHECK ("organization_id" = nullif(current_setting('app.organization_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "organization_isolation" ON "domain_events" AS PERMISSIVE FOR ALL TO public USING ("organization_id" = nullif(current_setting('app.organization_id', true), '')::uuid) WITH CHECK ("organization_id" = nullif(current_setting('app.organization_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "organization_isolation" ON "notifications" AS PERMISSIVE FOR ALL TO public USING ("organization_id" = nullif(current_setting('app.organization_id', true), '')::uuid) WITH CHECK ("organization_id" = nullif(current_setting('app.organization_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "organization_isolation" ON "barrier_commands" AS PERMISSIVE FOR ALL TO public USING ("organization_id" = nullif(current_setting('app.organization_id', true), '')::uuid) WITH CHECK ("organization_id" = nullif(current_setting('app.organization_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "organization_isolation" ON "hardware_devices" AS PERMISSIVE FOR ALL TO public USING ("organization_id" = nullif(current_setting('app.organization_id', true), '')::uuid) WITH CHECK ("organization_id" = nullif(current_setting('app.organization_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "organization_isolation" ON "hardware_events" AS PERMISSIVE FOR ALL TO public USING ("organization_id" = nullif(current_setting('app.organization_id', true), '')::uuid) WITH CHECK ("organization_id" = nullif(current_setting('app.organization_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "organization_isolation" ON "docks" AS PERMISSIVE FOR ALL TO public USING ("organization_id" = nullif(current_setting('app.organization_id', true), '')::uuid) WITH CHECK ("organization_id" = nullif(current_setting('app.organization_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "organization_isolation" ON "gates" AS PERMISSIVE FOR ALL TO public USING ("organization_id" = nullif(current_setting('app.organization_id', true), '')::uuid) WITH CHECK ("organization_id" = nullif(current_setting('app.organization_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "organization_isolation" ON "organizations" AS PERMISSIVE FOR ALL TO public USING (id = nullif(current_setting('app.organization_id', true), '')::uuid) WITH CHECK (id = nullif(current_setting('app.organization_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "organization_isolation" ON "parking_areas" AS PERMISSIVE FOR ALL TO public USING ("organization_id" = nullif(current_setting('app.organization_id', true), '')::uuid) WITH CHECK ("organization_id" = nullif(current_setting('app.organization_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "organization_isolation" ON "sites" AS PERMISSIVE FOR ALL TO public USING ("organization_id" = nullif(current_setting('app.organization_id', true), '')::uuid) WITH CHECK ("organization_id" = nullif(current_setting('app.organization_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "organization_isolation" ON "zones" AS PERMISSIVE FOR ALL TO public USING ("organization_id" = nullif(current_setting('app.organization_id', true), '')::uuid) WITH CHECK ("organization_id" = nullif(current_setting('app.organization_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "organization_isolation" ON "pass_batches" AS PERMISSIVE FOR ALL TO public USING ("organization_id" = nullif(current_setting('app.organization_id', true), '')::uuid) WITH CHECK ("organization_id" = nullif(current_setting('app.organization_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "organization_isolation" ON "pass_change_requests" AS PERMISSIVE FOR ALL TO public USING ("organization_id" = nullif(current_setting('app.organization_id', true), '')::uuid) WITH CHECK ("organization_id" = nullif(current_setting('app.organization_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "organization_isolation" ON "pass_tokens" AS PERMISSIVE FOR ALL TO public USING ("organization_id" = nullif(current_setting('app.organization_id', true), '')::uuid) WITH CHECK ("organization_id" = nullif(current_setting('app.organization_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "organization_isolation" ON "passes" AS PERMISSIVE FOR ALL TO public USING ("organization_id" = nullif(current_setting('app.organization_id', true), '')::uuid) WITH CHECK ("organization_id" = nullif(current_setting('app.organization_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "organization_isolation" ON "device_enrollments" AS PERMISSIVE FOR ALL TO public USING ("organization_id" = nullif(current_setting('app.organization_id', true), '')::uuid) WITH CHECK ("organization_id" = nullif(current_setting('app.organization_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "organization_isolation" ON "gate_accounts" AS PERMISSIVE FOR ALL TO public USING ("organization_id" = nullif(current_setting('app.organization_id', true), '')::uuid) WITH CHECK ("organization_id" = nullif(current_setting('app.organization_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "organization_isolation" ON "gate_devices" AS PERMISSIVE FOR ALL TO public USING ("organization_id" = nullif(current_setting('app.organization_id', true), '')::uuid) WITH CHECK ("organization_id" = nullif(current_setting('app.organization_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "organization_isolation" ON "invitations" AS PERMISSIVE FOR ALL TO public USING ("organization_id" = nullif(current_setting('app.organization_id', true), '')::uuid) WITH CHECK ("organization_id" = nullif(current_setting('app.organization_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "organization_isolation" ON "role_assignments" AS PERMISSIVE FOR ALL TO public USING ("organization_id" = nullif(current_setting('app.organization_id', true), '')::uuid) WITH CHECK ("organization_id" = nullif(current_setting('app.organization_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "organization_isolation" ON "roles" AS PERMISSIVE FOR ALL TO public USING ("organization_id" = nullif(current_setting('app.organization_id', true), '')::uuid) WITH CHECK ("organization_id" = nullif(current_setting('app.organization_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "organization_isolation" ON "shift_marks" AS PERMISSIVE FOR ALL TO public USING ("organization_id" = nullif(current_setting('app.organization_id', true), '')::uuid) WITH CHECK ("organization_id" = nullif(current_setting('app.organization_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "organization_isolation" ON "approval_policies" AS PERMISSIVE FOR ALL TO public USING ("organization_id" = nullif(current_setting('app.organization_id', true), '')::uuid) WITH CHECK ("organization_id" = nullif(current_setting('app.organization_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "organization_isolation" ON "exceptions" AS PERMISSIVE FOR ALL TO public USING ("organization_id" = nullif(current_setting('app.organization_id', true), '')::uuid) WITH CHECK ("organization_id" = nullif(current_setting('app.organization_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "organization_isolation" ON "quota_categories" AS PERMISSIVE FOR ALL TO public USING (exists (select 1 from "quotas" p where p.id = "quota_categories"."quota_id")) WITH CHECK (exists (select 1 from "quotas" p where p.id = "quota_categories"."quota_id"));--> statement-breakpoint
CREATE POLICY "organization_isolation" ON "quotas" AS PERMISSIVE FOR ALL TO public USING ("organization_id" = nullif(current_setting('app.organization_id', true), '')::uuid) WITH CHECK ("organization_id" = nullif(current_setting('app.organization_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "organization_isolation" ON "routing_rules" AS PERMISSIVE FOR ALL TO public USING ("organization_id" = nullif(current_setting('app.organization_id', true), '')::uuid) WITH CHECK ("organization_id" = nullif(current_setting('app.organization_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "organization_isolation" ON "time_window_policies" AS PERMISSIVE FOR ALL TO public USING ("organization_id" = nullif(current_setting('app.organization_id', true), '')::uuid) WITH CHECK ("organization_id" = nullif(current_setting('app.organization_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "organization_isolation" ON "time_window_policy_categories" AS PERMISSIVE FOR ALL TO public USING (exists (select 1 from "time_window_policies" p where p.id = "time_window_policy_categories"."policy_id")) WITH CHECK (exists (select 1 from "time_window_policies" p where p.id = "time_window_policy_categories"."policy_id"));--> statement-breakpoint
CREATE POLICY "organization_isolation" ON "contract_clauses" AS PERMISSIVE FOR ALL TO public USING ("organization_id" = nullif(current_setting('app.organization_id', true), '')::uuid) WITH CHECK ("organization_id" = nullif(current_setting('app.organization_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "organization_isolation" ON "contracts" AS PERMISSIVE FOR ALL TO public USING ("organization_id" = nullif(current_setting('app.organization_id', true), '')::uuid) WITH CHECK ("organization_id" = nullif(current_setting('app.organization_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "organization_isolation" ON "fleet_vehicles" AS PERMISSIVE FOR ALL TO public USING ("organization_id" = nullif(current_setting('app.organization_id', true), '')::uuid) WITH CHECK ("organization_id" = nullif(current_setting('app.organization_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "organization_isolation" ON "pedestrian_rules" AS PERMISSIVE FOR ALL TO public USING ("organization_id" = nullif(current_setting('app.organization_id', true), '')::uuid) WITH CHECK ("organization_id" = nullif(current_setting('app.organization_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "organization_isolation" ON "tenant_dock_assignments" AS PERMISSIVE FOR ALL TO public USING ("organization_id" = nullif(current_setting('app.organization_id', true), '')::uuid) WITH CHECK ("organization_id" = nullif(current_setting('app.organization_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "organization_isolation" ON "tenant_parking_assignments" AS PERMISSIVE FOR ALL TO public USING ("organization_id" = nullif(current_setting('app.organization_id', true), '')::uuid) WITH CHECK ("organization_id" = nullif(current_setting('app.organization_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "organization_isolation" ON "tenants" AS PERMISSIVE FOR ALL TO public USING ("organization_id" = nullif(current_setting('app.organization_id', true), '')::uuid) WITH CHECK ("organization_id" = nullif(current_setting('app.organization_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "organization_isolation" ON "gate_decisions" AS PERMISSIVE FOR ALL TO public USING ("organization_id" = nullif(current_setting('app.organization_id', true), '')::uuid) WITH CHECK ("organization_id" = nullif(current_setting('app.organization_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "organization_isolation" ON "gate_passages" AS PERMISSIVE FOR ALL TO public USING ("organization_id" = nullif(current_setting('app.organization_id', true), '')::uuid) WITH CHECK ("organization_id" = nullif(current_setting('app.organization_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "organization_isolation" ON "gate_queue" AS PERMISSIVE FOR ALL TO public USING ("organization_id" = nullif(current_setting('app.organization_id', true), '')::uuid) WITH CHECK ("organization_id" = nullif(current_setting('app.organization_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "organization_isolation" ON "gate_requests" AS PERMISSIVE FOR ALL TO public USING ("organization_id" = nullif(current_setting('app.organization_id', true), '')::uuid) WITH CHECK ("organization_id" = nullif(current_setting('app.organization_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "organization_isolation" ON "override_requests" AS PERMISSIVE FOR ALL TO public USING ("organization_id" = nullif(current_setting('app.organization_id', true), '')::uuid) WITH CHECK ("organization_id" = nullif(current_setting('app.organization_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "organization_isolation" ON "visits" AS PERMISSIVE FOR ALL TO public USING ("organization_id" = nullif(current_setting('app.organization_id', true), '')::uuid) WITH CHECK ("organization_id" = nullif(current_setting('app.organization_id', true), '')::uuid);