CREATE TYPE "external_identity_provider" AS ENUM ('google');
CREATE TABLE "external_identities" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "user_id" uuid NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
  "provider" "external_identity_provider" NOT NULL,
  "provider_subject" text NOT NULL,
  "email_at_link_time" text,
  "created_at" timestamptz DEFAULT now() NOT NULL,
  "updated_at" timestamptz DEFAULT now() NOT NULL
);
CREATE UNIQUE INDEX "external_identities_provider_subject_uidx"
  ON "external_identities" ("provider", "provider_subject");
CREATE INDEX "external_identities_user_id_idx"
  ON "external_identities" ("user_id");
