BEGIN;

CREATE TABLE IF NOT EXISTS market_data.fund_nav_history_cache (
  fund_code text PRIMARY KEY CHECK (fund_code ~ '^[0-9]{6}$'),
  payload jsonb NOT NULL,
  source text NOT NULL,
  source_updated_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS market_data.fund_performance_cache (
  fund_code text NOT NULL CHECK (fund_code ~ '^[0-9]{6}$'),
  range_key text NOT NULL CHECK (range_key IN ('y', '3y', '6y')),
  points jsonb NOT NULL,
  source text NOT NULL,
  source_updated_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (fund_code, range_key)
);

CREATE TABLE IF NOT EXISTS market_data.fund_intraday_curve (
  fund_code text NOT NULL CHECK (fund_code ~ '^[0-9]{6}$'),
  trading_date date NOT NULL,
  market text NOT NULL DEFAULT 'cn',
  points jsonb NOT NULL DEFAULT '[]'::jsonb,
  is_final boolean NOT NULL DEFAULT false,
  source text NOT NULL DEFAULT 'realtime_estimate',
  last_point_at timestamptz,
  finalized_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (fund_code, trading_date)
);

CREATE INDEX IF NOT EXISTS fund_performance_cache_updated_idx
  ON market_data.fund_performance_cache (updated_at ASC);
CREATE INDEX IF NOT EXISTS fund_intraday_curve_latest_idx
  ON market_data.fund_intraday_curve (fund_code, trading_date DESC);

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'fund_market_app') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE ON market_data.fund_nav_history_cache TO fund_market_app;
    GRANT SELECT, INSERT, UPDATE, DELETE ON market_data.fund_performance_cache TO fund_market_app;
    GRANT SELECT, INSERT, UPDATE, DELETE ON market_data.fund_intraday_curve TO fund_market_app;
  END IF;
END
$$;

COMMIT;
