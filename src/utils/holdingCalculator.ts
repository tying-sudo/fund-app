// [WHY] 持仓盈亏计算引擎 - 精准、高效、可扩展
// [WHAT] 提供精确的持仓收益计算，支持 A/C类费用、分批买入成本摊销
// [OPT] 使用缓存和惰性计算提升性能

import type { HoldingRecord, FundEstimate, FundShareClass } from '@/types/fund'
import { getBeijingDateString, getBeijingDayAndMinutes, getCalendarDayDifference } from './tradingDate.ts'

/** 计算结果 */
export interface CalculationResult {
  /** 当前净值 */
  currentValue: number
  /** 当前市值 */
  marketValue: number
  /** 持有收益金额 */
  profit: number
  /** 持有收益率 (%) */
  profitRate: number
  /** 当日收益金额 */
  todayProfit: number
  /** 有效份额（可能被重新计算） */
  effectiveShares: number
}

/** 计算上下文 */
export interface CalcContext {
  holding: HoldingRecord
  estimate: FundEstimate
  realChange?: number | null
  realChangeDate?: string | null
  /** 官方盘后公布的今日净值（比估算更准） */
  realNav?: number | null
  now?: Date
}


/**
 * 数值精度控制
 * [WHY] JavaScript 浮点数运算存在精度问题，需要统一处理
 */
export const PRECISION = {
  /** 金额精度（2位小数） */
  AMOUNT: 2,
  /** 费率精度（4位小数） */
  RATE: 4,
  /** 百分比精度（2位小数） */
  PERCENT: 2,
} as const

/**
 * 安全的四舍五入
 * [FIX] 解决 toFixed 返回字符串和浮点精度问题
 */
export function round(value: number, decimals: number): number {
  if (!isFinite(value)) return 0
  const factor = Math.pow(10, decimals)
  return Math.round(value * factor) / factor
}

/**
 * 获取今日日期字符串（北京时间）
 * [WHY] 统一日期格式，避免时区问题
 */
export function getTodayStr(baseDate?: Date): string {
  return getBeijingDateString(baseDate)
}

/**
 * 判断是否为交易时段
 * [WHAT] 周一至周五 9:30-15:00
 */
export function isTradingHours(now?: Date): boolean {
  const { day, minutes } = getBeijingDayAndMinutes(now)
  
  return day >= 1 && day <= 5 && 
         minutes >= 9 * 60 + 30 && 
         minutes < 15 * 60
}

function isMarketOpenInTimeZone(timeZone: string, sessions: Array<[number, number]>, now = new Date()): boolean {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    weekday: 'short',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23'
  }).formatToParts(now)
  const values = Object.fromEntries(parts.filter((part) => part.type !== 'literal').map((part) => [part.type, part.value]))
  const day = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(values.weekday || '')
  const minutes = Number(values.hour) * 60 + Number(values.minute)
  return day >= 1 && day <= 5 && sessions.some(([start, end]) => minutes >= start && minutes < end)
}

function isMarketPreOpenInTimeZone(timeZone: string, firstOpenMinute: number, now = new Date()): boolean {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    weekday: 'short',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23'
  }).formatToParts(now)
  const values = Object.fromEntries(parts.filter((part) => part.type !== 'literal').map((part) => [part.type, part.value]))
  const day = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(values.weekday || '')
  const minutes = Number(values.hour) * 60 + Number(values.minute)
  return day >= 1 && day <= 5 && minutes < firstOpenMinute
}

const HONG_KONG_FUND_PATTERN = /恒生|恒指|港股|香港|H股|国企/
const US_FUND_PATTERN = /美股|美国|纳斯达克|标普|道琼斯|罗素|全球科技|全球互联网/
const OVERSEAS_FUND_PATTERN = /QDII|海外|全球/

/**
 * Global QDII NAVs are commonly published on a T+2 schedule. Hong Kong-only
 * QDII funds settle on their local market schedule and keep the normal path.
 */
export function isDelayedSettlementQdiiFund(fundName?: string | null): boolean {
  const identity = String(fundName || '').toUpperCase()
  return OVERSEAS_FUND_PATTERN.test(identity) && !HONG_KONG_FUND_PATTERN.test(identity)
}

/**
 * A delayed QDII's latest published change is only a fallback when no usable
 * current-day estimate exists. A current estimate remains the daily P/L source
 * until the fund company publishes today's NAV.
 */
