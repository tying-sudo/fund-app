import pg from 'pg'

const { Pool } = pg

let pool = null
let warnedUnavailable = false

export function isMarketDatabaseConfigured() {
  return Boolean(process.env.DATABASE_URL || (process.env.PGHOST && process.env.PGUSER && process.env.PGDATABASE))
}

function getPool() {
  if (!isMarketDatabaseConfigured()) return null
  if (!pool) {
    pool = new Pool({
      connectionString: process.env.DATABASE_URL || undefined,
      max: Math.max(1, Number(process.env.PGPOOL_MAX) || 5),
      idleTimeoutMillis: 30_000,
      connectionTimeoutMillis: 5_000,
      statement_timeout: 15_000,
      application_name: 'fund-market-data'
    })
    pool.on('error', error => console.error(`[Market DB] idle client error: ${error.message}`))
  }
  return pool
}

async function withDatabase(operation, fallback = null) {
  const activePool = getPool()
  if (!activePool) return fallback
  try {
    const value = await operation(activePool)
    warnedUnavailable = false
    return value
  } catch (error) {
    if (!warnedUnavailable) {
      console.error(`[Market DB] unavailable, using legacy cache: ${error.message}`)
      warnedUnavailable = true
    }
    return fallback
  }
}

export function marketFromPrefix(prefix) {
  const value = String(prefix || '')
  if (value === '116') return 'hk'
  if (/^10[56]$/.test(value)) return 'us'
  if (value === 'kr') return 'kr'
  if (value === 'jp') return 'jp'
  if (value === '0' || value === '1') return 'cn'
  return 'unknown'
}

export function currencyForMarket(market) {
  if (market === 'cn') return 'CNY'
  if (market === 'hk') return 'HKD'
  if (market === 'us') return 'USD'
  if (market === 'kr') return 'KRW'
  if (market === 'jp') return 'JPY'
  return null
}

export function holdingChangeType(change, hasPrevious, existedPreviously) {
  if (!hasPrevious) return 'unknown'
  if (!existedPreviously) return 'new'
  if (change > 0.0001) return 'increased'
  if (change < -0.0001) return 'decreased'
  return 'unchanged'
}

export async function checkMarketDatabase() {
  return withDatabase(async activePool => {
    const result = await activePool.query(`
      SELECT
        current_database() AS database,
        current_user AS user_name,
        to_regclass('market_data.fund_holding') IS NOT NULL AS migrated
    `)
    return { configured: true, ...result.rows[0] }
  }, { configured: false, migrated: false })
}

/**
 * The sector board is read on every market-page visit. Retaining the most
 * recent complete upstream snapshot lets a fresh proxy process respond before
 * its first Eastmoney refresh completes.
 */
export async function getStoredSectorQuotes(type) {
  const sectorType = type === 'concept' ? 'concept' : 'industry'
  return withDatabase(async activePool => {
    const result = await activePool.query(`
      SELECT sector_code, name, change_percent, net_inflow, quote_time, source, classification
      FROM market_data.sector_quote_latest
      WHERE sector_type = $1
      ORDER BY name
    `, [sectorType])
    if (!result.rowCount) return null
    return result.rows.map(row => ({
      code: row.sector_code,
      name: row.name,
      dayReturn: row.change_percent === null ? 0 : Number(row.change_percent),
      netInflow: row.net_inflow === null ? 0 : Number(row.net_inflow),
      type: sectorType,
      classification: row.classification,
      updatedAt: row.quote_time?.toISOString() || null,
      source: row.source || 'eastmoney'
    }))
  })
}

