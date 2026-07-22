import { fetchStockQuotes, getFundList } from './cache.mjs'
import { fetchFundHoldingSnapshotsFromUpstream } from './fund-data-service.mjs'
import {
  createSyncJob,
  getDueFundCodes,
  getQuoteCandidates,
  isMarketDatabaseConfigured,
  markFundSync,
  refreshAllFundSectorExposure,
  storeFundHoldingSnapshots,
  storeSecurityQuotes,
  updateSyncJob,
  upsertFundUniverse
} from './market-database.mjs'

let holdingsSyncPromise = null
let quoteSyncPromise = null

const wait = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds))

export function isMarketHoldingsSyncRunning() {
  return Boolean(holdingsSyncPromise)
}

export function startMarketHoldingsSync({ force = false, concurrency = 4, delayMs = 120 } = {}) {
  if (!isMarketDatabaseConfigured()) return Promise.resolve({ skipped: true, reason: 'database_not_configured' })
  if (holdingsSyncPromise) return holdingsSyncPromise
  holdingsSyncPromise = runMarketHoldingsSync({ force, concurrency, delayMs })
    .finally(() => { holdingsSyncPromise = null })
  return holdingsSyncPromise
}

async function runMarketHoldingsSync({ force, concurrency, delayMs }) {
  const funds = getFundList() || []
  await upsertFundUniverse(funds)
  const dueCodes = await getDueFundCodes({ force })
  const fundByCode = new Map(funds.map(fund => [fund.code, fund]))
  const progress = {
    processedCount: 0,
    successCount: 0,
    emptyCount: 0,
    failedCount: 0,
    error: null
  }
  const jobId = await createSyncJob(force ? 'full_market_force' : 'full_market_incremental', dueCodes.length)
  if (!dueCodes.length) {
    await updateSyncJob(jobId, progress, true)
    return { totalCount: 0, ...progress }
  }

  console.log(`[Market Sync] starting ${dueCodes.length} funds with concurrency ${concurrency}`)
  let cursor = 0
  const worker = async () => {
    while (cursor < dueCodes.length) {
      const currentIndex = cursor++
      const code = dueCodes[currentIndex]
      const fund = fundByCode.get(code) || { code, name: '' }
      try {
        await markFundSync(code, { status: 'running' })
        const snapshots = await fetchFundHoldingSnapshotsFromUpstream(code)
        if (!snapshots.current.holdings.length || !snapshots.current.reportDate) {
          progress.emptyCount++
          await markFundSync(code, { status: 'empty' })
        } else {
          await storeFundHoldingSnapshots({ fund, ...snapshots })
          progress.successCount++
          await markFundSync(code, { status: 'success', reportDate: snapshots.current.reportDate })
        }
      } catch (error) {
        progress.failedCount++
        progress.error = error.message
        await markFundSync(code, { status: 'failed', error: error.message }).catch(() => {})
        console.error(`[Market Sync] ${code} failed: ${error.message}`)
      } finally {
        progress.processedCount++
        if (progress.processedCount % 25 === 0 || progress.processedCount === dueCodes.length) {
          await updateSyncJob(jobId, progress).catch(() => {})
          console.log(`[Market Sync] ${progress.processedCount}/${dueCodes.length} success=${progress.successCount} empty=${progress.emptyCount} failed=${progress.failedCount}`)
        }
        if (delayMs > 0) await wait(delayMs)
      }
    }
  }

  await Promise.all(Array.from(
    { length: Math.min(Math.max(1, concurrency), 8) },
    () => worker()
  ))
  await updateSyncJob(jobId, progress, true)
  await refreshAllFundSectorExposure().catch(error => {
    console.error(`[Market Sync] sector exposure refresh failed: ${error.message}`)
  })
  console.log(`[Market Sync] completed success=${progress.successCount} empty=${progress.emptyCount} failed=${progress.failedCount}`)
  return { totalCount: dueCodes.length, ...progress }
}

export function refreshMarketSecurityQuotes({ limit = 1000, batchSize = 50, delayMs = 80 } = {}) {
  if (!isMarketDatabaseConfigured()) return Promise.resolve({ skipped: true, reason: 'database_not_configured' })
  if (holdingsSyncPromise) return Promise.resolve({ skipped: true, reason: 'holdings_sync_running' })
  if (quoteSyncPromise) return quoteSyncPromise
  quoteSyncPromise = runQuoteRefresh({ limit, batchSize, delayMs })
    .finally(() => { quoteSyncPromise = null })
  return quoteSyncPromise
}

async function runQuoteRefresh({ limit, batchSize, delayMs }) {
  const candidates = await getQuoteCandidates(limit)
  let updated = 0
  for (let index = 0; index < candidates.length; index += batchSize) {
    const batch = candidates.slice(index, index + batchSize)
    const quotes = await fetchStockQuotes(batch.map(item => item.provider_secid))
    const quoteTime = new Date().toISOString()
    const rows = batch.map(item => {
      const quote = quotes[item.symbol]
      return {
        securityId: item.id,
        price: quote && Number.isFinite(Number(quote.price)) ? Number(quote.price) : null,
        change: quote && Number.isFinite(Number(quote.change)) ? Number(quote.change) : null,
        changePercent: quote && Number.isFinite(Number(quote.changePercent)) ? Number(quote.changePercent) : null,
        sector: quote?.sector || null,
        source: quote?.source || 'eastmoney',
        sectorSource: quote?.sectorSource || quote?.source || 'eastmoney',
        quoteTime
      }
    })
    if (rows.length) updated += await storeSecurityQuotes(rows)
    if (delayMs > 0 && index + batchSize < candidates.length) await wait(delayMs)
  }
  if (candidates.length) console.log(`[Market Quotes] updated ${updated}/${candidates.length}`)
  return { selected: candidates.length, updated }
}
