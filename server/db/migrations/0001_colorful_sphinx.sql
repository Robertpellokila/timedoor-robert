CREATE TABLE "session_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"session_id" uuid NOT NULL,
	"event_seq" integer NOT NULL,
	"event_type" varchar(32) NOT NULL,
	"payload" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"committed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"published_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "session_events" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "participants" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "profiles" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "questions" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "quiz_versions" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "quizzes" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "sessions" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "submissions" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "workspace_members" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "workspaces" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "questions" ADD COLUMN "answer_key" jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "session_events" ADD CONSTRAINT "session_events_session_id_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."sessions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "session_events_seq_uidx" ON "session_events" USING btree ("session_id","event_seq");--> statement-breakpoint
CREATE INDEX "session_events_pending_idx" ON "session_events" USING btree ("published_at","committed_at");
--> statement-breakpoint
REVOKE ALL PRIVILEGES ON TABLE "participants", "profiles", "questions", "quiz_versions", "quizzes", "session_events", "sessions", "submissions", "workspace_members", "workspaces" FROM anon, authenticated;--> statement-breakpoint
ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON TABLES FROM anon, authenticated;--> statement-breakpoint
CREATE OR REPLACE FUNCTION public.handle_new_user() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$ BEGIN INSERT INTO public.profiles (user_id, display_name) VALUES (NEW.id, COALESCE(NULLIF(NEW.raw_user_meta_data ->> 'display_name', ''), NULLIF(split_part(COALESCE(NEW.email, ''), '@', 1), ''), 'Pengajar')); RETURN NEW; END; $$;--> statement-breakpoint
CREATE TRIGGER on_auth_user_created AFTER INSERT ON auth.users FOR EACH ROW EXECUTE FUNCTION public.handle_new_user();
--> statement-breakpoint
REVOKE ALL ON FUNCTION public.handle_new_user() FROM PUBLIC, anon, authenticated;
