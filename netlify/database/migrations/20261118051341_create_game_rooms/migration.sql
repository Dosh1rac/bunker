CREATE TABLE "game_rooms" (
	"code" text PRIMARY KEY,
	"snapshot" jsonb NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