export async function storeSectorQuotes(type, sectors) {
  const sectorType = type === 'concept' ? 'concept' : 'industry'
  const classification = sectorType === 'concept' ? 'eastmoney_concept' : 'shenwan_l3'
  const rows = (Array.isArray(sectors) ? sectors : []).filter(sector => sector?.code && sector?.name)
  const activePool = getPool()
  if (!activePool || !rows.length) return 0

  const client = await activePool.connect()
  try {
    await client.query('BEGIN')
    for (let offset = 0; offset < rows.length; offset += 200) {
      const batch = rows.slice(offset, offset + 200)
      const values = []
      const placeholders = batch.map((sector, index) => {
        const base = index * 8
        values.push(
          String(sector.code),
          sectorType,
          classification,
          String(sector.name),
          Number.isFinite(Number(sector.dayReturn)) ? Number(sector.dayReturn) : null,
          Number.isFinite(Number(sector.netInflow)) ? Number(sector.netInflow) : null,
          sector.updatedAt || new Date().toISOString(),
          sector.source || 'eastmoney'
        )
        return `($${base + 1}, $${base + 2}, $${base + 3}, $${base + 4}, $${base + 5}, $${base + 6}, $${base + 7}, $${base + 8})`
      })
      await client.query(`
        INSERT INTO market_data.sector_quote_latest (
          sector_code, sector_type, classification, name, change_percent,
          net_inflow, quote_time, source
        ) VALUES ${placeholders.join(',')}
        ON CONFLICT (sector_code) DO UPDATE SET
          sector_type = EXCLUDED.sector_type,
          classification = EXCLUDED.classification,
          name = EXCLUDED.name,
          change_percent = EXCLUDED.change_percent,
          net_inflow = EXCLUDED.net_inflow,
          quote_time = EXCLUDED.quote_time,
          source = EXCLUDED.source,
          updated_at = now()
      `, values)
    }
    await client.query(`
      DELETE FROM market_data.sector_quote_latest
      WHERE sector_type = $1 AND NOT (sector_code = ANY($2::text[]))
    `, [sectorType, rows.map(sector => String(sector.code))])
    await client.query('COMMIT')
    return rows.length
  } catch (error) {
    await client.query('ROLLBACK')
    throw error
  } finally {
    client.release()
  }
}

function chartCacheRow(row, field = 'payload') {
  if (!row) return null
  return {
    ...row[field],
    cache: 'database',
    cachedAt: row.updated_at?.toISOString?.() || row.updated_at || null
  }
}

export async function getStoredFundHistory(code) {
  return withDatabase(async activePool => {
    const result = await activePool.query(`
      SELECT payload, updated_at
      FROM market_data.fund_nav_history_cache
      WHERE fund_code = $1
    `, [code])
    return chartCacheRow(result.rows[0])
  })
}

export async function storeFundHistory(code, payload) {
  const activePool = getPool()
  if (!activePool || !payload?.items?.length) return false
  await activePool.query(`
    INSERT INTO market_data.fund_nav_history_cache (
      fund_code, payload, source, source_updated_at, updated_at
    ) VALUES ($1, $2::jsonb, $3, $4, now())
    ON CONFLICT (fund_code) DO UPDATE SET
      payload = EXCLUDED.payload,
      source = EXCLUDED.source,
      source_updated_at = EXCLUDED.source_updated_at,
      updated_at = now()
  `, [code, JSON.stringify(payload), payload.source || 'eastmoney_lsjz', payload.updatedAt || null])
  return true
}

export async function getStoredFundPerformance(code, range) {
  return withDatabase(async activePool => {
    const result = await activePool.query(`
      SELECT points, source, source_updated_at, updated_at
      FROM market_data.fund_performance_cache
      WHERE fund_code = $1 AND range_key = $2
    `, [code, range])
    const row = result.rows[0]
    if (!row) return null
    return {
      code,
      range,
      points: row.points,
      source: row.source,
      sourceUpdatedAt: row.source_updated_at?.toISOString?.() || row.source_updated_at || null,
      cachedAt: row.updated_at?.toISOString?.() || row.updated_at || null,
      cache: 'database'
    }
  })
}

export async function storeFundPerformance(code, range, data) {
  const activePool = getPool()
  if (!activePool || !data?.points?.length) return false
  await activePool.query(`
    INSERT INTO market_data.fund_performance_cache (
      fund_code, range_key, points, source, source_updated_at, updated_at
    ) VALUES ($1, $2, $3::jsonb, $4, $5, now())
    ON CONFLICT (fund_code, range_key) DO UPDATE SET
      points = EXCLUDED.points,
      source = EXCLUDED.source,
      source_updated_at = EXCLUDED.source_updated_at,
      updated_at = now()
  `, [code, range, JSON.stringify(data.points), data.source || 'eastmoney_pingzhongdata', data.updatedAt || null])
  return true
}

