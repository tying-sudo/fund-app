import { getFundEstimateMarketState, fetchUpstream } from './cache.mjs'
import { getFundProfile, getReliableFundEstimates } from './fund-data-service.mjs'
import {
  appendFundIntradayPoint,
  finalizeFundIntradayCurve,
  getLatestStoredFundIntradayCurve,
  getStoredFundPerformance,
  storeFundPerformance
} from './market-database.mjs'

const PERFORMANCE_REFRESH_MS = 30 * 60 * 1000
const PERFORMANCE_RANGES = new Map([
  ['y', 31],
  ['3y', 93],
  ['6y', 186]
])
const performanceMemoryCache = new Map()
const intradayMemoryCache = new Map()

function numberOrNull(value) {
  const parsed = Number.parseFloat(String(value ?? '').replaceAll(',', '').replace('%', ''))
  return Number.isFinite(parsed) ? parsed : null
}

function cachedRecently(value, ttl = PERFORMANCE_REFRESH_MS) {
  const cachedAt = Date.parse(String(value?.cachedAt || value?.updatedAt || ''))
  return Number.isFinite(cachedAt) && Date.now() - cachedAt < ttl
}

function normalizeComparisonPoints(fund, average, index, days) {
  const latestTimestamp = fund.at(-1)?.[0]
  if (!Number.isFinite(latestTimestamp)) return []
  const cutoff = latestTimestamp - days * 24 * 60 * 60 * 1000
  const rebased = items => {
    const filtered = (items || []).filter(item => Number.isFinite(item?.[0]) && Number.isFinite(item?.[1]) && item[0] >= cutoff)
    const base = filtered[0]?.[1]
    return Number.isFinite(base) ? new Map(filtered.map(item => [item[0], item[1] - base])) : new Map()
  }
  const fundMap = rebased(fund)
  const averageMap = rebased(average)
  const indexMap = rebased(index)
  return [...fundMap.entries()].map(([timestamp, fundReturn]) => ({
    date: new Date(timestamp).toISOString().slice(0, 10),
    fundReturn,
    avgReturn: averageMap.get(timestamp) ?? null,
    indexReturn: indexMap.get(timestamp) ?? null
  }))
}

export function parseFundPerformancePayload(source, range) {
  const days = PERFORMANCE_RANGES.get(range)
  if (!days) return []
  const matched = String(source || '').match(/var\s+Data_grandTotal\s*=\s*(.*?);/s)
  if (!matched?.[1]) return []
  let series
  try {
    series = JSON.parse(matched[1])
  } catch {
    return []
  }
  if (!Array.isArray(series)) return []
  const fund = series[0]?.data || []
  const average = series.find(item => String(item?.name || '').includes('同类'))?.data || series[1]?.data || []
  const index = series.find(item => String(item?.name || '').includes('沪深300'))?.data || series[2]?.data || []
  if (!Array.isArray(fund) || fund.length < 2) return []
  return normalizeComparisonPoints(fund, average, index, days)
}

async function refreshFundPerformance(code, range) {
  const response = await fetchUpstream(`https://fund.eastmoney.com/pingzhongdata/${code}.js`, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
      'Referer': 'https://fund.eastmoney.com/'
    },
    timeoutMs: 8_000,
    retries: 1,
    dedupeKey: `fund:performance:${code}:${range}`
  })
  const points = parseFundPerformancePayload(await response.text(), range)
  if (points.length < 2) throw new Error('业绩对比数据为空')
  const result = {
    code,
    range,
    points,
    source: 'eastmoney_pingzhongdata',
    updatedAt: new Date().toISOString()
  }
  performanceMemoryCache.set(`${code}:${range}`, result)
  await storeFundPerformance(code, range, result).catch(() => false)
  return result
}

