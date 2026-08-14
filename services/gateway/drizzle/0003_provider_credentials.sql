CREATE TABLE "provider_credentials" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "user_id" uuid NOT NULL REFERENCES "users"("id") ON DELETE cascade,
  "provider" "external_identity_provider" NOT NULL,
  "provider_subject" text NOT NULL,
  "encrypted_refresh_token" text NOT NULL,
  "granted_scopes" text[] NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
CREATE UNIQUE INDEX "provider_credentials_user_provider_uidx" ON "provider_credentials" USING btree ("user_id", "provider");
CREATE UNIQUE INDEX "provider_credentials_provider_subject_uidx" ON "provider_credentials" USING btree ("provider", "provider_subject");