function normalizeIntradayRow(row) {
  if (!row) return null
  return {
    code: row.fund_code,
    tradingDate: String(row.trading_date?.toISOString?.().slice(0, 10) || row.trading_date || ''),
    market: row.market,
    points: Array.isArray(row.points) ? row.points : [],
    finalized: Boolean(row.is_final),
    source: row.source,
    lastPointAt: row.last_point_at?.toISOString?.() || row.last_point_at || null,
    finalizedAt: row.finalized_at?.toISOString?.() || row.finalized_at || null,
    cachedAt: row.updated_at?.toISOString?.() || row.updated_at || null,
    cache: 'database'
  }
}

export async function getLatestStoredFundIntradayCurve(code) {
  return withDatabase(async activePool => {
    const result = await activePool.query(`
      SELECT *
      FROM market_data.fund_intraday_curve
      WHERE fund_code = $1
      ORDER BY trading_date DESC
      LIMIT 1
    `, [code])
    return normalizeIntradayRow(result.rows[0])
  })
}

export async function appendFundIntradayPoint(code, tradingDate, market, point, openingPoint = null) {
  const activePool = getPool()
  if (!activePool) return null
  const client = await activePool.connect()
  try {
    await client.query('BEGIN')
    const existingResult = await client.query(`
      SELECT *
      FROM market_data.fund_intraday_curve
      WHERE fund_code = $1 AND trading_date = $2
      FOR UPDATE
    `, [code, tradingDate])
    const existing = normalizeIntradayRow(existingResult.rows[0])
    if (existing?.finalized) {
      await client.query('COMMIT')
      return existing
    }

    const byTime = new Map((existing?.points || []).map(item => [item.time, item]))
    if (!byTime.size && openingPoint) byTime.set(openingPoint.time, openingPoint)
    byTime.set(point.time, point)
    const points = [...byTime.values()]
      .filter(item => item?.time && Number.isFinite(Number(item.value)))
      .sort((left, right) => left.time.localeCompare(right.time))
      .slice(-18_000)
    const result = await client.query(`
      INSERT INTO market_data.fund_intraday_curve (
        fund_code, trading_date, market, points, is_final, source, last_point_at, updated_at
      ) VALUES ($1, $2, $3, $4::jsonb, false, $5, $6, now())
      ON CONFLICT (fund_code, trading_date) DO UPDATE SET
        market = EXCLUDED.market,
        points = EXCLUDED.points,
        source = EXCLUDED.source,
        last_point_at = EXCLUDED.last_point_at,
        updated_at = now()
      RETURNING *
    `, [code, tradingDate, market, JSON.stringify(points), point.source || 'realtime_estimate', point.timeIso || new Date().toISOString()])
    await client.query('COMMIT')
    return normalizeIntradayRow(result.rows[0])
  } catch (error) {
    await client.query('ROLLBACK')
    throw error
  } finally {
    client.release()
  }
}

export async function finalizeFundIntradayCurve(code, tradingDate) {
  return withDatabase(async activePool => {
    const result = await activePool.query(`
      UPDATE market_data.fund_intraday_curve
      SET is_final = true, finalized_at = COALESCE(finalized_at, now()), updated_at = now()
      WHERE fund_code = $1 AND trading_date = $2
      RETURNING *
    `, [code, tradingDate])
    return normalizeIntradayRow(result.rows[0])
  })
}

