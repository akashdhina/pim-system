/*
 * Wire-compatibility helpers for the PostgreSQL read loaders (Phase 6
 * Batch 5F). Pure functions - no database access.
 *
 * Why this exists: the loaders migrated in this batch must return the
 * SAME JSON the SQLite versions returned, because pages compare against
 * it strictly. Concretely app/pim/scrutiny/[id]/page.tsx and
 * app/pim/approval/[id]/page.tsx render the "Primary" badge only when
 * `party.is_primary === 1`; PostgreSQL's native boolean would arrive as
 * `true` and the badge would silently vanish. The schema audit found the
 * column SETS identical in every table these loaders read (no renames),
 * and only two kinds of representation difference:
 *
 *   1. booleans: SQLite INTEGER 0/1  vs  PostgreSQL boolean
 *      -> flag() converts back to 1 / 0 (null stays null).
 *
 *   2. instants: SQLite TEXT vs PostgreSQL timestamptz (returned as a JS
 *      Date, which JSON-serializes as an ISO string). SQLite stored two
 *      different shapes:
 *        - DEFAULT / CURRENT_TIMESTAMP columns (created_at, updated_at,
 *          closed_at): 'YYYY-MM-DD HH:MM:SS', UTC, no zone marker
 *          -> sqliteTimestamp()
 *        - values written from JS `new Date().toISOString()`
 *          (pim_scrutiny.scrutinised_at): 'YYYY-MM-DDTHH:MM:SS.mmmZ'
 *          -> isoInstant()
 *
 * Everything else already round-trips identically through the
 * lib/pim-postgres.js type parsers: bigint -> Number, numeric -> Number,
 * date -> 'YYYY-MM-DD' string, smallint -> Number.
 *
 * The column lists are supplied by each loader, per table, explicitly -
 * nothing here guesses which columns to convert.
 */

/* 1 / 0 / null, whatever the input representation (boolean or already 0/1). */
function flag(value) {
  if (value === null || value === undefined) return null;
  return value === true || value === 1 || value === "1" ? 1 : 0;
}

/*
 * 'YYYY-MM-DD HH:MM:SS' in UTC - exactly what SQLite's CURRENT_TIMESTAMP
 * produced (second precision, UTC, space separator, no zone suffix).
 */
function sqliteTimestamp(value) {
  if (value === null || value === undefined) return null;
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return String(value);
  return date.toISOString().slice(0, 19).replace("T", " ");
}

/* ISO-8601 with milliseconds and Z - what `new Date().toISOString()` wrote. */
function isoInstant(value) {
  if (value === null || value === undefined) return null;
  return value instanceof Date ? value.toISOString() : value;
}

/*
 * Returns a plain copy of `row` with the listed columns converted.
 * Columns not present in the row are ignored (never invented). Returns
 * the input unchanged for a falsy row so callers can pass `undefined`.
 */
function toWire(row, { flags = [], timestamps = [], instants = [] } = {}) {
  if (!row) return row;

  const out = { ...row };

  for (const key of flags) if (key in out) out[key] = flag(out[key]);
  for (const key of timestamps) if (key in out) out[key] = sqliteTimestamp(out[key]);
  for (const key of instants) if (key in out) out[key] = isoInstant(out[key]);

  return out;
}

module.exports = {
  flag,
  sqliteTimestamp,
  isoInstant,
  toWire,
};
