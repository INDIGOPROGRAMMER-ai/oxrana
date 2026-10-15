CREATE INDEX "passes_site_created_idx" ON "passes" USING btree ("site_id","created_at" DESC NULLS LAST,"id");--> statement-breakpoint
CREATE INDEX "passes_tenant_created_idx" ON "passes" USING btree ("tenant_id","created_at" DESC NULLS LAST,"id");--> statement-breakpoint
CREATE INDEX "passes_tenant_valid_from_idx" ON "passes" USING btree ("tenant_id","valid_from");--> statement-breakpoint
CREATE INDEX "visits_open_by_time_idx" ON "visits" USING btree ("site_id","tenant_id","time_in") WHERE "visits"."time_out" is null;