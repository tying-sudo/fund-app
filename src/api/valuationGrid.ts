import { API_BASE_URL } from '@/config/api'
import {
  attachNativeOfficialNav,
  parseValuationSettlement,
  recoverNativeValuationSettlement,
  type ValuationSettlement
} from '@/utils/valuationSettlement'

export type { ValuationSettlement } from '@/utils/valuationSettlement'

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

export function getCachedValuationSettlement(code: string): ValuationSettlement | null {
  try {
    return parseValuationSettlement(JSON.parse(localStorage.getItem(settlementCacheKey(code)) || 'null'))
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

async function fetchNativeValuationSources(code: string, signal: AbortSignal): Promise<unknown> {
  const response = await fetch(`${API_BASE_URL}/api/fund-estimate-sources?code=${encodeURIComponent(code)}`, { signal })
  if (!response.ok) return null
  return response.json()
}

/** Fetch a completed estimate/NAV pair only for non-trading fallback display. */
export async function fetchLatestValuationSettlement(code: string): Promise<ValuationSettlement | null> {
  if (!/^\d{6}$/.test(code)) return null

  const controller = new AbortController()
  const timeout = window.setTimeout(() => controller.abort(), 5000)
  try {
    // Run the source snapshot alongside the grid request. Both endpoints then
    // receive the full timeout instead of serially sharing the same five seconds.
    const nativePayloadPromise = fetchNativeValuationSources(code, controller.signal).catch(() => null)
    const getNativePayload = () => nativePayloadPromise
    const url = new URL(`/v1/fund/${code}/settlement`, gridApiBaseUrl)
    const response = await fetch(url, { signal: controller.signal })
    if (response.ok) {
      const data = await response.json() as ValuationSettlementResponse
      let settlement = parseValuationSettlement({
        date: data.date,
        estimateChange: data.estimate_change,
        realChange: data.real_change,
        source: 'grid'
      })
      if (settlement) {
        try {
          settlement = attachNativeOfficialNav(settlement, await getNativePayload())
        } catch {
          // The grid pair remains valid; callers may already have the official NAV.
        }
        rememberValuationSettlement(code, settlement)
        return settlement
      }

      const recovered = recoverNativeValuationSettlement(await getNativePayload())
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
    const recovered = recoverNativeValuationSettlement(await getNativePayload())
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