export async function getStoredFundHoldings(code, { includeQuotes = false } = {}) {
  return withDatabase(async activePool => {
    const reportResult = await activePool.query(`
      SELECT
        f.code,
        f.name,
        fr.id AS report_id,
        fr.report_date,
        fr.previous_report_date,
        fr.source,
        fr.source_fund_code,
        fr.source_fund_name,
        fr.fetched_at
      FROM market_data.fund f
      JOIN LATERAL (
        SELECT *
        FROM market_data.fund_report candidate
        WHERE candidate.fund_id = f.id
        ORDER BY candidate.report_date DESC
        LIMIT 1
      ) fr ON true
      WHERE f.code = $1
    `, [code])
    if (!reportResult.rowCount) return null

    const report = reportResult.rows[0]
    const holdingResult = await activePool.query(`
      SELECT
        s.symbol AS stock_code,
        s.name AS stock_name,
        s.market_prefix,
        fh.holding_ratio,
        fh.holding_shares,
        fh.holding_market_value,
        fh.quarter_change,
        fh.change_type,
        ${includeQuotes ? 'q.price, q.change_percent AS day_change, q.quote_time,' : 'NULL::numeric AS price, NULL::numeric AS day_change, NULL::timestamptz AS quote_time,'}
        sector.name AS sector
      FROM market_data.fund_holding fh
      JOIN market_data.security s ON s.id = fh.security_id
      ${includeQuotes ? 'LEFT JOIN market_data.security_quote_latest q ON q.security_id = s.id' : ''}
      LEFT JOIN LATERAL (
        SELECT sec.name
        FROM market_data.security_sector ss
        JOIN market_data.sector sec ON sec.id = ss.sector_id
        WHERE ss.security_id = s.id AND ss.valid_to IS NULL
        ORDER BY ss.is_primary DESC, sec.sector_type, sec.name
        LIMIT 1
      ) sector ON true
      WHERE fh.report_id = $1
      ORDER BY fh.rank
    `, [report.report_id])

    return {
      code: report.code,
      name: report.name,
      reportDate: report.report_date?.toISOString().slice(0, 10) || null,
      previousReportDate: report.previous_report_date?.toISOString().slice(0, 10) || null,
      source: report.source,
      targetCode: report.source_fund_code || null,
      targetName: report.source_fund_name || null,
      updatedAt: report.fetched_at?.toISOString() || null,
      cache: 'database',
      stale: false,
      holdings: holdingResult.rows.map(row => ({
        fundCode: report.code,
        stockCode: row.stock_code,
        stockName: row.stock_name,
        marketPrefix: row.market_prefix,
        holdingRatio: Number(row.holding_ratio),
        holdingShares: row.holding_shares === null ? null : Number(row.holding_shares),
        holdingMarketValue: row.holding_market_value === null ? null : Number(row.holding_market_value),
        reportDate: report.report_date?.toISOString().slice(0, 10) || null,
        quarterChange: row.quarter_change === null ? null : Number(row.quarter_change),
        changeType: row.change_type,
        dayChange: row.day_change === null ? null : Number(row.day_change),
        price: row.price === null ? null : Number(row.price),
        quoteTime: row.quote_time?.toISOString() || null,
        sector: row.sector || null
      }))
    }
  })
}

export async function upsertFundUniverse(funds) {
  const activePool = getPool()
  if (!activePool || !Array.isArray(funds) || !funds.length) return 0
  const client = await activePool.connect()
  try {
    await client.query('BEGIN')
    for (let index = 0; index < funds.length; index += 500) {
      const batch = funds.slice(index, index + 500)
      const values = []
      const placeholders = batch.map((fund, rowIndex) => {
        const offset = rowIndex * 5
        values.push(String(fund.code), String(fund.name || ''), String(fund.type || ''), String(fund.pinyin || ''), String(fund.fullPinyin || ''))
        return `($${offset + 1}, $${offset + 2}, $${offset + 3}, $${offset + 4}, $${offset + 5})`
      })
      await client.query(`
        INSERT INTO market_data.fund (code, name, fund_type, pinyin, full_pinyin)
        VALUES ${placeholders.join(',')}
        ON CONFLICT (code) DO UPDATE SET
          name = EXCLUDED.name,
          fund_type = EXCLUDED.fund_type,
          pinyin = EXCLUDED.pinyin,
          full_pinyin = EXCLUDED.full_pinyin,
          updated_at = now()
      `, values)
    }
    await client.query(`
      INSERT INTO market_data.fund_sync_state (fund_id, status, next_sync_at)
      SELECT id, 'pending', now()
      FROM market_data.fund
      ON CONFLICT (fund_id) DO NOTHING
    `)
    await client.query('COMMIT')
    return funds.length
  } catch (error) {
    await client.query('ROLLBACK')
    throw error
  } finally {
    client.release()
  }
}

async function upsertSecurity(client, holding) {
  const market = marketFromPrefix(holding.marketPrefix)
  const result = await client.query(`
    INSERT INTO market_data.security (
      market_prefix, market, symbol, name, currency, provider_secid
    ) VALUES ($1, $2, $3, $4, $5, $6)
    ON CONFLICT (market_prefix, symbol) DO UPDATE SET
      name = CASE WHEN EXCLUDED.name <> '' THEN EXCLUDED.name ELSE market_data.security.name END,
      provider_secid = EXCLUDED.provider_secid,
      currency = EXCLUDED.currency,
      updated_at = now()
    RETURNING id
  `, [
    String(holding.marketPrefix || ''),
    market,
    String(holding.stockCode || ''),
    String(holding.stockName || ''),
    currencyForMarket(market),
    `${holding.marketPrefix}.${holding.stockCode}`
  ])
  return result.rows[0].id
}

