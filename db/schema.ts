import { pgTable, text, jsonb, timestamp } from 'drizzle-orm/pg-core';

export const gameRooms = pgTable('game_rooms', {
  code: text('code').primaryKey(),
  snapshot: jsonb('snapshot').notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});
