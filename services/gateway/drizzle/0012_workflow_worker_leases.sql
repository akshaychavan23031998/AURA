CREATE TABLE "workflow_worker_leases" (
	"workflow_id" uuid PRIMARY KEY NOT NULL,
	"lease_owner" varchar(128) NOT NULL,
	"lease_generation" integer NOT NULL,
	"leased_at" timestamp with time zone NOT NULL,
	"heartbeat_at" timestamp with time zone NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	CONSTRAINT "workflow_worker_leases_generation_positive" CHECK ("lease_generation" > 0),
	CONSTRAINT "workflow_worker_leases_owner_bounded" CHECK (char_length("lease_owner") BETWEEN 1 AND 128),
	CONSTRAINT "workflow_worker_leases_expiry_valid" CHECK ("expires_at" >= "heartbeat_at")
);
--> statement-breakpoint
ALTER TABLE "workflow_worker_leases" ADD CONSTRAINT "workflow_worker_leases_workflow_id_workflows_id_fk" FOREIGN KEY ("workflow_id") REFERENCES "public"."workflows"("id") ON DELETE CASCADE ON UPDATE NO ACTION;
--> statement-breakpoint
CREATE INDEX "workflow_worker_leases_expires_at_idx" ON "workflow_worker_leases" USING btree ("expires_at");
--> statement-breakpoint
ALTER TABLE "workflows" ADD COLUMN "execution_requested_at" timestamp with time zone;
--> statement-breakpoint
CREATE INDEX "workflows_worker_eligible_idx" ON "workflows" USING btree ("status", "execution_requested_at", "created_at");
--> statement-breakpoint
CREATE TABLE "workflow_permission_grants" (
	"workflow_id" uuid NOT NULL,
	"permission" varchar(64) NOT NULL,
	CONSTRAINT "workflow_permission_grants_pk" PRIMARY KEY("workflow_id","permission"),
	CONSTRAINT "workflow_permission_grants_permission_bounded" CHECK (char_length("permission") BETWEEN 1 AND 64)
);
--> statement-breakpoint
ALTER TABLE "workflow_permission_grants" ADD CONSTRAINT "workflow_permission_grants_workflow_id_workflows_id_fk" FOREIGN KEY ("workflow_id") REFERENCES "public"."workflows"("id") ON DELETE CASCADE ON UPDATE NO ACTION;