function securityKey(holding) {
  return `${String(holding.marketPrefix || '')}.${String(holding.stockCode || '')}`
}

function normalizeSnapshotHoldings(holdings) {
  const bySecurity = new Map()
  for (const holding of holdings || []) {
    const key = securityKey(holding)
    if (key === '.') continue
    const existing = bySecurity.get(key)
    if (!existing || Number(holding.holdingRatio) > Number(existing.holdingRatio)) {
      bySecurity.set(key, holding)
    }
  }
  return [...bySecurity.values()].sort((left, right) => {
    const ratioDelta = Number(right.holdingRatio) - Number(left.holdingRatio)
    return ratioDelta || securityKey(left).localeCompare(securityKey(right))
  })
}

export async function storeFundHoldingSnapshots({ fund, current, previous = null }) {
  const activePool = getPool()
  if (!activePool) return false
  const client = await activePool.connect()
  try {
    await client.query('BEGIN')
    const fundResult = await client.query(`
      INSERT INTO market_data.fund (code, name, fund_type, pinyin, full_pinyin)
      VALUES ($1, $2, $3, $4, $5)
      ON CONFLICT (code) DO UPDATE SET
        name = EXCLUDED.name,
        fund_type = EXCLUDED.fund_type,
        pinyin = EXCLUDED.pinyin,
        full_pinyin = EXCLUDED.full_pinyin,
        updated_at = now()
      RETURNING id
    `, [fund.code, fund.name || current.name || '', fund.type || '', fund.pinyin || '', fund.fullPinyin || ''])
    const fundId = fundResult.rows[0].id

    const snapshots = [previous, current]
      .filter(snapshot => snapshot?.reportDate && Array.isArray(snapshot.holdings) && snapshot.holdings.length)
      .map(snapshot => ({ ...snapshot, holdings: normalizeSnapshotHoldings(snapshot.holdings) }))

    // Every concurrent fund sync now takes shared security row locks in the
    // same order. The former per-fund rank order could deadlock when funds
    // held the same stocks in different weight order.
    const securityIds = new Map()
    const securities = new Map()
    for (const snapshot of snapshots) {
      for (const holding of snapshot.holdings) {
        const key = securityKey(holding)
        if (!securities.has(key)) securities.set(key, holding)
      }
    }
    for (const [key, holding] of [...securities.entries()].sort(([left], [right]) => left.localeCompare(right))) {
      securityIds.set(key, await upsertSecurity(client, holding))
    }

    for (const snapshot of snapshots) {
      const reportResult = await client.query(`
        INSERT INTO market_data.fund_report (
          fund_id, report_date, previous_report_date, source,
          source_fund_code, source_fund_name, fetched_at
        ) VALUES ($1, $2, $3, $4, $5, $6, now())
        ON CONFLICT (fund_id, report_date) DO UPDATE SET
          previous_report_date = EXCLUDED.previous_report_date,
          source = EXCLUDED.source,
          source_fund_code = EXCLUDED.source_fund_code,
          source_fund_name = EXCLUDED.source_fund_name,
          fetched_at = now()
        RETURNING id
      `, [
        fundId,
        snapshot.reportDate,
        snapshot.previousReportDate || null,
        snapshot.source || 'eastmoney_f10',
        snapshot.targetCode || null,
        snapshot.targetName || null
      ])
      const reportId = reportResult.rows[0].id
      await client.query('DELETE FROM market_data.fund_holding WHERE report_id = $1', [reportId])

      for (let index = 0; index < snapshot.holdings.length; index++) {
        const holding = snapshot.holdings[index]
        const securityId = securityIds.get(securityKey(holding))
        await client.query(`
          INSERT INTO market_data.fund_holding (
            report_id, security_id, rank, holding_ratio, holding_shares,
            holding_market_value, quarter_change, change_type
          ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
        `, [
          reportId,
          securityId,
          index + 1,
          holding.holdingRatio,
          holding.holdingShares ?? null,
          holding.holdingMarketValue ?? null,
          holding.quarterChange ?? null,
          holding.changeType || 'unknown'
        ])
      }
    }

    if (current.targetCode) {
      await client.query(`
        INSERT INTO market_data.fund_underlying_relation (
          fund_id, target_fund_code, target_fund_name, relation_type, source
        ) VALUES ($1, $2, $3, 'linked_etf', $4)
        ON CONFLICT (fund_id, target_fund_code, relation_type) DO UPDATE SET
          target_fund_name = EXCLUDED.target_fund_name,
          source = EXCLUDED.source,
          updated_at = now()
      `, [fundId, current.targetCode, current.targetName || '', current.source || 'eastmoney_f10_linked_etf'])
    }

    await client.query('COMMIT')
    return true
  } catch (error) {
    await client.query('ROLLBACK')
    throw error
  } finally {
    client.release()
  }
}

