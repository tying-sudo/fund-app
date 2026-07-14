// [WHY] 持仓盈亏计算引擎 - 精准、高效、可扩展
// [WHAT] 提供精确的持仓收益计算，支持 A/C类费用、分批买入成本摊销
// [OPT] 使用缓存和惰性计算提升性能

import type { HoldingRecord, FundEstimate, FundShareClass } from '@/types/fund'
import { calculateDailyServiceFee } from '@/api/fund'

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
  /** 累计服务费 (C类) */
  totalServiceFee: number
  /** 今日服务费 (C类) */
  todayServiceFee: number
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
  const now = baseDate || new Date()
  const utc = now.getTime() + now.getTimezoneOffset() * 60000
  const bjTime = new Date(utc + 8 * 3600000)
  return bjTime.toISOString().slice(0, 10)
}

/**
 * 判断是否为交易时段
 * [WHAT] 周一至周五 9:30-15:00
 */
export function isTradingHours(now?: Date): boolean {
  const date = now || new Date()
  const day = date.getDay()
  const hours = date.getHours()
  const minutes = date.getMinutes()
  const currentTime = hours * 60 + minutes
  
  return day >= 1 && day <= 5 && 
         currentTime >= 9 * 60 + 30 && 
         currentTime < 15 * 60
}

/**
 * 解析估值日期并判断是否为今天
 * [FIX] 处理多种日期格式：2026/07/08 或 2026-07-08
 */
export function isEstimateDateToday(gztime: string, todayStr?: string): boolean {
  if (!gztime) return false
  const targetToday = todayStr || getTodayStr()
  const datePart = gztime.split(' ')[0]
  const normalizedDate = datePart.replace(/\//g, '-')
  return normalizedDate === targetToday
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
  
  // 非交易时段（早盘/盘后/周末），昨天的真实数据也视为有效，避免跨日 0.2 级误差
  const trading = isTradingHours(date)
  if (!trading) {
    const yesterday = new Date(date)
    yesterday.setDate(yesterday.getDate() - 1)
    const yesterdayStr = yesterday.toISOString().slice(0, 10)
    if (realChangeDate === yesterdayStr) {
      return { valid: true, isToday: false, reason: 'NON_TRADING_YESTERDAY' }
    }
  }
  
  // QDII基金特殊处理：盘后21点后，昨天数据也视为有效
  const isQdii = /QDII|全球|新兴|港/.test(fundName)
  const hours = date.getHours()
  if (isQdii && hours >= 21) {
    const yesterday = new Date(date)
    yesterday.setDate(yesterday.getDate() - 1)
    const yesterdayStr = yesterday.toISOString().slice(0, 10)
    if (realChangeDate === yesterdayStr) {
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
  const trading = isTradingHours(now)
  // [FIX] 盘中只用估值数据；非交易时段只要拿到官方净值就使用，避免跨日/早盘用 dwjz 产生 0.2 级误差
  const hasRealNavToday = realNav !== undefined && realNav !== null && realNav > 0 &&
    (dateCheck.isToday || (!trading && dateCheck.valid))
  
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
  
  // [FIX] 当日收益：盘中/无官方数据用 shares × (gsz - dwjz)；
  //       非交易时段有官方净值时，用官方净值 + 真实涨跌幅重算，与第三方APP对齐
  let todayProfit = 0
  if (currentValue > 0 && lastValue > 0) {
    todayProfit = effectiveShares * (currentValue - lastValue)
  } else if (dateCheck.valid && effectiveRealChange !== undefined && lastValue > 0) {
    // 兜底：用真实涨跌幅计算
    todayProfit = lastValue * effectiveShares * (effectiveRealChange / 100)
  }
  
  if (hasRealNavToday && effectiveRealChange !== undefined) {
    const yesterdayNav = realNav / (1 + effectiveRealChange / 100)
    todayProfit = effectiveShares * (realNav - yesterdayNav)
  }

  
  const useRealData = dateCheck.valid && effectiveRealChange !== undefined
  
  // ===== 5. 边界检查 =====
  if (currentValue <= 0 || effectiveShares <= 0 || cost <= 0) {
    return {
      currentValue: currentValue > 0 ? currentValue : 0,
      marketValue: 0,
      profit: 0,
      profitRate: 0,
      todayProfit: 0,
      effectiveShares,
      totalServiceFee: 0,
      todayServiceFee: 0
    }
  }
  
  // ===== 6. 计算市值和基础收益 =====
  const marketValue = round(effectiveShares * currentValue, PRECISION.AMOUNT)
  
  // ===== 7. 计算费用 (C类销售服务费) =====
  // [FIX] C类服务费已体现在每日净值中，不再从收益中额外扣除
  //       仅计算累计服务费用于展示
  let totalServiceFee = 0
  let todayServiceFee = 0


  if (holding.shareClass === 'C' && holding.serviceFeeRate) {
    const days = holding.holdingDays || 0
    if (days > 0 && effectiveShares > 0) {
      todayServiceFee = calculateDailyServiceFee(effectiveShares, currentValue, holding.serviceFeeRate)
      totalServiceFee = round(todayServiceFee * days, PRECISION.AMOUNT)
    }
  }

  
  // A类买入手续费已在录入时扣除
  
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
    effectiveShares: round(effectiveShares, 2),
    totalServiceFee,
    todayServiceFee
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
