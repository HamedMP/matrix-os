/**
 * Hard size backstop for an owner database (T055a). The owner role owns the
 * tables it creates, and an owner keeps every privilege on what it owns, so
 * revoking DML from it would do nothing, and its read-only role default is a
 * setting it can switch off. The block therefore moves ownership: every
 * object the owner role owns in its database is reassigned to a per-owner
 * NOLOGIN holder role, CREATE on the database and schema `public` is revoked,
 * and the owner gets back only SELECT, DELETE and TRUNCATE on tables, SELECT
 * on views and sequences, and loses EXECUTE on security-definer functions
 * (which would run as the holder). The owner has no TEMPORARY privilege. It
 * cannot take ownership back: it is not a member of the holder role.
 *
 * REASSIGN OWNED needs the admin to hold the privileges of both roles. A
 * CREATEROLE admin has ADMIN OPTION on roles it created (Postgres 16+), so it
 * grants itself the two memberships inside the transaction and revokes them
 * before commit; a failure rolls everything back.
 *
 * Not covered: large objects. Any role may call lo_create, and only a
 * superuser could revoke it, so an owner can still grow the database through
 * large objects while blocked. Identifiers are validated by the caller.
 *
 * Rule actions run with the table owner's rights, and a security-definer
 * trigger function runs as its owner, so either would let an owner's DELETE
 * write as the holder. While blocked, every enabled user trigger and rule on
 * the owner's tables is disabled; the caller records which ones first, and the
 * restore re-enables exactly those in their recorded mode, never one the owner
 * had disabled. Event triggers need a superuser to create, so an owner has none.
 *
 * Row security: a table owner bypasses its table's row-level security unless
 * it is forced, so once ownership moves, an unforced row-secured table would
 * show the owner no rows and refuse its deletes, and the owner could no
 * longer change its policies. The block records those tables and disables row
 * security on them, so the owner keeps the same read and delete access it had;
 * the restore re-enables exactly those. Forced tables already applied their
 * policies to the owner and keep them.
 */

export interface WriteBlockNames {
  databaseSql: string;
  ownerSql: string;
  holderSql: string;
  ownerName: string;
  holderName: string;
}

/** A trigger, rule, or table row security the block disabled, with the enabled mode to restore ('E' for row security). */
export interface DisabledByBlock {
  kind: 'trigger' | 'rule' | 'rls';
  oid: number;
  mode: 'O' | 'R' | 'A' | 'E';
}

const SESSION_LIMITS = ["SET lock_timeout = '5s'", "SET statement_timeout = '30s'"];
const MAX_OID = 4_294_967_295;

/**
 * Enabled user triggers and rules, and unforced row security, on tables the
 * owner or the holder owns; recorded before the block disables them.
 */
export function enabledTriggersAndRules(names: WriteBlockNames): string {
  const owners = `ARRAY['${names.ownerName}'::regrole, '${names.holderName}'::regrole]`;
  return `SELECT 'trigger' AS kind, t.oid::bigint AS oid, t.tgenabled::text AS mode
  FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid
  WHERE NOT t.tgisinternal AND t.tgenabled <> 'D' AND c.relkind IN ('r', 'p', 'f') AND c.relowner = ANY(${owners})
UNION ALL SELECT 'rule', w.oid::bigint, w.ev_enabled::text
  FROM pg_rewrite w JOIN pg_class c ON c.oid = w.ev_class
  WHERE w.rulename <> '_RETURN' AND w.ev_enabled <> 'D' AND c.relkind IN ('r', 'p', 'f') AND c.relowner = ANY(${owners})
UNION ALL SELECT 'rls', c.oid::bigint, 'E'
  FROM pg_class c
  WHERE c.relkind IN ('r', 'p') AND c.relrowsecurity AND NOT c.relforcerowsecurity AND c.relowner = ANY(${owners})`;
}

function oids(disabled: readonly DisabledByBlock[], kind: DisabledByBlock['kind']): string {
  const list = disabled.filter((entry) => entry.kind === kind).map((entry) => {
    if (!Number.isSafeInteger(entry.oid) || entry.oid < 1 || entry.oid > MAX_OID) throw new Error('Invalid recorded object id');
    return String(entry.oid);
  });
  return `ARRAY[${list.join(', ')}]::oid[]`;
}

function modes(disabled: readonly DisabledByBlock[], kind: DisabledByBlock['kind']): string {
  const list = disabled.filter((entry) => entry.kind === kind).map((entry) => {
    if (!(kind === 'rls' ? ['E'] : ['O', 'R', 'A']).includes(entry.mode)) throw new Error('Invalid recorded trigger mode');
    return `'${entry.mode}'`;
  });
  return `ARRAY[${list.join(', ')}]::text[]`;
}