export function shouldUseDelayedQdiiPublishedChange({
  fundName,
  realChange,
  realChangeDate,
  now
}: {
  fundName?: string | null
  realChange?: number | string | null
  realChangeDate?: string | null
  now?: Date
}): boolean {
  if (!isDelayedSettlementQdiiFund(fundName) || !hasUsableEstimateChange(realChange)) return false

  const realDate = normalizeMarketDate(realChangeDate)
  const today = getTodayStr(now)
  return Boolean(realDate) && realDate <= today && getCalendarDayDifference(realDate, today) <= 10
}

/** Fund estimates follow the underlying market rather than A-share hours alone. */
export function isFundTradingHours(fundName?: string | null, now?: Date): boolean {
  const date = now || new Date()
  if (isTradingHours(date)) return true

  const identity = String(fundName || '').toUpperCase()
  const hongKongOpen = isMarketOpenInTimeZone('Asia/Hong_Kong', [[9 * 60 + 30, 12 * 60], [13 * 60, 16 * 60]], date)
  const usOpen = isMarketOpenInTimeZone('America/New_York', [[9 * 60 + 30, 16 * 60]], date)

  // A Hong Kong identifier wins over generic QDII/global wording. For
  // example, 018524 tracks the Hang Seng market and must settle when Hong
  // Kong closes, even while New York remains open.
  if (HONG_KONG_FUND_PATTERN.test(identity)) return hongKongOpen
  if (US_FUND_PATTERN.test(identity)) return usOpen
  if (OVERSEAS_FUND_PATTERN.test(identity)) return hongKongOpen || usOpen
  return false
}

/** Before its market opens, a fund keeps the latest published closing NAV. */
export function isFundPreOpen(fundName?: string | null, now?: Date): boolean {
  const date = now || new Date()
  const identity = String(fundName || '').toUpperCase()
  if (HONG_KONG_FUND_PATTERN.test(identity)) return isMarketPreOpenInTimeZone('Asia/Hong_Kong', 9 * 60 + 30, date)
  if (US_FUND_PATTERN.test(identity)) return isMarketPreOpenInTimeZone('America/New_York', 9 * 60 + 30, date)
  if (OVERSEAS_FUND_PATTERN.test(identity)) return isMarketPreOpenInTimeZone('Asia/Hong_Kong', 9 * 60 + 30, date)

  const { day, minutes } = getBeijingDayAndMinutes(date)
  return day >= 1 && day <= 5 && minutes < 9 * 60 + 30
}

/** Whether the A-share market is in its scheduled midday recess. */
export function isLunchBreak(now?: Date): boolean {
  const { day, minutes } = getBeijingDayAndMinutes(now)
  return day >= 1 && day <= 5 &&
    minutes >= 11 * 60 + 30 &&
    minutes < 13 * 60
}

/**
 * 解析估值日期并判断是否为今天
 * [FIX] 处理多种日期格式：2026/07/08 或 2026-07-08
 */
export function isEstimateDateToday(gztime: string, todayStr?: string): boolean {
  if (!gztime) return false
  const targetToday = todayStr || getTodayStr()
  return normalizeMarketDate(gztime) === targetToday
}

/** A present numeric change is required before treating an estimate as usable. */
export function hasUsableEstimateChange(value: number | string | null | undefined): boolean {
  if (value === null || value === undefined || value === '') return false
  return Number.isFinite(Number(value))
}

/** An official NAV snapshot is not itself an intraday estimate. */
export function hasUsableCurrentEstimate(estimate?: {
  source?: string | null
  gszzl?: number | string | null
  gztime?: string | null
} | null, todayStr?: string): boolean {
  return estimate?.source !== 'market_snapshot' &&
    hasUsableEstimateChange(estimate?.gszzl) &&
    isEstimateDateToday(estimate?.gztime || '', todayStr)
}

/** A market-close estimate remains usable while the backend retention window is active. */
export function isRetainedMarketEstimate(estimate?: {
  frozen?: boolean
  gszzl?: number | string | null
} | null): boolean {
  return estimate?.frozen === true && hasUsableEstimateChange(estimate.gszzl)
}

/**
 * The grid valuation is a last-resort repair for the all-market NAV snapshot.
 * It must never replace a same-day estimate already resolved by the fund feed.
 */
export function shouldUseGridEstimateFallback(source: string | null | undefined): boolean {
  return source === 'market_snapshot'
}

