import { API_BASE_URL } from '@/config/api'

export interface ValuationSettlement {
  date: string
  estimateChange: number
  realChange: number
  source?: 'grid' | 'native-recovery' | 'local-cache'
}

interface ValuationSettlementResponse {
  date?: unknown
  estimate_change?: unknown
  real_change?: unknown
}

const gridBaseUrl = import.meta.env.VITE_VALUATION_GRID_URL
  || (import.meta.env.PROD ? '/grid/' : 'http://10.0.10.20:8080/')
const gridApiBaseUrl = new URL(gridBaseUrl, window.location.origin)
const settlementCachePrefix = 'fund-app:valuation-settlement:v1:'

function settlementCacheKey(code: string) {
  return `${settlementCachePrefix}${code}`
}

function parseSettlement(value: unknown): ValuationSettlement | null {
  if (!value || typeof value !== 'object') return null
  const data = value as Partial<ValuationSettlement>
  const date = typeof data.date === 'string' ? data.date : ''
  const estimateChange = Number(data.estimateChange)
  const realChange = Number(data.realChange)
  if (!date || !Number.isFinite(estimateChange) || !Number.isFinite(realChange)) return null
  return { date, estimateChange, realChange, source: data.source }
}

export function getCachedValuationSettlement(code: string): ValuationSettlement | null {
  try {
    return parseSettlement(JSON.parse(localStorage.getItem(settlementCacheKey(code)) || 'null'))
  } catch {
    return null
  }
}

export function rememberValuationSettlement(code: string, settlement: ValuationSettlement): void {
  try {
    localStorage.setItem(settlementCacheKey(code), JSON.stringify(settlement))
  } catch {
    // The live response remains usable when device storage is unavailable.
  }
}

export function forgetValuationSettlement(code: string): void {
  try {
    localStorage.removeItem(settlementCacheKey(code))
  } catch {
    // A blocked storage API does not affect the authoritative network result.
  }
}

async function recoverSettlementFromNativeSources(code: string, signal: AbortSignal): Promise<ValuationSettlement | null> {
  const response = await fetch(`${API_BASE_URL}/api/fund-estimate-sources?code=${encodeURIComponent(code)}`, { signal })
  if (!response.ok) return null
  const payload = await response.json() as {
    data?: { sources?: Record<string, { gszzl?: unknown; gztime?: unknown }> }
  }
  const sources = payload.data?.sources || {}
  const official = sources.market_snapshot
  const date = typeof official?.gztime === 'string' ? official.gztime.slice(0, 10) : ''
  const realChange = Number(official?.gszzl)
  if (!date || !Number.isFinite(realChange)) return null

  for (const sourceName of ['fundgz', 'holdings_weighted', 'sina_ds2', 'sina_ds3']) {
    const source = sources[sourceName]
    const estimateDate = typeof source?.gztime === 'string' ? source.gztime.slice(0, 10) : ''
    const estimateChange = Number(source?.gszzl)
    if (estimateDate === date && Number.isFinite(estimateChange)) {
      return { date, estimateChange, realChange, source: 'native-recovery' }
    }
  }
  return null
}

/** Fetch a completed estimate/NAV pair only for non-trading fallback display. */
export async function fetchLatestValuationSettlement(code: string): Promise<ValuationSettlement | null> {
  if (!/^\d{6}$/.test(code)) return null

  const controller = new AbortController()
  const timeout = window.setTimeout(() => controller.abort(), 5000)
  try {
    const url = new URL(`/v1/fund/${code}/settlement`, gridApiBaseUrl)
    const response = await fetch(url, { signal: controller.signal })
    if (response.ok) {
      const data = await response.json() as ValuationSettlementResponse
      const settlement = parseSettlement({
        date: data.date,
        estimateChange: data.estimate_change,
        realChange: data.real_change,
        source: 'grid'
      })
      if (settlement) {
        rememberValuationSettlement(code, settlement)
        return settlement
      }

      const recovered = await recoverSettlementFromNativeSources(code, controller.signal)
      if (recovered) {
        rememberValuationSettlement(code, recovered)
        return recovered
      }

      // A successful empty response is authoritative. Keeping an older local
      // pair here can resurrect a synthetic 0.00% estimate after it was fixed
      // on the server. Cached data remains available for real network errors.
      forgetValuationSettlement(code)
      return null
    }
    const recovered = await recoverSettlementFromNativeSources(code, controller.signal)
    if (recovered) {
      rememberValuationSettlement(code, recovered)
      return recovered
    }
    return getCachedValuationSettlement(code)
  } catch {
    return getCachedValuationSettlement(code)
  } finally {
    window.clearTimeout(timeout)
  }
}
