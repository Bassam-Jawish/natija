-- Row-level security: every lab-owned table shows and accepts only rows of the lab set in
-- the transaction setting app.lab_id. The application connects as natija_app, which cannot
-- bypass row-level security. Exempt by design: labs (directory), sessions and agents
-- (looked up by token hash before the lab is known); none of them holds patient data.

CREATE OR REPLACE FUNCTION app_lab_id() RETURNS uuid
  LANGUAGE sql STABLE
  AS $$ SELECT nullif(current_setting('app.lab_id', true), '')::uuid $$;
--> statement-breakpoint
DO $$
DECLARE t record;
BEGIN
  FOR t IN
    SELECT c.table_name
    FROM information_schema.columns c
    JOIN information_schema.tables tb
      ON tb.table_schema = c.table_schema AND tb.table_name = c.table_name
    WHERE c.table_schema = 'public'
      AND c.column_name = 'lab_id'
      AND tb.table_type = 'BASE TABLE'
      AND c.table_name NOT IN ('sessions', 'agents')
  LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t.table_name);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t.table_name);
    EXECUTE format('DROP POLICY IF EXISTS lab_isolation ON %I', t.table_name);
    EXECUTE format(
      'CREATE POLICY lab_isolation ON %I USING (lab_id = app_lab_id()) WITH CHECK (lab_id = app_lab_id())',
      t.table_name
    );
  END LOOP;
END $$;
--> statement-breakpoint
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'natija_app') THEN
    BEGIN
      -- Development default; deployments create the role first with a real password.
      CREATE ROLE natija_app LOGIN NOBYPASSRLS PASSWORD 'natija_app_dev';
    EXCEPTION WHEN insufficient_privilege THEN
      -- Managed hosts without CREATEROLE: the app connects as the table owner instead.
      -- FORCE ROW LEVEL SECURITY above still applies to the owner.
      RAISE NOTICE 'natija_app role not created (no CREATEROLE privilege)';
    END;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'natija_app') THEN
    GRANT USAGE ON SCHEMA public TO natija_app;
    GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO natija_app;
    GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO natija_app;
    -- The audit log is append-only for the application.
    REVOKE UPDATE, DELETE, TRUNCATE ON audit_log FROM natija_app;
    ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO natija_app;
    ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT USAGE, SELECT ON SEQUENCES TO natija_app;
  END IF;
END $$;
--> statement-breakpoint
-- Public "is this report genuine?" check behind the QR code. Returns no results and no full name.
CREATE OR REPLACE FUNCTION public_verify_report(code text)
RETURNS TABLE (
  lab_name_ar text,
  lab_name_en text,
  lab_code text,
  order_accession text,
  report_version integer,
  released_at timestamptz,
  report_status text,
  content_hash text,
  patient_initials text,
  test_count integer,
  latest_version integer
)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public
AS $$
  SELECT l.name_ar, l.name_en, l.code, o.accession, r.version, r.released_at, r.status, r.content_hash,
         left(p.first_name_ar, 1) || '. ' || left(p.last_name_ar, 1) || '.',
         (SELECT count(*)::int FROM order_items oi WHERE oi.order_id = o.id AND oi.status = 'released'),
         (SELECT max(r2.version) FROM reports r2 WHERE r2.order_id = r.order_id)
  FROM reports r
  JOIN orders o ON o.id = r.order_id
  JOIN labs l ON l.id = r.lab_id
  JOIN patients p ON p.id = o.patient_id
  WHERE r.verify_code = upper($1)
$$;
--> statement-breakpoint
-- Patient report links: resolve a token hash to its lab and order, nothing else.
CREATE OR REPLACE FUNCTION public_resolve_report_token(hash text)
RETURNS TABLE (lab_id uuid, order_id uuid, token_id uuid, expired boolean, revoked boolean)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public
AS $$
  SELECT t.lab_id, t.order_id, t.id, t.expires_at < now(), t.revoked_at IS NOT NULL
  FROM report_tokens t
  WHERE t.token_hash = $1
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION public_verify_report(text) FROM PUBLIC;
--> statement-breakpoint
REVOKE ALL ON FUNCTION public_resolve_report_token(text) FROM PUBLIC;
--> statement-breakpoint
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'natija_app') THEN
    GRANT EXECUTE ON FUNCTION public_verify_report(text) TO natija_app;
    GRANT EXECUTE ON FUNCTION public_resolve_report_token(text) TO natija_app;
  END IF;
END $$;