/** Disables the recorded triggers and rules that are still enabled on holder-owned tables. */
function disableRecorded(holder: string, disabled: readonly DisabledByBlock[]): string {
  return `DO $block$
DECLARE r record;
BEGIN
  FOR r IN SELECT t.tgrelid::regclass AS rel, t.tgname AS name FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid
    WHERE t.oid = ANY(${oids(disabled, 'trigger')}) AND t.tgenabled <> 'D' AND c.relowner = '${holder}'::regrole LOOP
    EXECUTE format('ALTER TABLE %s DISABLE TRIGGER %I', r.rel, r.name);
  END LOOP;
  FOR r IN SELECT w.ev_class::regclass AS rel, w.rulename AS name FROM pg_rewrite w JOIN pg_class c ON c.oid = w.ev_class
    WHERE w.oid = ANY(${oids(disabled, 'rule')}) AND w.ev_enabled <> 'D' AND c.relowner = '${holder}'::regrole LOOP
    EXECUTE format('ALTER TABLE %s DISABLE RULE %I', r.rel, r.name);
  END LOOP;
  FOR r IN SELECT c.oid::regclass AS rel FROM pg_class c
    WHERE c.oid = ANY(${oids(disabled, 'rls')}) AND c.relrowsecurity AND c.relowner = '${holder}'::regrole LOOP
    EXECUTE format('ALTER TABLE %s DISABLE ROW LEVEL SECURITY', r.rel);
  END LOOP;
END
$block$`;
}

/** Re-enables the recorded triggers and rules in their recorded mode. */
function enableRecorded(disabled: readonly DisabledByBlock[]): string {
  const mode = `CASE r.mode WHEN 'R' THEN 'REPLICA ' WHEN 'A' THEN 'ALWAYS ' ELSE '' END`;
  return `DO $block$
DECLARE r record;
BEGIN
  FOR r IN SELECT t.tgrelid::regclass AS rel, t.tgname AS name, x.mode
    FROM unnest(${oids(disabled, 'trigger')}, ${modes(disabled, 'trigger')}) AS x(oid, mode)
    JOIN pg_trigger t ON t.oid = x.oid WHERE t.tgenabled = 'D' LOOP
    EXECUTE format('ALTER TABLE %s ENABLE %sTRIGGER %I', r.rel, ${mode}, r.name);
  END LOOP;
  FOR r IN SELECT w.ev_class::regclass AS rel, w.rulename AS name, x.mode
    FROM unnest(${oids(disabled, 'rule')}, ${modes(disabled, 'rule')}) AS x(oid, mode)
    JOIN pg_rewrite w ON w.oid = x.oid WHERE w.ev_enabled = 'D' LOOP
    EXECUTE format('ALTER TABLE %s ENABLE %sRULE %I', r.rel, ${mode}, r.name);
  END LOOP;
  FOR r IN SELECT c.oid::regclass AS rel FROM unnest(${oids(disabled, 'rls')}) AS x(oid)
    JOIN pg_class c ON c.oid = x.oid WHERE NOT c.relrowsecurity LOOP
    EXECUTE format('ALTER TABLE %s ENABLE ROW LEVEL SECURITY', r.rel);
  END LOOP;
END
$block$`;
}

function withMemberships(names: WriteBlockNames, body: string[]): string[] {
  return [
    ...SESSION_LIMITS,
    'BEGIN',
    `GRANT ${names.ownerSql} TO CURRENT_USER WITH INHERIT TRUE, SET TRUE`,
    `GRANT ${names.holderSql} TO CURRENT_USER WITH INHERIT TRUE, SET TRUE`,
    ...body,
    `REVOKE ${names.ownerSql} FROM CURRENT_USER`,
    `REVOKE ${names.holderSql} FROM CURRENT_USER`,
    'COMMIT',
  ];
}

/**
 * Revokes everything the owner role and PUBLIC hold on the holder's objects
 * (column grants go with the table grant), then grants back exactly the
 * allowed set, so a grant made since the last application never survives it.
 */
