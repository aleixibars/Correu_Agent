CREATE TABLE "auto_discard_rules" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"category" "triage_category" NOT NULL,
	"enabled" boolean DEFAULT false NOT NULL,
	"sender_patterns" text[] DEFAULT '{}' NOT NULL,
	"keyword_patterns" text[] DEFAULT '{}' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "auto_discard_rules_tenant_id_category_unique" UNIQUE("tenant_id","category"),
	CONSTRAINT "auto_discard_rules_eligible_category" CHECK (NOT "auto_discard_rules"."enabled" OR "auto_discard_rules"."category" IN ('comercial', 'suport', 'facturacio', 'newsletter', 'personal'))
);
--> statement-breakpoint
ALTER TABLE "auto_discard_rules" ADD CONSTRAINT "auto_discard_rules_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;