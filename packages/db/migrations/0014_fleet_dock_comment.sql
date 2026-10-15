ALTER TABLE "fleet_vehicles" ADD COLUMN "dock_id" uuid;--> statement-breakpoint
ALTER TABLE "fleet_vehicles" ADD COLUMN "comment" text;--> statement-breakpoint
ALTER TABLE "fleet_vehicles" ADD CONSTRAINT "fleet_vehicles_dock_id_docks_id_fk" FOREIGN KEY ("dock_id") REFERENCES "public"."docks"("id") ON DELETE no action ON UPDATE no action;