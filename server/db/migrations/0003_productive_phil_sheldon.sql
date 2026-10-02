ALTER TABLE "sessions" ADD COLUMN "paused_from" "session_state";--> statement-breakpoint
CREATE UNIQUE INDEX "sessions_pin_hash_uidx" ON "sessions" USING btree ("pin_hash");