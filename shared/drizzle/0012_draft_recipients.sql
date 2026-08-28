ALTER TABLE "drafts" ADD COLUMN "to_addresses" text[] DEFAULT '{}' NOT NULL;--> statement-breakpoint
ALTER TABLE "drafts" ADD COLUMN "cc_addresses" text[] DEFAULT '{}' NOT NULL;--> statement-breakpoint
ALTER TABLE "drafts" ADD COLUMN "bcc_addresses" text[] DEFAULT '{}' NOT NULL;