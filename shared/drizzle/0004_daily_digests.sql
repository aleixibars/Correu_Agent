CREATE TABLE "daily_digests" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"digest_date" date NOT NULL,
	"summary" text NOT NULL,
	"thread_count" integer NOT NULL,
	"model" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "daily_digests_tenant_id_digest_date_unique" UNIQUE("tenant_id","digest_date")
);
--> statement-breakpoint
ALTER TABLE "daily_digests" ADD CONSTRAINT "daily_digests_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;