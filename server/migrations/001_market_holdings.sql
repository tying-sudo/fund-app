BEGIN;

CREATE SCHEMA IF NOT EXISTS market_data;

CREATE TABLE IF NOT EXISTS market_data.fund (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  code text NOT NULL UNIQUE CHECK (code ~ '^[0-9]{6}$'),
  name text NOT NULL DEFAULT '',
  fund_type text NOT NULL DEFAULT '',
  pinyin text NOT NULL DEFAULT '',
  full_pinyin text NOT NULL DEFAULT '',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS market_data.security (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  market_prefix text NOT NULL,
  market text NOT NULL CHECK (market IN ('cn', 'hk', 'us', 'global', 'unknown')),
  symbol text NOT NULL,
  name text NOT NULL DEFAULT '',
  currency text,
  provider_secid text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (market_prefix, symbol),
  UNIQUE (provider_secid)
);

ALTER TABLE market_data.security DROP CONSTRAINT IF EXISTS security_market_check;
ALTER TABLE market_data.security
  ADD CONSTRAINT security_market_check CHECK (market IN ('cn', 'hk', 'us', 'kr', 'jp', 'global', 'unknown'));

CREATE TABLE IF NOT EXISTS market_data.fund_report (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  fund_id bigint NOT NULL REFERENCES market_data.fund(id) ON DELETE CASCADE,
  report_date date NOT NULL,
  previous_report_date date,
  source text NOT NULL,
  source_fund_code text,
  source_fund_name text,
  fetched_at timestamptz NOT NULL DEFAULT now(),
  source_payload jsonb,
  UNIQUE (fund_id, report_date)
);

CREATE TABLE IF NOT EXISTS market_data.fund_holding (
  report_id bigint NOT NULL REFERENCES market_data.fund_report(id) ON DELETE CASCADE,
  security_id bigint NOT NULL REFERENCES market_data.security(id) ON DELETE RESTRICT,
  rank smallint NOT NULL CHECK (rank > 0),
  holding_ratio numeric(10,4) NOT NULL CHECK (holding_ratio >= 0),
  holding_shares numeric(24,4),
  holding_market_value numeric(24,4),
  quarter_change numeric(10,4),
  change_type text NOT NULL DEFAULT 'unknown'
    CHECK (change_type IN ('new', 'increased', 'decreased', 'unchanged', 'unknown')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (report_id, security_id),
  UNIQUE (report_id, rank)
);

CREATE TABLE IF NOT EXISTS market_data.sector (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  sector_type text NOT NULL CHECK (sector_type IN ('industry', 'concept', 'region', 'theme')),
  name text NOT NULL,
  source text NOT NULL DEFAULT 'eastmoney',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (sector_type, name, source)
);

CREATE TABLE IF NOT EXISTS market_data.security_sector (
  security_id bigint NOT NULL REFERENCES market_data.security(id) ON DELETE CASCADE,
  sector_id bigint NOT NULL REFERENCES market_data.sector(id) ON DELETE CASCADE,
  is_primary boolean NOT NULL DEFAULT false,
  valid_from date NOT NULL DEFAULT CURRENT_DATE,
  valid_to date,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (security_id, sector_id, valid_from)
);

CREATE TABLE IF NOT EXISTS market_data.security_quote_latest (
  security_id bigint PRIMARY KEY REFERENCES market_data.security(id) ON DELETE CASCADE,
  price numeric(24,8),
  change_amount numeric(24,8),
  change_percent numeric(12,6),
  quote_time timestamptz NOT NULL,
  source text NOT NULL DEFAULT 'eastmoney',
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS market_data.fund_sector_exposure (
  report_id bigint NOT NULL REFERENCES market_data.fund_report(id) ON DELETE CASCADE,
  sector_id bigint NOT NULL REFERENCES market_data.sector(id) ON DELETE CASCADE,
  exposure_ratio numeric(12,4) NOT NULL,
  holding_count integer NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (report_id, sector_id)
);

CREATE TABLE IF NOT EXISTS market_data.fund_underlying_relation (
  fund_id bigint NOT NULL REFERENCES market_data.fund(id) ON DELETE CASCADE,
  target_fund_code text NOT NULL,
  target_fund_name text NOT NULL DEFAULT '',
  relation_type text NOT NULL DEFAULT 'linked_etf',
  source text NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (fund_id, target_fund_code, relation_type)
);

CREATE TABLE IF NOT EXISTS market_data.fund_sync_state (
  fund_id bigint PRIMARY KEY REFERENCES market_data.fund(id) ON DELETE CASCADE,
  status text NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'running', 'success', 'empty', 'failed')),
  last_attempt_at timestamptz,
  last_success_at timestamptz,
  next_sync_at timestamptz,
  report_date date,
  error text,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS market_data.sync_job (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  kind text NOT NULL,
  status text NOT NULL CHECK (status IN ('running', 'success', 'partial', 'failed')),
  total_count integer NOT NULL DEFAULT 0,
  processed_count integer NOT NULL DEFAULT 0,
  success_count integer NOT NULL DEFAULT 0,
  empty_count integer NOT NULL DEFAULT 0,
  failed_count integer NOT NULL DEFAULT 0,
  started_at timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz,
  error text
);

CREATE INDEX IF NOT EXISTS fund_report_latest_idx
  ON market_data.fund_report (fund_id, report_date DESC);
CREATE INDEX IF NOT EXISTS fund_holding_security_idx
  ON market_data.fund_holding (security_id, report_id);
CREATE INDEX IF NOT EXISTS fund_holding_rank_idx
  ON market_data.fund_holding (report_id, rank);
CREATE INDEX IF NOT EXISTS security_quote_oldest_idx
  ON market_data.security_quote_latest (quote_time ASC);
CREATE INDEX IF NOT EXISTS security_sector_current_idx
  ON market_data.security_sector (security_id, is_primary DESC) WHERE valid_to IS NULL;
CREATE INDEX IF NOT EXISTS fund_sync_due_idx
  ON market_data.fund_sync_state (next_sync_at, status);
CREATE INDEX IF NOT EXISTS sync_job_started_idx
  ON market_data.sync_job (started_at DESC);

CREATE OR REPLACE FUNCTION market_data.refresh_report_sector_exposure(p_report_ids bigint[])
RETURNS void
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = market_data, pg_temp
AS $$
BEGIN
  DELETE FROM fund_sector_exposure WHERE report_id = ANY (p_report_ids);

  INSERT INTO fund_sector_exposure (report_id, sector_id, exposure_ratio, holding_count, updated_at)
  SELECT
    fh.report_id,
    ss.sector_id,
    round(sum(fh.holding_ratio)::numeric, 4),
    count(*)::integer,
    now()
  FROM fund_holding fh
  JOIN security_sector ss
    ON ss.security_id = fh.security_id
   AND ss.valid_to IS NULL
  WHERE fh.report_id = ANY (p_report_ids)
  GROUP BY fh.report_id, ss.sector_id;
END;
$$;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'fund_market_app') THEN
    GRANT USAGE ON SCHEMA market_data TO fund_market_app;
    GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA market_data TO fund_market_app;
    GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA market_data TO fund_market_app;
    GRANT EXECUTE ON FUNCTION market_data.refresh_report_sector_exposure(bigint[]) TO fund_market_app;
    ALTER DEFAULT PRIVILEGES IN SCHEMA market_data
      GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO fund_market_app;
    ALTER DEFAULT PRIVILEGES IN SCHEMA market_data
      GRANT USAGE, SELECT ON SEQUENCES TO fund_market_app;
  END IF;
END
$$;

REVOKE ALL ON SCHEMA market_data FROM PUBLIC;

COMMIT;
