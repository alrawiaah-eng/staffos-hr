CREATE TABLE IF NOT EXISTS schema_migrations(version integer PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE IF NOT EXISTS roles(code text PRIMARY KEY, label text NOT NULL, permissions jsonb NOT NULL DEFAULT '[]');
CREATE TABLE IF NOT EXISTS departments(id serial PRIMARY KEY, name text NOT NULL UNIQUE, manager_id integer);
CREATE TABLE IF NOT EXISTS employees(
 id serial PRIMARY KEY, employee_no text NOT NULL UNIQUE, name text NOT NULL, department_id integer NOT NULL REFERENCES departments(id),
 job_title text NOT NULL, location text NOT NULL DEFAULT 'بغداد', joined_on date NOT NULL DEFAULT current_date,
 status text NOT NULL DEFAULT 'ACTIVE' CHECK(status IN ('ACTIVE','INACTIVE')), contract_type text NOT NULL DEFAULT 'دائم', contract_end date,
 salary numeric(14,2) NOT NULL DEFAULT 0 CHECK(salary>=0), employment_details jsonb NOT NULL DEFAULT '{}', personal jsonb NOT NULL DEFAULT '{}',
 education jsonb NOT NULL DEFAULT '[]', employment_history jsonb NOT NULL DEFAULT '[]', created_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE employees ADD COLUMN IF NOT EXISTS employment_details jsonb NOT NULL DEFAULT '{}';
CREATE TABLE IF NOT EXISTS users(
 id serial PRIMARY KEY, username text NOT NULL UNIQUE, password_hash text NOT NULL, employee_id integer NOT NULL UNIQUE REFERENCES employees(id),
 role text NOT NULL REFERENCES roles(code), active boolean NOT NULL DEFAULT true, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS sessions(token_hash text PRIMARY KEY, user_id integer NOT NULL REFERENCES users(id) ON DELETE CASCADE, csrf text NOT NULL, expires_at timestamptz NOT NULL);
CREATE TABLE IF NOT EXISTS leave_types(code text PRIMARY KEY, label text NOT NULL, deducts boolean NOT NULL, director_required boolean NOT NULL DEFAULT false);
CREATE TABLE IF NOT EXISTS leave_balances(employee_id integer NOT NULL REFERENCES employees(id), year integer NOT NULL, entitlement integer NOT NULL DEFAULT 30 CHECK(entitlement>=0), used integer NOT NULL DEFAULT 0 CHECK(used>=0 AND used<=entitlement), PRIMARY KEY(employee_id,year));
CREATE TABLE IF NOT EXISTS leave_requests(
 id serial PRIMARY KEY, employee_id integer NOT NULL REFERENCES employees(id), type text NOT NULL REFERENCES leave_types(code), start_date date NOT NULL, end_date date NOT NULL,
 days integer NOT NULL CHECK(days>0), reason text NOT NULL, status text NOT NULL CHECK(status IN ('MANAGER','HR','DIRECTOR','APPROVED','REJECTED','CANCELLED')),
 director_required boolean NOT NULL, created_at timestamptz NOT NULL DEFAULT now(), CHECK(end_date>=start_date)
);
CREATE INDEX IF NOT EXISTS leave_employee_dates ON leave_requests(employee_id,start_date,end_date);
CREATE TABLE IF NOT EXISTS leave_approvals(id serial PRIMARY KEY, leave_id integer NOT NULL REFERENCES leave_requests(id), actor_id integer NOT NULL REFERENCES users(id), stage text NOT NULL, decision text NOT NULL, comment text NOT NULL DEFAULT '', created_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE IF NOT EXISTS profile_changes(id serial PRIMARY KEY, employee_id integer NOT NULL REFERENCES employees(id), proposed jsonb NOT NULL, previous jsonb NOT NULL, status text NOT NULL DEFAULT 'PENDING' CHECK(status IN ('PENDING','APPROVED','REJECTED')), reviewer_id integer REFERENCES users(id), comment text NOT NULL DEFAULT '', created_at timestamptz NOT NULL DEFAULT now());
CREATE UNIQUE INDEX IF NOT EXISTS one_pending_profile ON profile_changes(employee_id) WHERE status='PENDING';
CREATE TABLE IF NOT EXISTS documents(
 id serial PRIMARY KEY, employee_id integer NOT NULL REFERENCES employees(id), kind text NOT NULL CHECK(kind IN ('IDENTITY','RESIDENCE','CLEARANCE','PASSPORT','DRIVING')),
 number text NOT NULL DEFAULT '', expires_on date, status text NOT NULL DEFAULT 'PENDING' CHECK(status IN ('PENDING','APPROVED','REJECTED')),
 front_data bytea NOT NULL, front_mime text NOT NULL, back_data bytea, back_mime text, reviewer_id integer REFERENCES users(id), comment text NOT NULL DEFAULT '', created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS records(
 id serial PRIMARY KEY, employee_id integer NOT NULL REFERENCES employees(id), kind text NOT NULL CHECK(kind IN ('TRAINING','THANKS','AWARD')), title text NOT NULL,
 issuer text NOT NULL, date date NOT NULL, notes text NOT NULL DEFAULT '', attachment bytea, attachment_mime text, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS notifications(id serial PRIMARY KEY, user_id integer NOT NULL REFERENCES users(id), title text NOT NULL, body text NOT NULL, link text NOT NULL DEFAULT '/dashboard', read_at timestamptz, dedupe_key text UNIQUE, created_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE IF NOT EXISTS audit_logs(id serial PRIMARY KEY, actor_id integer REFERENCES users(id), action text NOT NULL, entity text NOT NULL, entity_id text NOT NULL, before_data jsonb, after_data jsonb, created_at timestamptz NOT NULL DEFAULT now());
CREATE INDEX IF NOT EXISTS notifications_user ON notifications(user_id,created_at DESC);
CREATE INDEX IF NOT EXISTS audit_time ON audit_logs(created_at DESC);
DO $$ BEGIN
 IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='department_manager_fk') THEN
  ALTER TABLE departments ADD CONSTRAINT department_manager_fk FOREIGN KEY(manager_id) REFERENCES employees(id);
 END IF;
END $$;
CREATE TABLE IF NOT EXISTS employee_photos (
 id serial PRIMARY KEY, employee_id integer NOT NULL REFERENCES employees(id),
 image_data bytea NOT NULL, image_mime text NOT NULL CHECK(image_mime IN ('image/png','image/jpeg')),
 status text NOT NULL CHECK(status IN ('PENDING','APPROVED','REJECTED')),
 submitted_by integer NOT NULL REFERENCES users(id), reviewer_id integer REFERENCES users(id),
 comment text NOT NULL DEFAULT '', created_at timestamptz NOT NULL DEFAULT now(), reviewed_at timestamptz
);
CREATE UNIQUE INDEX IF NOT EXISTS one_pending_photo ON employee_photos(employee_id) WHERE status='PENDING';
INSERT INTO schema_migrations(version) VALUES(3) ON CONFLICT DO NOTHING;
CREATE OR REPLACE FUNCTION protect_audit_log() RETURNS trigger AS $$ BEGIN RAISE EXCEPTION 'Audit log is append-only'; END; $$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS audit_log_immutable ON audit_logs;
CREATE TRIGGER audit_log_immutable BEFORE UPDATE OR DELETE ON audit_logs FOR EACH ROW EXECUTE FUNCTION protect_audit_log();
INSERT INTO schema_migrations(version) VALUES(1) ON CONFLICT DO NOTHING;
DO $$ BEGIN
 IF NOT EXISTS (SELECT 1 FROM schema_migrations WHERE version=2) THEN
  UPDATE roles SET permissions=permissions || '["leave.balance"]'::jsonb WHERE code='HR_MANAGER' AND NOT (permissions ? 'leave.balance');
  INSERT INTO schema_migrations(version) VALUES(2);
 END IF;
END $$;
-- v4: rename legacy emergency_name/emergency_phone to emergency_primary_*; keeps all other keys, never overwrites an existing primary value, leaves audit_logs untouched.
CREATE OR REPLACE FUNCTION pg_temp.rename_emergency(p jsonb) RETURNS jsonb AS $f$
 SELECT (p - 'emergency_name' - 'emergency_phone') || jsonb_strip_nulls(jsonb_build_object(
  'emergency_primary_name', CASE WHEN p ? 'emergency_primary_name' THEN NULL ELSE p->'emergency_name' END,
  'emergency_primary_phone', CASE WHEN p ? 'emergency_primary_phone' THEN NULL ELSE p->'emergency_phone' END));
$f$ LANGUAGE sql IMMUTABLE;
DO $$ BEGIN
 IF NOT EXISTS (SELECT 1 FROM schema_migrations WHERE version=4) THEN
  UPDATE employees SET personal=pg_temp.rename_emergency(personal) WHERE personal ? 'emergency_name' OR personal ? 'emergency_phone';
  UPDATE profile_changes SET proposed=pg_temp.rename_emergency(proposed) WHERE proposed ? 'emergency_name' OR proposed ? 'emergency_phone';
  UPDATE profile_changes SET previous=pg_temp.rename_emergency(previous) WHERE previous ? 'emergency_name' OR previous ? 'emergency_phone';
  INSERT INTO schema_migrations(version) VALUES(4);
 END IF;
END $$;

-- v5: البديل في العمل أثناء الإجازة (Replacement if Applicable)
ALTER TABLE leave_requests ADD COLUMN IF NOT EXISTS substitute_id integer REFERENCES employees(id);
ALTER TABLE leave_requests ADD COLUMN IF NOT EXISTS substitute_note text NOT NULL DEFAULT '';
DO $$ BEGIN
 IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='leave_substitute_not_self') THEN
  ALTER TABLE leave_requests ADD CONSTRAINT leave_substitute_not_self CHECK(substitute_id IS NULL OR substitute_id<>employee_id);
 END IF;
END $$;
CREATE INDEX IF NOT EXISTS leave_substitute_idx ON leave_requests(substitute_id);
INSERT INTO schema_migrations(version) VALUES(5) ON CONFLICT DO NOTHING;