export async function getDueFundCodes({ force = false } = {}) {
  const activePool = getPool()
  if (!activePool) return []
  const result = await activePool.query(`
    SELECT f.code
    FROM market_data.fund f
    JOIN market_data.fund_sync_state state ON state.fund_id = f.id
    WHERE $1::boolean
       OR state.next_sync_at IS NULL
       OR state.next_sync_at <= now()
       OR state.status IN ('pending', 'failed', 'running')
    ORDER BY
      CASE state.status WHEN 'failed' THEN 0 WHEN 'pending' THEN 1 ELSE 2 END,
      state.last_attempt_at NULLS FIRST,
      f.code
  `, [force])
  return result.rows.map(row => row.code)
}

export async function markFundSync(code, { status, reportDate = null, error = null } = {}) {
  const activePool = getPool()
  if (!activePool) return
  const success = status === 'success' || status === 'empty'
  const interval = status === 'empty' ? '30 days' : status === 'success' ? '7 days' : '1 day'
  await activePool.query(`
    UPDATE market_data.fund_sync_state state
    SET
      status = $2,
      last_attempt_at = now(),
      last_success_at = CASE WHEN $3 THEN now() ELSE state.last_success_at END,
      next_sync_at = now() + $4::interval,
      report_date = COALESCE($5::date, state.report_date),
      error = $6,
      updated_at = now()
    FROM market_data.fund f
    WHERE state.fund_id = f.id AND f.code = $1
  `, [code, status, success, interval, reportDate, error ? String(error).slice(0, 1000) : null])
}

export async function createSyncJob(kind, totalCount) {
  const activePool = getPool()
  if (!activePool) return null
  const result = await activePool.query(`
    INSERT INTO market_data.sync_job (kind, status, total_count)
    VALUES ($1, 'running', $2)
    RETURNING id
  `, [kind, totalCount])
  return result.rows[0].id
}

export async function updateSyncJob(id, progress, finished = false) {
  const activePool = getPool()
  if (!activePool || !id) return
  const status = finished
    ? (progress.failedCount === 0 ? 'success' : progress.successCount + progress.emptyCount > 0 ? 'partial' : 'failed')
    : 'running'
  await activePool.query(`
    UPDATE market_data.sync_job
    SET
      status = $2,
      processed_count = $3,
      success_count = $4,
      empty_count = $5,
      failed_count = $6,
      finished_at = CASE WHEN $7 THEN now() ELSE NULL END,
      error = $8
    WHERE id = $1
  `, [id, status, progress.processedCount, progress.successCount, progress.emptyCount, progress.failedCount, finished, progress.error || null])
}

export async function getQuoteCandidates(limit = 1000) {
  const activePool = getPool()
  if (!activePool) return []
  const result = await activePool.query(`
    SELECT s.id, s.provider_secid, s.symbol, s.market_prefix
    FROM market_data.security s
    LEFT JOIN market_data.security_quote_latest q ON q.security_id = s.id
    ORDER BY q.quote_time ASC NULLS FIRST, s.id
    LIMIT $1
  `, [limit])
  return result.rows
}

