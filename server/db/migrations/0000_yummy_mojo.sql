CREATE TYPE "public"."quiz_status" AS ENUM('draft', 'published', 'archived');--> statement-breakpoint
CREATE TYPE "public"."session_state" AS ENUM('created', 'lobby', 'countdown', 'question_open', 'question_locked', 'reveal', 'leaderboard', 'paused', 'recovering', 'podium', 'finished', 'cancelled');--> statement-breakpoint
CREATE TYPE "public"."workspace_role" AS ENUM('owner', 'admin', 'editor', 'host', 'analyst', 'viewer');--> statement-breakpoint
CREATE TABLE "participants" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"session_id" uuid NOT NULL,
	"token_hash" varchar(128) NOT NULL,
	"nickname" varchar(32) NOT NULL,
	"nickname_normalized" varchar(32) NOT NULL,
	"connected" boolean DEFAULT true NOT NULL,
	"joined_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "profiles" (
	"user_id" uuid PRIMARY KEY NOT NULL,
	"display_name" varchar(80) NOT NULL,
	"locale" varchar(12) DEFAULT 'id-ID' NOT NULL,
	"avatar_path" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "questions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"quiz_version_id" uuid NOT NULL,
	"sequence" integer NOT NULL,
	"type" varchar(32) NOT NULL,
	"prompt" text NOT NULL,
	"answer_schema_version" integer DEFAULT 1 NOT NULL,
	"config" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"duration_ms" integer DEFAULT 20000 NOT NULL,
	"base_points" integer DEFAULT 1000 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "quiz_versions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"quiz_id" uuid NOT NULL,
	"version" integer NOT NULL,
	"content_hash" varchar(64) NOT NULL,
	"title_snapshot" varchar(180) NOT NULL,
	"published_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "quizzes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"owner_id" uuid NOT NULL,
	"title" varchar(180) NOT NULL,
	"description" text,
	"category" varchar(80) DEFAULT 'Umum' NOT NULL,
	"visibility" varchar(16) DEFAULT 'private' NOT NULL,
	"status" "quiz_status" DEFAULT 'draft' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "sessions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"quiz_version_id" uuid NOT NULL,
	"host_id" uuid NOT NULL,
	"mode" varchar(24) DEFAULT 'live_individual' NOT NULL,
	"state" "session_state" DEFAULT 'created' NOT NULL,
	"state_version" integer DEFAULT 0 NOT NULL,
	"event_seq" integer DEFAULT 0 NOT NULL,
	"pin_hash" varchar(128) NOT NULL,
	"pin_expires_at" timestamp with time zone NOT NULL,
	"ruleset_version" varchar(32) DEFAULT 'default-v1' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "submissions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"session_id" uuid NOT NULL,
	"participant_id" uuid NOT NULL,
	"question_id" uuid NOT NULL,
	"request_id" uuid NOT NULL,
	"payload" jsonb NOT NULL,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL,
	"is_correct" boolean NOT NULL,
	"points" integer DEFAULT 0 NOT NULL,
	"latency_ms" integer
);
--> statement-breakpoint
CREATE TABLE "workspace_members" (
	"workspace_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"role" "workspace_role" DEFAULT 'viewer' NOT NULL,
	"joined_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "workspace_members_workspace_id_user_id_pk" PRIMARY KEY("workspace_id","user_id")
);
--> statement-breakpoint
CREATE TABLE "workspaces" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" varchar(100) NOT NULL,
	"slug" varchar(120) NOT NULL,
	"owner_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "workspaces_slug_unique" UNIQUE("slug")
);
--> statement-breakpoint
ALTER TABLE "participants" ADD CONSTRAINT "participants_session_id_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."sessions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "questions" ADD CONSTRAINT "questions_quiz_version_id_quiz_versions_id_fk" FOREIGN KEY ("quiz_version_id") REFERENCES "public"."quiz_versions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "quiz_versions" ADD CONSTRAINT "quiz_versions_quiz_id_quizzes_id_fk" FOREIGN KEY ("quiz_id") REFERENCES "public"."quizzes"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "quizzes" ADD CONSTRAINT "quizzes_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "quizzes" ADD CONSTRAINT "quizzes_owner_id_profiles_user_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."profiles"("user_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_quiz_version_id_quiz_versions_id_fk" FOREIGN KEY ("quiz_version_id") REFERENCES "public"."quiz_versions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_host_id_profiles_user_id_fk" FOREIGN KEY ("host_id") REFERENCES "public"."profiles"("user_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "submissions" ADD CONSTRAINT "submissions_session_id_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."sessions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "submissions" ADD CONSTRAINT "submissions_participant_id_participants_id_fk" FOREIGN KEY ("participant_id") REFERENCES "public"."participants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "submissions" ADD CONSTRAINT "submissions_question_id_questions_id_fk" FOREIGN KEY ("question_id") REFERENCES "public"."questions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workspace_members" ADD CONSTRAINT "workspace_members_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workspace_members" ADD CONSTRAINT "workspace_members_user_id_profiles_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."profiles"("user_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workspaces" ADD CONSTRAINT "workspaces_owner_id_profiles_user_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."profiles"("user_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "participants_nickname_session_uidx" ON "participants" USING btree ("session_id","nickname_normalized");--> statement-breakpoint
CREATE INDEX "participants_session_joined_idx" ON "participants" USING btree ("session_id","joined_at");--> statement-breakpoint
CREATE UNIQUE INDEX "questions_version_sequence_uidx" ON "questions" USING btree ("quiz_version_id","sequence");--> statement-breakpoint
CREATE UNIQUE INDEX "quiz_versions_quiz_version_uidx" ON "quiz_versions" USING btree ("quiz_id","version");--> statement-breakpoint
CREATE INDEX "quizzes_workspace_updated_idx" ON "quizzes" USING btree ("workspace_id","updated_at");--> statement-breakpoint
CREATE INDEX "sessions_state_created_idx" ON "sessions" USING btree ("state","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "submissions_once_per_question_uidx" ON "submissions" USING btree ("session_id","participant_id","question_id");--> statement-breakpoint
CREATE UNIQUE INDEX "submissions_request_id_uidx" ON "submissions" USING btree ("request_id");--> statement-breakpoint
CREATE INDEX "submissions_session_received_idx" ON "submissions" USING btree ("session_id","received_at");