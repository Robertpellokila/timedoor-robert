CREATE TABLE "quiz_drafts" (
	"quiz_id" uuid PRIMARY KEY NOT NULL,
	"content" jsonb NOT NULL,
	"revision" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "quiz_drafts" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "sessions" ADD COLUMN "current_question_index" integer DEFAULT -1 NOT NULL;--> statement-breakpoint
ALTER TABLE "sessions" ADD COLUMN "opened_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "sessions" ADD COLUMN "deadline_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "quiz_drafts" ADD CONSTRAINT "quiz_drafts_quiz_id_quizzes_id_fk" FOREIGN KEY ("quiz_id") REFERENCES "public"."quizzes"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
REVOKE ALL PRIVILEGES ON TABLE "quiz_drafts" FROM anon, authenticated;
