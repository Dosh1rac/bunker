import { drizzle } from 'drizzle-orm/netlify-db';
import { eq, gt } from 'drizzle-orm';
import { pgTable, text, jsonb, timestamp } from 'drizzle-orm/pg-core';

// Keep in sync with db/schema.ts, the migration source of truth.
const gameRooms = pgTable('game_rooms', {
  code: text('code').primaryKey(),
  snapshot: jsonb('snapshot').notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

const db = drizzle();

export const roomStore = {
  async load() {
    const cutoff = new Date(Date.now() - 24 * 60 * 60 * 1000);
    const rows = await db.select().from(gameRooms).where(gt(gameRooms.updatedAt, cutoff));
    return rows.map((row) => row.snapshot);
  },
  async save(code, snapshot) {
    await db.insert(gameRooms).values({ code, snapshot, updatedAt: new Date() })
      .onConflictDoUpdate({ target: gameRooms.code, set: { snapshot, updatedAt: new Date() } });
  },
  async remove(code) {
    await db.delete(gameRooms).where(eq(gameRooms.code, code));
  },
};
