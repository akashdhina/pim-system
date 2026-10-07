/* eslint-disable @typescript-eslint/no-require-imports */

const postgres = require("postgres");

/*
 * SERVER-ONLY. Direct PostgreSQL connection to the pim-system project's
 * database - NOT the PostgREST/@supabase/supabase-js REST path.
 *
 * @supabase/supabase-js cannot provide real multi-statement transactions:
 * every .from(table).insert(...) call is an independent HTTP request, so
 * there is no way to compose several of them into one atomic commit across
 * tables (see docs/phase6-migration-design.md section 3). This module
 * exists specifically to give lib/pim-data/*.js real BEGIN/COMMIT/ROLLBACK
 * semantics, matching what lib/db.js's db.transaction(...) already
 * provides against SQLite.
 *
 * Never import this from a "use client" component. SUPABASE_DB_URL must
 * never be a NEXT_PUBLIC_* variable, returned in an API response, or
 * logged.
 *
 * Batch 1 uses this for one read-only route (see lib/pim-data/mediators.js)
 * and the users identity sync script - not for any mutation yet. Batch 2
 * added the type parsers below, discovered while porting the date/id/money
 * -heavy case-detail route.
 */

const CONNECTION_STRING = process.env.SUPABASE_DB_URL;

/*
 * postgres.js's default type parsing changes the wire shape of several
 * column types this app relies on being SQLite-compatible - "the SQL
 * executes" is not the same as "the meaning is preserved":
 *
 *   - bigint (oid 20, every id/FK column in this schema) -> parsed as a
 *     JS string by default (large bigints don't fit a safe JS Number).
 *     better-sqlite3 returns these as native numbers. Every id in this
 *     schema is a small sequential integer, nowhere near
 *     Number.MAX_SAFE_INTEGER, so converting back to a native number is
 *     safe here and restores parity (frontend code comparing/using ids
 *     as numbers, e.g. React keys, would otherwise silently receive "12"
 *     instead of 12).
 *   - numeric (oid 1700, claim_amount/amount_due/amount_received/etc.)
 *     -> parsed as a JS string by default (arbitrary-precision decimals
 *     don't fit a JS float generally). This app's money values are modest
 *     rupee amounts already handled with Number(...) coercion throughout
 *     lib/pim-mediation-fee.js and the case-detail fee summary - parsed
 *     back to a number for the same reason as bigint above.
 *   - date (oid 1082, every *_date column) -> parsed as a JS Date object
 *     by default. SQLite/better-sqlite3 returns these as plain
 *     'YYYY-MM-DD' text. A Date object round-tripped through
 *     Response.json() becomes a full ISO datetime string
 *     ("2026-01-01T00:00:00.000Z"), not the bare date SQLite always
 *     returned - kept as the original string instead.
 *
 * timestamptz (oid 1184, created_at/updated_at/changed_at/closed_at/etc.)
 * is deliberately NOT overridden: it already carries a real instant, so
 * postgres.js's default Date-object parsing round-trips through
 * JSON.stringify losslessly, unlike date's spurious added time-of-day.
 */
const TYPE_PARSERS = {
  bigint: {
    to: 20,
    from: [20],
    serialize: (value) => String(value),
    parse: (value) => Number(value),
  },
  numeric: {
    to: 1700,
    from: [1700],
    serialize: (value) => String(value),
    parse: (value) => (value === null ? null : Number(value)),
  },
  date: {
    to: 1082,
    from: [1082],
    serialize: (value) => value,
    parse: (value) => value,
  },
};

let client = null;

/*
 * Returns the shared postgres.js client. Callable as a tagged template
 * (sql`select ...`) for parameterized queries - values are always bound,
 * never string-concatenated into the query text.
 */
function getSql() {
  if (client) return client;

  if (!CONNECTION_STRING) {
    throw new Error(
      "PostgreSQL is not configured: set SUPABASE_DB_URL (server-only - the pim-system project's Transaction Pooler connection string from the Supabase dashboard: Project Settings > Database > Connection string > Transaction pooler. Never commit it)."
    );
  }

  client = postgres(CONNECTION_STRING, {
    /*
     * Supabase's Transaction Pooler (pgbouncer, transaction mode) does not
     * support session-level prepared statements, since the underlying
     * connection can be handed to a different client between statements.
     * postgres.js's own docs recommend prepare: false for this pooler mode.
     */
    prepare: false,
    types: TYPE_PARSERS,
  });

  return client;
}

/*
 * Runs fn inside a real transaction: sql.begin() issues BEGIN, commits on
 * a normal return, and rolls back automatically if fn throws - the direct
 * equivalent of lib/db.js's db.transaction(fn)() for SQLite. fn receives a
 * transaction-scoped tagged-template client (tx) to use for every
 * statement that must be part of the same transaction.
 */
async function withTransaction(fn) {
  const sql = getSql();
  return sql.begin((tx) => fn(tx));
}

module.exports = {
  getSql,
  withTransaction,
};