function regrantExactly(owner: string, holder: string): string {
  return `DO $block$
DECLARE r record;
BEGIN
  FOR r IN SELECT nspname FROM pg_namespace WHERE nspowner = '${holder}'::regrole OR nspname = 'public' LOOP
    EXECUTE format('REVOKE ALL ON SCHEMA %I FROM PUBLIC, %I', r.nspname, '${owner}');
    EXECUTE format('GRANT USAGE ON SCHEMA %I TO %I', r.nspname, '${owner}');
  END LOOP;
  FOR r IN SELECT c.oid::regclass AS rel, c.relkind FROM pg_class c
    WHERE c.relowner = '${holder}'::regrole AND c.relkind IN ('r', 'p', 'v', 'm', 'f', 'S') LOOP
    IF r.relkind = 'S' THEN
      EXECUTE format('REVOKE ALL ON SEQUENCE %s FROM PUBLIC, %I', r.rel, '${owner}');
      EXECUTE format('GRANT SELECT ON SEQUENCE %s TO %I', r.rel, '${owner}');
    ELSE
      EXECUTE format('REVOKE ALL ON TABLE %s FROM PUBLIC, %I', r.rel, '${owner}');
      EXECUTE format('GRANT %s ON TABLE %s TO %I',
        CASE WHEN r.relkind IN ('r', 'p') THEN 'SELECT, DELETE, TRUNCATE' ELSE 'SELECT' END, r.rel, '${owner}');
    END IF;
  END LOOP;
  FOR r IN SELECT p.oid::regprocedure AS fn, p.prosecdef FROM pg_proc p WHERE p.proowner = '${holder}'::regrole LOOP
    EXECUTE format('REVOKE ALL ON ROUTINE %s FROM PUBLIC, %I', r.fn, '${owner}');
    IF NOT r.prosecdef THEN
      EXECUTE format('GRANT EXECUTE ON ROUTINE %s TO %I', r.fn, '${owner}');
    END IF;
  END LOOP;
END
$block$`;
}

/** Idempotent: re-running it while blocked also catches anything granted since. */
/**
 * Blocks writes. Inside the one transaction, REASSIGN OWNED holds every moved
 * table locked until commit and the owner loses the rights to add triggers,
 * so any trigger or rule still enabled after the recorded ones are disabled
 * was added after the caller's read: it is captured and disabled there too.
 * The statements' last result lists those late ones for the caller to record;
 * if that recording never happens they stay disabled, which fails safe.
 */
export function writeBlockStatements(names: WriteBlockNames, recorded: readonly DisabledByBlock[]): string[] {
  return [...withMemberships(names, [
    `REVOKE CREATE ON DATABASE ${names.databaseSql} FROM ${names.ownerSql}`,
    `REVOKE CREATE ON SCHEMA public FROM ${names.ownerSql}`,
    `GRANT CREATE ON DATABASE ${names.databaseSql} TO ${names.holderSql}`,
    `GRANT USAGE, CREATE ON SCHEMA public TO ${names.holderSql}`,
    `REASSIGN OWNED BY ${names.ownerSql} TO ${names.holderSql}`,
    regrantExactly(names.ownerName, names.holderName),
    disableRecorded(names.holderName, recorded),
    `CREATE TEMP TABLE matrix_block_late AS ${enabledTriggersAndRules(names)}`,
    disableLate(),
  ]), 'SELECT kind, oid, mode FROM matrix_block_late'];
}

/** Disables what the block captured in `matrix_block_late`. */
function disableLate(): string {
  return `DO $block$
DECLARE r record;
BEGIN
  FOR r IN SELECT t.tgrelid::regclass AS rel, t.tgname AS name FROM matrix_block_late l
    JOIN pg_trigger t ON l.kind = 'trigger' AND t.oid = l.oid::oid LOOP
    EXECUTE format('ALTER TABLE %s DISABLE TRIGGER %I', r.rel, r.name);
  END LOOP;
  FOR r IN SELECT w.ev_class::regclass AS rel, w.rulename AS name FROM matrix_block_late l
    JOIN pg_rewrite w ON l.kind = 'rule' AND w.oid = l.oid::oid LOOP
    EXECUTE format('ALTER TABLE %s DISABLE RULE %I', r.rel, r.name);
  END LOOP;
  FOR r IN SELECT c.oid::regclass AS rel FROM matrix_block_late l
    JOIN pg_class c ON l.kind = 'rls' AND c.oid = l.oid::oid LOOP
    EXECUTE format('ALTER TABLE %s DISABLE ROW LEVEL SECURITY', r.rel);
  END LOOP;
END
$block$`;
}

export function writeRestoreStatements(names: WriteBlockNames, recorded: readonly DisabledByBlock[]): string[] {
  return withMemberships(names, [
    enableRecorded(recorded),
    `GRANT CREATE ON DATABASE ${names.databaseSql} TO ${names.ownerSql}`,
    `GRANT USAGE, CREATE ON SCHEMA public TO ${names.ownerSql}`,
    `REASSIGN OWNED BY ${names.holderSql} TO ${names.ownerSql}`,
    `REVOKE CREATE ON DATABASE ${names.databaseSql} FROM ${names.holderSql}`,
    `REVOKE ALL ON SCHEMA public FROM ${names.holderSql}`,
  ]);
}
