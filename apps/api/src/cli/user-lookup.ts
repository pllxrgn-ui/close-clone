import { and, asc, eq, ilike, isNull, or, sql, type SQL } from 'drizzle-orm';
import type { PgTable } from 'drizzle-orm/pg-core';

import {
  activities,
  leads,
  notes,
  opportunities,
  tasks,
  users,
  type Db,
} from '../db/index.ts';

/**
 * `switchboard-admin user-lookup <emailOrName>` (Task 5g). Resolves users by
 * exact email (citext, case-insensitive) or name substring, and reports each
 * match's id, role, active flag, and activity counts (owned leads/opportunities,
 * authored activities/notes, assigned tasks) — the "who is this and what do they
 * touch" an admin needs before a merge or delete.
 *
 * Read-only: no audit event (auth events are 5b's concern; a lookup mutates
 * nothing). Import-safe for direct `node` execution (no enums / namespaces /
 * parameter properties — the host type-stripping constraint).
 */

export interface UserActivityCounts {
  leadsOwned: number;
  opportunitiesOwned: number;
  activities: number;
  tasksAssigned: number;
  notesAuthored: number;
}

export interface UserLookupResult {
  id: string;
  email: string;
  name: string;
  role: string;
  isActive: boolean;
  timezone: string;
  counts: UserActivityCounts;
}

async function countWhere(db: Db, table: PgTable, where: SQL | undefined): Promise<number> {
  const [row] = await db.select({ n: sql<number>`count(*)::int` }).from(table).where(where);
  return row?.n ?? 0;
}

export async function userLookup(db: Db, query: string): Promise<UserLookupResult[]> {
  const q = query.trim();
  if (q.length === 0) return [];

  // Exact email (citext) OR name substring. `%`/`_` in the query act as LIKE
  // wildcards — acceptable for an operator tool.
  const matched = await db
    .select()
    .from(users)
    .where(or(eq(users.email, q), ilike(users.name, `%${q}%`)))
    .orderBy(asc(users.email));

  const results: UserLookupResult[] = [];
  for (const u of matched) {
    results.push({
      id: u.id,
      email: u.email,
      name: u.name,
      role: u.role,
      isActive: u.isActive,
      timezone: u.timezone,
      counts: {
        leadsOwned: await countWhere(db, leads, and(eq(leads.ownerId, u.id), isNull(leads.deletedAt))),
        opportunitiesOwned: await countWhere(db, opportunities, eq(opportunities.ownerId, u.id)),
        activities: await countWhere(db, activities, eq(activities.userId, u.id)),
        tasksAssigned: await countWhere(db, tasks, eq(tasks.assigneeId, u.id)),
        notesAuthored: await countWhere(db, notes, eq(notes.authorId, u.id)),
      },
    });
  }
  return results;
}