/** Returns cached comparison data immediately and refreshes stale database rows in the background. */
export async function getFundPerformance(code, range) {
  if (!/^\d{6}$/.test(code)) throw new Error('基金代码必须是6位数字')
  if (!PERFORMANCE_RANGES.has(range)) throw new Error('不支持的业绩区间')
  const key = `${code}:${range}`
  const memory = performanceMemoryCache.get(key)
  if (memory && cachedRecently(memory)) return { ...memory, cache: 'memory' }

  const stored = await getStoredFundPerformance(code, range)
  if (stored?.points?.length >= 2) {
    performanceMemoryCache.set(key, stored)
    if (!cachedRecently(stored)) {
      void refreshFundPerformance(code, range).catch(error => console.warn(`[Fund Chart] performance refresh failed for ${code}: ${error.message}`))
    }
    return stored
  }
  return refreshFundPerformance(code, range)
}

function formatInTimeZone(timeZone, now) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23'
  }).formatToParts(now).filter(part => part.type !== 'literal').map(part => [part.type, part.value]))
  return `${parts.year}-${parts.month}-${parts.day} ${parts.hour}:${parts.minute}:${parts.second}`
}

function timeZoneForMarket(market) {
  if (market === 'hk') return 'Asia/Hong_Kong'
  if (market === 'us') return 'America/New_York'
  return 'Asia/Shanghai'
}

function estimateTradingDate(estimate, market, now) {
  const explicit = String(estimate?.marketDate || estimate?.gztime || '').match(/\d{4}-\d{2}-\d{2}/)?.[0]
  if (explicit) return explicit
  if (market?.date) return market.date
  return formatInTimeZone(timeZoneForMarket(market?.market), now).slice(0, 10)
}

function estimatePointTime(_estimate, tradingDate, market, now) {
  // Estimate feeds may label a US tick with Beijing time. The request instant
  // is unambiguous and is the only safe common clock for the curve.
  const clock = formatInTimeZone(timeZoneForMarket(market?.market), now)
  return `${tradingDate} ${clock.slice(11)}`
}

function formatCurvePoint(point, timeZone, tradingDate) {
  if (point?.source === 'previous_nav') return { ...point, time: `${tradingDate} 09:30:00` }
  const instant = Date.parse(String(point?.timeIso || ''))
  if (!Number.isFinite(instant)) return point
  return { ...point, time: formatInTimeZone(timeZone, new Date(instant)) }
}

function sameAnchor(left, right) {
  return Math.abs(Number(left?.value) - Number(right?.value)) < 0.0000005 &&
    Math.abs(Number(left?.change) - Number(right?.change)) < 0.0000005
}

function waveProgress(value) {
  // A monotonic sine easing adds visible valuation progress without overshoot.
  return value - Math.sin(value * Math.PI * 2) * 0.08
}

export function calculateIntradayProgress(points, market, tradingDate) {
  const timeZone = timeZoneForMarket(market)
  const normalized = (Array.isArray(points) ? points : [])
    .map(point => formatCurvePoint(point, timeZone, tradingDate))
    .filter(point => point?.time && Number.isFinite(Number(point.value)) && Number.isFinite(Number(point.change)))
    .filter(point => point.source !== 'previous_nav')
    .sort((left, right) => left.time.localeCompare(right.time))

  const anchors = []
  let groupStart = null
  let groupLast = null
  for (const point of normalized) {
    if (!groupStart) {
      groupStart = point
      groupLast = point
    } else if (sameAnchor(groupStart, point)) {
      groupLast = point
    } else {
      anchors.push(groupStart)
      groupStart = point
      groupLast = point
    }
  }
  if (groupStart) anchors.push(groupStart)
  if (groupLast && groupLast.time !== groupStart?.time) anchors.push(groupLast)

  const calculated = []
  let previousAnchor = null
  for (const anchor of anchors) {
    const from = previousAnchor && Date.parse(String(previousAnchor.timeIso || ''))
    const to = Date.parse(String(anchor.timeIso || ''))
    const seconds = Number.isFinite(from) && Number.isFinite(to) ? Math.floor((to - from) / 1_000) : 0
    if (previousAnchor && seconds > 1 && seconds <= 300) {
      for (let second = 1; second < seconds; second++) {
        const progress = waveProgress(second / seconds)
        const instant = new Date(from + second * 1_000)
        calculated.push({
          time: formatInTimeZone(timeZone, instant),
          timeIso: instant.toISOString(),
          value: Number((Number(previousAnchor.value) + (Number(anchor.value) - Number(previousAnchor.value)) * progress).toFixed(6)),
          change: Number((Number(previousAnchor.change) + (Number(anchor.change) - Number(previousAnchor.change)) * progress).toFixed(6)),
          source: 'estimated_progress'
        })
      }
    }
    calculated.push(anchor)
    previousAnchor = anchor
  }

  return calculated.sort((left, right) => left.time.localeCompare(right.time))
}

