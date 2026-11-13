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
 */

export interface WriteBlockNames {
  databaseSql: string;
  ownerSql: string;
  holderSql: string;
  ownerName: string;
  holderName: string;
}

const SESSION_LIMITS = ["SET lock_timeout = '5s'", "SET statement_timeout = '30s'"];

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
export function writeBlockStatements(names: WriteBlockNames): string[] {
  return withMemberships(names, [
    `REVOKE CREATE ON DATABASE ${names.databaseSql} FROM ${names.ownerSql}`,
    `REVOKE CREATE ON SCHEMA public FROM ${names.ownerSql}`,
    `GRANT CREATE ON DATABASE ${names.databaseSql} TO ${names.holderSql}`,
    `GRANT USAGE, CREATE ON SCHEMA public TO ${names.holderSql}`,
    `REASSIGN OWNED BY ${names.ownerSql} TO ${names.holderSql}`,
    regrantExactly(names.ownerName, names.holderName),
  ]);
}

export function writeRestoreStatements(names: WriteBlockNames): string[] {
  return withMemberships(names, [
    `GRANT CREATE ON DATABASE ${names.databaseSql} TO ${names.ownerSql}`,
    `GRANT USAGE, CREATE ON SCHEMA public TO ${names.ownerSql}`,
    `REASSIGN OWNED BY ${names.holderSql} TO ${names.ownerSql}`,
    `REVOKE CREATE ON DATABASE ${names.databaseSql} FROM ${names.holderSql}`,
    `REVOKE ALL ON SCHEMA public FROM ${names.holderSql}`,
  ]);
}