/** Keep the newest official value when a historical source has not caught up. */
export function selectLatestRealChange({
  incomingChange,
  incomingDate,
  cachedChange,
  cachedDate
}: {
  incomingChange?: number | string | null
  incomingDate?: string | null
  cachedChange?: number | string | null
  cachedDate?: string | null
}): { change: number | undefined; date: string | undefined } {
  const incomingNormalizedDate = normalizeMarketDate(incomingDate)
  const cachedNormalizedDate = normalizeMarketDate(cachedDate)
  const hasIncoming = hasUsableEstimateChange(incomingChange) && Boolean(incomingNormalizedDate)
  const hasCached = hasUsableEstimateChange(cachedChange) && Boolean(cachedNormalizedDate)

  if (hasCached && (!hasIncoming || cachedNormalizedDate > incomingNormalizedDate)) {
    return { change: Number(cachedChange), date: cachedNormalizedDate }
  }
  if (hasIncoming) return { change: Number(incomingChange), date: incomingNormalizedDate }
  if (hasCached) return { change: Number(cachedChange), date: cachedNormalizedDate }
  return { change: undefined, date: undefined }
}

/**
 * Providers can briefly return an empty or previous-day quote while the market
 * is open. Keep a same-day intraday estimate visible during that degradation.
 */
export function shouldRetainCurrentIntradayEstimate({
  incomingEstimateChange,
  incomingEstimateTime,
  cachedEstimateChange,
  cachedEstimateTime,
  now
}: {
  incomingEstimateChange?: number | string | null
  incomingEstimateTime?: string | null
  cachedEstimateChange?: number | string | null
  cachedEstimateTime?: string | null
  now?: Date
}): boolean {
  const date = now || new Date()
  return isTradingHours(date) && shouldRetainCurrentDayEstimate({
    incomingEstimateChange,
    incomingEstimateTime,
    cachedEstimateChange,
    cachedEstimateTime,
    now: date
  })
}

/**
 * Retain a valid estimate captured today until a provider supplies another
 * same-day value. This also protects the 15:00 transition, when the latest
 * official NAV can still belong to the previous trading day.
 */
export function shouldRetainCurrentDayEstimate({
  incomingEstimateChange,
  incomingEstimateTime,
  cachedEstimateChange,
  cachedEstimateTime,
  now
}: {
  incomingEstimateChange?: number | string | null
  incomingEstimateTime?: string | null
  cachedEstimateChange?: number | string | null
  cachedEstimateTime?: string | null
  now?: Date
}): boolean {
  const date = now || new Date()
  const today = getTodayStr(date)
  return hasUsableEstimateChange(cachedEstimateChange) &&
    isEstimateDateToday(cachedEstimateTime || '', today) &&
    (!hasUsableEstimateChange(incomingEstimateChange) ||
      !isEstimateDateToday(incomingEstimateTime || '', today))
}

/**
 * Before the next market open, retain a same-day intraday estimate when the
 * incoming value is only an official NAV snapshot. The snapshot supplies the
 * real change separately; it must not erase the estimate used for comparison.
 */
export function shouldRetainCompletedEstimate({
  incomingSource,
  incomingEstimateTime,
  cachedSource,
  cachedEstimateChange,
  cachedEstimateTime,
  fundName,
  now
}: {
  incomingSource?: string | null
  incomingEstimateTime?: string | null
  cachedSource?: string | null
  cachedEstimateChange?: number | string | null
  cachedEstimateTime?: string | null
  fundName?: string | null
  now?: Date
}): boolean {
  return incomingSource === 'market_snapshot' &&
    cachedSource !== 'market_snapshot' &&
    hasUsableEstimateChange(cachedEstimateChange) &&
    isFundPreOpen(fundName, now) &&
    Boolean(cachedEstimateTime) &&
    normalizeMarketDate(cachedEstimateTime) === normalizeMarketDate(incomingEstimateTime)
}

