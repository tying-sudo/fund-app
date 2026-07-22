BEGIN;

CREATE TABLE IF NOT EXISTS market_data.sector_quote_latest (
  sector_code text PRIMARY KEY,
  sector_type text NOT NULL CHECK (sector_type IN ('industry', 'concept')),
  classification text NOT NULL CHECK (classification IN ('shenwan_l3', 'eastmoney_concept')),
  name text NOT NULL,
  change_percent numeric(12,6),
  net_inflow numeric(24,2),
  quote_time timestamptz NOT NULL,
  source text NOT NULL DEFAULT 'eastmoney',
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS sector_quote_latest_type_time_idx
  ON market_data.sector_quote_latest (sector_type, quote_time DESC);

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'fund_market_app') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE ON market_data.sector_quote_latest TO fund_market_app;
  END IF;
END
$$;

COMMIT;