function normalizeCurve(code, curve) {
  if (!curve) return null
  return {
    code,
    tradingDate: curve.tradingDate,
    market: curve.market || 'cn',
    points: calculateIntradayProgress(curve.points, curve.market || 'cn', curve.tradingDate),
    finalized: Boolean(curve.finalized),
    source: curve.source || 'realtime_estimate',
    lastPointAt: curve.lastPointAt || null,
    finalizedAt: curve.finalizedAt || null,
    cachedAt: curve.cachedAt || curve.updatedAt || null,
    cache: curve.cache || 'memory'
  }
}

function appendToMemoryCurve(code, tradingDate, market, point, openingPoint) {
  const current = intradayMemoryCache.get(code)
  if (current?.tradingDate === tradingDate && current.finalized) return current
  const byTime = new Map((current?.tradingDate === tradingDate ? current.points : []).map(item => [item.time, item]))
  if (!byTime.size && openingPoint) byTime.set(openingPoint.time, openingPoint)
  byTime.set(point.time, point)
  const curve = {
    code,
    tradingDate,
    market,
    points: [...byTime.values()].sort((left, right) => left.time.localeCompare(right.time)).slice(-18_000),
    finalized: false,
    source: point.source,
    lastPointAt: point.timeIso,
    cachedAt: new Date().toISOString(),
    cache: 'memory'
  }
  intradayMemoryCache.set(code, curve)
  return curve
}

function shouldFinalizeCurve(curve, market) {
  if (!curve || curve.finalized || market?.isOpen || market?.isLunchBreak) return false
  if (!market?.isWeekday || market?.isAfterClose) return true
  return Boolean(market?.date && curve.tradingDate < market.date)
}

/**
 * Records validated real-time anchors. The API calculates bounded per-second
 * progress between anchors without changing their actual endpoint values.
 */
export async function getFundIntradayCurve(code, now = new Date()) {
  if (!/^\d{6}$/.test(code)) throw new Error('基金代码必须是6位数字')
  const profile = getFundProfile(code) || {}
  const market = getFundEstimateMarketState(profile, now)
  let latest = await getLatestStoredFundIntradayCurve(code)
  if (!latest) latest = intradayMemoryCache.get(code) || null

  if (market.isOpen) {
    const estimate = (await getReliableFundEstimates([code], now))[code]
    const value = numberOrNull(estimate?.gsz)
    const change = numberOrNull(estimate?.gszzl)
    const tradingDate = estimateTradingDate(estimate, market, now)
    const sourceIsRealtime = estimate?.realtime && estimate?.source !== 'market_snapshot'
    if (sourceIsRealtime && value !== null && value > 0 && change !== null) {
      const time = estimatePointTime(estimate, tradingDate, market, now)
      const point = {
        time,
        timeIso: new Date(now).toISOString(),
        value: Number(value.toFixed(6)),
        change: Number(change.toFixed(6)),
        source: estimate.source
      }
      const stored = await appendFundIntradayPoint(code, tradingDate, market.market || 'cn', point)
        .catch(() => null)
      latest = stored || appendToMemoryCurve(code, tradingDate, market.market || 'cn', point)
    }
  } else if (shouldFinalizeCurve(latest, market)) {
    const finalized = await finalizeFundIntradayCurve(code, latest.tradingDate).catch(() => null)
    latest = finalized || { ...latest, finalized: true, finalizedAt: new Date(now).toISOString(), cachedAt: new Date(now).toISOString() }
    intradayMemoryCache.set(code, latest)
  }

  return normalizeCurve(code, latest) || {
    code,
    tradingDate: '',
    market: market.market || 'cn',
    points: [],
    finalized: false,
    source: '',
    lastPointAt: null,
    finalizedAt: null,
    cachedAt: null,
    cache: 'empty'
  }
}