/** Normalize provider timestamps before comparing trading dates. */
export function normalizeMarketDate(value: string | null | undefined): string {
  return String(value || '').split(' ')[0].replace(/\//g, '-')
}

export interface ValuationComparisonState {
  isTrading: boolean
  /** The underlying market has not opened for its next session yet. */
  isPreOpen: boolean
  /**
   * The newest official NAV is the active result outside a trading session.
   * This deliberately includes the next trading day's pre-open window, when
   * the prior day's published NAV is still the value users should see.
   */
  isCurrentReal: boolean
  /** Latest official and estimate values describe the same completed trading day. */
  hasActualDiff: boolean
  /** Calendar age of the official value in Beijing time. */
  realChangeAgeDays: number | null
  /** Shared label used by both holding and watchlist cards. */
  realChangeLabel: '真实' | '昨' | '前' | null
}

/**
 * Keep holding and watchlist valuation labels aligned. During a trading
 * session, the latest official change belongs to the previous trading day,
 * so its difference must wait for today's official value. Outside the
 * session, retain the most recent completed trading day's comparison,
 * including weekends and the period before the next market open.
 */
export function getValuationComparisonState({
  realChange,
  realChangeDate,
  estimateChange,
  estimateTime,
  fundName,
  now
}: {
  realChange?: number | string | null
  realChangeDate?: string | null
  estimateChange?: number | string | null
  estimateTime?: string | null
  fundName?: string | null
  now?: Date
}): ValuationComparisonState {
  const date = now || new Date()
  const today = getTodayStr(date)
  const { day, minutes } = getBeijingDayAndMinutes(date)
  const isTrading = isFundTradingHours(fundName, date)
  const isPreOpen = isFundPreOpen(fundName, date)
  const realDate = normalizeMarketDate(realChangeDate)
  const estimateDate = normalizeMarketDate(estimateTime)
  const realValue = Number(realChange)
  const estimateValue = Number(estimateChange)
  const isPresentNumber = (value: number | string | null | undefined, numericValue: number) =>
    value !== null && value !== undefined && value !== '' && Number.isFinite(numericValue)
  const hasOfficialValue = isPresentNumber(realChange, realValue) && Boolean(realDate) && realDate <= today
  const hasComparableValues = hasOfficialValue && isPresentNumber(estimateChange, estimateValue)
  // Some providers stamp the new calendar date before its market opens. In
  // that pre-open window the estimate still belongs to the prior completed
  // session, so pair it with that session's published NAV.
  const estimateMatchesOfficial = realDate === estimateDate || (isPreOpen && Boolean(estimateDate) && realDate < estimateDate)
  const hasActualDiff = !isTrading && hasComparableValues && Boolean(realDate) && estimateMatchesOfficial && realDate <= today
  const realChangeAgeDays = realDate && realDate <= today
    ? getCalendarDayDifference(realDate, today)
    : null
  // Before the next 09:30 open, keep a published closing result active. An
  // older official value cannot be marked updated while a newer estimate is
  // present, but is valid when it is the only/latest displayed date.
  const isCurrentReal = !isTrading && hasOfficialValue && (!estimateDate || realDate >= estimateDate || isPreOpen)
  const isSameDayAfterClose = day >= 1 && day <= 5 && minutes >= 15 * 60 && realDate === today
  const realChangeLabel = isSameDayAfterClose
    ? '真实'
    : realChangeAgeDays === null
      ? null
      : realChangeAgeDays >= 2 ? '前' : '昨'

  return {
    isTrading,
    isPreOpen,
    isCurrentReal,
    hasActualDiff,
    realChangeAgeDays,
    realChangeLabel
  }
}

/**
 * 判断真实涨跌幅日期是否有效（支持QDII特殊处理）
 */
export function isValidRealChangeDate(
  realChangeDate: string | null | undefined,
  fundName: string,
  now?: Date
): { valid: boolean; isToday: boolean; reason: string } {
  if (!realChangeDate) {
    return { valid: false, isToday: false, reason: 'NO_DATE' }
  }
  
  const date = now || new Date()
  const today = getTodayStr(date)
  
  // 检查是否为今天
  if (realChangeDate === today) {
    return { valid: true, isToday: true, reason: 'TODAY' }
  }

  if (realChangeDate > today) {
    return { valid: false, isToday: false, reason: 'FUTURE_DATE' }
  }
  
  // 收市、盘前、周末和长假期间，保留最近公布的官方净值。
  // 交易所休市并不一定只跨一个自然日，因此不能仅比较“昨天”。
  const trading = isTradingHours(date)
  if (!trading) {
    const staleDays = getCalendarDayDifference(realChangeDate, today)
    if (staleDays <= 10) {
      return { valid: true, isToday: false, reason: 'LATEST_CLOSED_NAV' }
    }
  }
  
  // QDII基金特殊处理：盘后21点后，昨天数据也视为有效
  const isQdii = /QDII|全球|新兴|港/.test(fundName)
  const { minutes } = getBeijingDayAndMinutes(date)
  const hours = Math.floor(minutes / 60)
  if (isQdii && hours >= 21) {
    const staleDays = getCalendarDayDifference(realChangeDate, today)
    if (staleDays <= 10) {
      return { valid: true, isToday: false, reason: 'QDII_LATE_EVENING' }
    }
  }
  
  return { valid: false, isToday: false, reason: 'DATE_MISMATCH' }
}

/**
 * 核心计算函数：计算单只持仓的完整收益数据
 * [WHAT] 根据估值数据和持仓信息，精确计算各项指标
 * [FIX] 优先使用 costPrice × shares 计算成本，不再依赖 holding.amount 的歧义含义
 */
export function calculateHoldingProfit(context: CalcContext): CalculationResult {
  const { holding, estimate, realChange, realChangeDate, realNav, now } = context
  
  // 解析基础数据
  const estimateValue = parseFloat(estimate.gsz) || 0
  const lastValue = parseFloat(estimate.dwjz) || 0
  const today = getTodayStr(now)
  
  // ===== 1. 确定成本单价 =====
  // [IMPORTANT] 优先使用 costPrice/costUnitPrice，其次 buyNetValue
  let costUnitPrice = holding.costPrice || holding.costUnitPrice || holding.buyNetValue || 0
  if (costUnitPrice <= 0 && holding.amount > 0 && holding.shares > 0) {
    costUnitPrice = holding.amount / holding.shares
  }
  
  // ===== 2. 计算有效份额 =====
  let effectiveShares = holding.shares
  if (!effectiveShares || effectiveShares <= 0) {
    // [EDGE] 份额无效时，根据成本和成本单价重新计算
    if (costUnitPrice > 0 && holding.amount > 0) {
      effectiveShares = holding.amount / costUnitPrice
    } else {
      // 最后的兜底：根据当前净值估算
      const buyNav = holding.buyNetValue > 0 
        ? holding.buyNetValue 
        : (estimateValue > 0 ? estimateValue : lastValue)
      effectiveShares = buyNav > 0 ? holding.amount / buyNav : 0
    }
  }
  
  // ===== 3. 计算真实成本 =====
  // [IMPORTANT] 优先使用 holding.amount 存储的成本（由金额-收益精确推导）
  // 其次才用 shares × costUnitPrice，避免 0.01 级四舍五入误差
  let cost = 0
  if (holding.amount > 0) {
    cost = holding.amount
  } else if (costUnitPrice > 0 && effectiveShares > 0) {
    cost = round(effectiveShares * costUnitPrice, PRECISION.AMOUNT)
  }
  
  // ===== 4. 确定当前净值和当日收益 =====
  const dateCheck = isValidRealChangeDate(realChangeDate, holding.name, now)
  const effectiveRealChange = (realChange !== undefined && realChange !== null) 
    ? realChange 
    : undefined
  const hasEstimateToday = isEstimateDateToday(estimate.gztime || '', today)
  const hasCurrentEstimate = hasUsableCurrentEstimate(estimate, today) || isRetainedMarketEstimate(estimate)
  const estimateChange = Number.parseFloat(String(estimate.gszzl || ''))
  const estimateDenominator = 1 + estimateChange / 100
  const useDelayedQdiiPublishedChange = shouldUseDelayedQdiiPublishedChange({
    fundName: holding.name,
    realChange: effectiveRealChange,
    realChangeDate,
    now
  })
  // An older official NAV remains useful as history, but it cannot price
  // today's holding or today's P/L. Switch only when today's NAV is published.
  const hasRealNavToday = realNav !== undefined && realNav !== null && realNav > 0 && dateCheck.isToday
  
  // [FIX] 当前净值优先使用官方盘后净值（最准），其次估值 gsz，最后昨日净值 dwjz
  let currentValue: number
  if (hasRealNavToday) {
    currentValue = realNav
  } else if (estimateValue > 0) {
    currentValue = estimateValue
  } else if (dateCheck.valid && effectiveRealChange !== undefined && lastValue > 0) {
    // 无估值但有真实涨跌幅时，用昨日净值推算
    currentValue = lastValue * (1 + effectiveRealChange / 100)
  } else {
    currentValue = lastValue > 0 ? lastValue : 0
  }
  
  // A provider's dwjz can lag the valuation session while gszzl is current.
  // Derive the session baseline from gszzl so delayed NAV publication cannot
  // make the card add prior-session profit to the current day's profit.
  //       非交易时段有官方净值时，用官方净值 + 真实涨跌幅重算，与第三方APP对齐
  let todayProfit = 0
  if (!hasRealNavToday && hasCurrentEstimate && currentValue > 0 && Number.isFinite(estimateChange) && estimateDenominator > 0) {
    todayProfit = effectiveShares * currentValue * (estimateChange / 100) / estimateDenominator
  } else if (!hasRealNavToday && hasCurrentEstimate && currentValue > 0 && lastValue > 0) {
    // Only use the NAV gap when the provider did not give a usable daily rate.
    todayProfit = effectiveShares * (currentValue - lastValue)
  } else if (!hasRealNavToday && useDelayedQdiiPublishedChange && effectiveRealChange !== undefined && lastValue > 0) {
    todayProfit = lastValue * effectiveShares * (effectiveRealChange / 100)
  } else if (dateCheck.isToday && effectiveRealChange !== undefined && lastValue > 0) {
    // 兜底：用真实涨跌幅计算
    todayProfit = lastValue * effectiveShares * (effectiveRealChange / 100)
  }
  
  if (hasRealNavToday && effectiveRealChange !== undefined) {
    const yesterdayNav = realNav / (1 + effectiveRealChange / 100)
    todayProfit = effectiveShares * (realNav - yesterdayNav)
  }

  // ===== 5. 边界检查 =====
  if (currentValue <= 0 || effectiveShares <= 0 || cost <= 0) {
    return {
      currentValue: currentValue > 0 ? currentValue : 0,
      marketValue: 0,
      profit: 0,
      profitRate: 0,
      todayProfit: 0,
      effectiveShares,
    }
  }
  
  // ===== 6. 计算市值和基础收益 =====
  const marketValue = round(effectiveShares * currentValue, PRECISION.AMOUNT)
  
  // C类销售服务费已反映在基金净值中，不再单独计算或展示。
  
  // ===== 8. 计算最终收益 =====
  const profit = round(marketValue - cost, PRECISION.AMOUNT)
  const profitRate = cost > 0
    ? round(profit / cost * 100, PRECISION.PERCENT)
    : 0

  return {
    currentValue: round(currentValue, 4),
    marketValue,
    profit,
    profitRate,
    todayProfit: round(todayProfit, PRECISION.AMOUNT),
    effectiveShares: round(effectiveShares, 4)
  }
}


/**
 * 批量计算持仓收益
 * [OPT] 支持并行计算和进度回调
 */
export async function batchCalculateProfits(
  contexts: CalcContext[],
  onProgress?: (completed: number, total: number) => void
): Promise<Map<string, CalculationResult>> {
  const results = new Map<string, CalculationResult>()
  
  for (let i = 0; i < contexts.length; i++) {
    const ctx = contexts[i]
    try {
      const result = calculateHoldingProfit(ctx)
      results.set(ctx.holding.code, result)
    } catch (error) {
      console.error(`[HoldingCalc] 计算 ${ctx.holding.code} 失败:`, error)
    }
    
    // 进度回调
    if (onProgress && (i + 1) % 10 === 0) {
      onProgress(i + 1, contexts.length)
    }
  }
  
  if (onProgress) {
    onProgress(contexts.length, contexts.length)
  }
  
  return results
}

/**
 * 计算汇总统计
 * [WHAT] 从单个计算结果聚合为总体统计
 */
export interface SummaryResult {
  totalValue: number
  totalCost: number
  totalProfit: number
  totalProfitRate: number
  todayProfit: number
  holdingCount: number
  profitableCount: number
  lossCount: number
}

export function calculateSummary(results: Map<string, CalculationResult>, holdings: HoldingRecord[]): SummaryResult {
  let totalValue = 0
  let totalCost = 0
  let todayProfit = 0
  let profitableCount = 0
  let lossCount = 0
  
  for (const [code, result] of results) {
    totalValue += result.marketValue
    todayProfit += result.todayProfit
    
    const holding = holdings.find(h => h.code === code)
    if (holding) {
      totalCost += holding.amount
      if (result.profit > 0) profitableCount++
      else if (result.profit < 0) lossCount++
    }
  }
  
  const totalProfit = round(totalValue - totalCost, PRECISION.AMOUNT)
  const totalProfitRate = totalCost > 0 
    ? round(totalProfit / totalCost * 100, PRECISION.PERCENT) 
    : 0
  
  return {
    totalValue: round(totalValue, PRECISION.AMOUNT),
    totalCost: round(totalCost, PRECISION.AMOUNT),
    totalProfit,
    totalProfitRate,
    todayProfit: round(todayProfit, PRECISION.AMOUNT),
    holdingCount: results.size,
    profitableCount,
    lossCount
  }
}