export async function storeSecurityQuotes(rows) {
  const activePool = getPool()
  if (!activePool || !rows.length) return 0
  const client = await activePool.connect()
  try {
    await client.query('BEGIN')
    for (const row of rows) {
      await client.query(`
        INSERT INTO market_data.security_quote_latest (
          security_id, price, change_amount, change_percent, quote_time, source
        ) VALUES ($1, $2, $3, $4, $5, $6)
        ON CONFLICT (security_id) DO UPDATE SET
          price = EXCLUDED.price,
          change_amount = EXCLUDED.change_amount,
          change_percent = EXCLUDED.change_percent,
          quote_time = EXCLUDED.quote_time,
          source = EXCLUDED.source,
          updated_at = now()
      `, [row.securityId, row.price, row.change, row.changePercent, row.quoteTime, row.source || 'eastmoney'])
      if (row.sector) {
        const sectorResult = await client.query(`
          INSERT INTO market_data.sector (sector_type, name, source)
          VALUES ('industry', $1, $2)
          ON CONFLICT (sector_type, name, source) DO UPDATE SET updated_at = now()
          RETURNING id
        `, [row.sector, row.sectorSource || row.source || 'eastmoney'])
        await client.query(`
          UPDATE market_data.security_sector mapping
          SET valid_to = CURRENT_DATE, is_primary = false, updated_at = now()
          FROM market_data.sector existing_sector
          WHERE mapping.sector_id = existing_sector.id
            AND mapping.security_id = $1
            AND mapping.valid_to IS NULL
            AND existing_sector.sector_type = 'industry'
            AND mapping.sector_id <> $2
        `, [row.securityId, sectorResult.rows[0].id])
        await client.query(`
          INSERT INTO market_data.security_sector (security_id, sector_id, is_primary)
          VALUES ($1, $2, true)
          ON CONFLICT (security_id, sector_id, valid_from) DO UPDATE SET
            is_primary = true,
            valid_to = NULL,
            updated_at = now()
        `, [row.securityId, sectorResult.rows[0].id])
      }
    }

    await client.query('COMMIT')
    return rows.length
  } catch (error) {
    await client.query('ROLLBACK')
    throw error
  } finally {
    client.release()
  }
}

export async function refreshAllFundSectorExposure() {
  const activePool = getPool()
  if (!activePool) return 0
  const result = await activePool.query(`
    WITH refreshed AS (
      INSERT INTO market_data.fund_sector_exposure (
        report_id, sector_id, exposure_ratio, holding_count, updated_at
      )
      SELECT
        fh.report_id,
        ss.sector_id,
        round(sum(fh.holding_ratio)::numeric, 4),
        count(*)::integer,
        now()
      FROM market_data.fund_holding fh
      JOIN market_data.security_sector ss
        ON ss.security_id = fh.security_id
       AND ss.valid_to IS NULL
      GROUP BY fh.report_id, ss.sector_id
      ON CONFLICT (report_id, sector_id) DO UPDATE SET
        exposure_ratio = EXCLUDED.exposure_ratio,
        holding_count = EXCLUDED.holding_count,
        updated_at = now()
      RETURNING 1
    )
    SELECT count(*)::integer AS count FROM refreshed
  `)
  return result.rows[0]?.count || 0
}

export async function getMarketDataStatus() {
  return withDatabase(async activePool => {
    const result = await activePool.query(`
      SELECT
        (SELECT count(*)::integer FROM market_data.fund) AS fund_count,
        (SELECT count(*)::integer FROM market_data.fund_report) AS report_count,
        (SELECT count(*)::integer FROM market_data.fund_holding) AS holding_count,
        (SELECT count(*)::integer FROM market_data.security) AS security_count,
        (SELECT count(*)::integer FROM market_data.security_quote_latest) AS quoted_security_count,
        (SELECT count(*)::integer FROM market_data.security_sector WHERE valid_to IS NULL) AS security_sector_count,
        (SELECT count(*)::integer FROM market_data.fund_sector_exposure) AS fund_sector_count,
        (SELECT count(*)::integer FROM market_data.fund_sync_state WHERE status = 'success') AS synced_fund_count,
        (SELECT count(*)::integer FROM market_data.fund_sync_state WHERE status = 'empty') AS empty_fund_count,
        (SELECT count(*)::integer FROM market_data.fund_sync_state WHERE status = 'failed') AS failed_fund_count
    `)
    const jobResult = await activePool.query(`
      SELECT * FROM market_data.sync_job ORDER BY started_at DESC LIMIT 1
    `)
    return {
      configured: true,
      ...result.rows[0],
      latestJob: jobResult.rows[0] || null
    }
  }, { configured: false })
}

export async function closeMarketDatabase() {
  if (pool) await pool.end()
  pool = null
}
