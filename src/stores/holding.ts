// [WHY] 持仓数据状态管理 - 重构版
// [WHAT] 管理用户持仓信息，集成精准计算、风控校验、完整日志
// [OPT] 高并发写入优化、数据一致性保证、接口兼容性
//
// [REFACTOR] v2.0 主要改进:
// 1. 引入独立计算引擎 (holdingCalculator)
// 2. 集成风控系统 (riskControl)
// 3. 完整操作日志 (holdingLogger)
// 4. 写入队列优化（防抖+批量）
// 5. 数据版本控制

import { defineStore } from 'pinia'
import { ref, computed } from 'vue'
import type { HoldingRecord, HoldingSummary, FundEstimate, PendingAdjustment } from '@/types/fund'
import {
  getHoldings,
  upsertHolding as storageUpsertHolding,
  removeHolding as storageRemoveHolding,
  getPendingAdjustments,
  savePendingAdjustments
} from '@/utils/storage'

import { fetchFundEstimateFast, fetchNetValueHistoryFast, fetchRealDayChange } from '@/api/fundFast'
import { getFundTypes } from '@/api/fund'
import { persistCache } from '@/api/tiantianApi'
import { fetchLatestValuationSettlement, rememberValuationSettlement } from '@/api/valuationGrid'

// 新增模块导入
import {
  calculateHoldingProfit,
  hasUsableCurrentEstimate,
  hasUsableEstimateChange,
  getValuationComparisonState,
  getTodayStr,
  isEstimateDateToday,
  isRetainedMarketEstimate,
  isTradingHours,
  shouldUseDelayedQdiiPublishedChange,
  selectLatestRealChange,
  shouldRetainCurrentIntradayEstimate,
  round,
  PRECISION,
  type CalcContext
} from '@/utils/holdingCalculator'

import { getRiskController } from '@/utils/riskControl'
import { getHoldingLogger } from '@/utils/holdingLogger'
import {
  findSettlementNav,
  calculateSubscriptionShares,
  getBeijingDateString,
  getCalendarDayDifference,
  getSettlementNavStartDate
} from '@/utils/tradingDate'

/** 持仓项（包含实时估值和收益计算） */
export interface HoldingWithProfit extends HoldingRecord {
  /** 当前估值（净值） */
  currentValue?: number
  /** 当前市值 */
  marketValue?: number
  /** 持有收益金额 */
  profit?: number
  /** 持有收益率 */
  profitRate?: number
  /** 当日涨跌幅（盘中显示估值，盘后显示真实涨跌幅） */
  todayChange?: string
  /** 当日估值涨跌幅（始终显示估值，用于实差计算） */
  estimateChange?: string
  /** 估值对应的日期时间，用于和真实净值按同一交易日比较 */
  estimateTime?: string
  /** 当日收益金额 */
  todayProfit?: number
  /** Latest published official profit from a date before today. */
  previousProfit?: number
  previousProfitRate?: number
  previousBaseValue?: number
  /** 是否加载中 */
  loading?: boolean
  /** 当日真实涨跌幅（盘后基金机构公布） */
  realChange?: number
  /** 真实涨跌幅对应的净值日期，用于区分今日公布与最近一次公布 */
  realChangeDate?: string
  /** 真实涨跌幅是否为今日数据 */
  isRealChangeToday?: boolean
}

/** 写入操作类型 */
interface WriteOperation {
  type: 'UPSERT' | 'DELETE' | 'BATCH'
  code?: string
  data?: HoldingRecord | HoldingRecord[]
  timestamp: number
  resolve?: () => void
}

export const useHoldingStore = defineStore('holding', () => {
  // ========== State ==========
  
  /** 持仓列表（包含收益计算） */
  const holdings = ref<HoldingWithProfit[]>([])
  
  /** 待确认调仓记录（加仓/减仓先记录，官方净值更新后确认） */
  const pendingAdjustments = ref<PendingAdjustment[]>([])

  
  /** 是否正在刷新 */
  const isRefreshing = ref(false)

  // ========== 内部实例 ==========
  
  const logger = getHoldingLogger()
  const riskController = getRiskController()

  // ========== 写入优化：队列 + 防抖 ==========
  
  let writeQueue: WriteOperation[] = []
  let writeTimer: ReturnType<typeof setTimeout> | null = null
  let isWriting = false
  let holdingsInitializationPromise: Promise<void> | null = null
  let holdingsInitialized = false
  const pendingSettlementLocks = new Set<string>()

  /**
   * 写入防抖延迟（毫秒）
   * [OPT] 多次操作在短时间内会合并为一次存储写入
   */
  const WRITE_DEBOUNCE_MS = 300

  /**
   * 加入写入队列
   * [OPT] 防止高并发场景下频繁写入 localStorage 导致性能问题
   */
  function queueWrite(operation: WriteOperation): Promise<void> {
    return new Promise((resolve) => {
      operation.resolve = resolve
      writeQueue.push(operation)
      
      if (!writeTimer) {
        writeTimer = setTimeout(flushWriteQueue, WRITE_DEBOUNCE_MS)
      }
    })
  }

  /**
   * 批量执行写入队列
   * [WHAT] 合并同一基金的多次 UPSERT 操作
   * [CONSISTENCY] 保证写入顺序和数据一致性
   */
  async function flushWriteQueue(): Promise<void> {
    if (isWriting || writeQueue.length === 0) {
      writeTimer = null
      return
    }

    isWriting = true
    const batch = [...writeQueue]
    writeQueue = []

    try {
      const startTime = performance.now()
      
      // 去重：同一代码只保留最后一次 UPSERT
      const latestOps = new Map<string, WriteOperation>()
      for (const op of batch) {
        if (op.type === 'UPSERT' && op.code && op.data) {
          latestOps.set(op.code, op)
        } else if (op.type === 'DELETE' && op.code) {
          latestOps.delete(op.code)
          // DELETE 操作立即执行
          executeDelete(op.code!)
        }
      }

      // 批量执行剩余的 UPSERT
      for (const [, op] of latestOps) {
        if (op.data) {
          executeUpsert(op.data as HoldingRecord)
        }
      }

      const duration = Math.round(performance.now() - startTime)
      logger.debug('STORAGE', 'FLUSH_BATCH', 
        `批量写入完成: ${batch.length} 个操作, 耗时 ${duration}ms`,
        { durationMs: duration }
      )
    } catch (error) {
      logger.error('STORAGE', 'FLUSH_ERROR', '批量写入失败', { error })
      
      // 写入失败时重试一次
      setTimeout(() => {
        try {
          for (const op of batch) {
            if (op.type === 'DELETE' && op.code) {
              executeDelete(op.code)
            } else if (op.type === 'UPSERT' && op.data) {
              executeUpsert(op.data as HoldingRecord)
            }
          }
        } catch {
          logger.error('STORAGE', 'RETRY_FAILED', '重试写入仍然失败')
        }
      }, 1000)
    } finally {
      isWriting = false
      
      // 解析所有 Promise
      for (const op of batch) {
        op.resolve?.()
      }

      // 如果在处理过程中又加入了新操作，继续处理
      if (writeQueue.length > 0) {
        writeTimer = setTimeout(flushWriteQueue, WRITE_DEBOUNCE_MS)
      } else {
        writeTimer = null
      }
    }
  }

  /**
   * 执行单个 UPSERT
   */
  function executeUpsert(record: HoldingRecord): void {
    try {
      storageUpsertHolding(record)
    } catch (error) {
      logger.error('STORAGE', 'UPSERT', 
        `写入失败: ${record.code}`, { error, code: record.code, name: record.name }
      )
      throw error
    }
  }

  /**
   * 执行单个 DELETE
   */
  function executeDelete(code: string): void {
    try {
      storageRemoveHolding(code)
    } catch (error) {
      logger.error('STORAGE', 'DELETE', 
        `删除失败: ${code}`, { error, code }
      )
      throw error
    }
  }

  /**
   * 强制立即写入（不经过队列）
   * [USE_CASE] 页面关闭前需要保存数据
   */
  async function forceFlush(): Promise<void> {
    if (writeTimer) {
      clearTimeout(writeTimer)
      writeTimer = null
    }
    await flushWriteQueue()
  }

  // ========== Getters ==========

  /** 持仓汇总统计 - 使用新计算引擎 */
  const summary = computed<HoldingSummary>(() => {
    let totalValue = 0
    let totalCost = 0
    let todayProfit = 0
    let yesterdayProfit = 0
    let yesterdayBaseValue = 0

    holdings.value.forEach((h) => {
      if (h.marketValue !== undefined && h.marketValue > 0) {
        totalValue += h.marketValue
      }
      // [FIX] 总成本与单基金计算保持一致：优先使用 holding.amount（精确成本），
      // 其次才用 shares × costPrice/costUnitPrice，避免四舍五入导致 0.01 级差异
      const costPrice = h.costPrice || h.costUnitPrice || h.buyNetValue || 0
      if (h.amount > 0) {
        totalCost += h.amount
      } else if (h.shares && costPrice > 0) {
        totalCost += h.shares * costPrice
      }
      if (h.todayProfit !== undefined) {
        todayProfit += h.todayProfit
      }
      if (h.previousProfit !== undefined && h.previousBaseValue !== undefined && h.previousBaseValue > 0) {
        yesterdayProfit += h.previousProfit
        yesterdayBaseValue += h.previousBaseValue
      }
    })

    const totalProfit = totalValue - totalCost
    const totalProfitRate = totalCost > 0 ? round((totalProfit / totalCost) * 100, PRECISION.PERCENT) : 0
    const todayBaseValue = totalValue - todayProfit
    const todayProfitRate = todayBaseValue > 0 ? round((todayProfit / todayBaseValue) * 100, PRECISION.PERCENT) : 0
    const yesterdayProfitRate = yesterdayBaseValue > 0
      ? round((yesterdayProfit / yesterdayBaseValue) * 100, PRECISION.PERCENT)
      : 0

    return {
      totalValue: round(totalValue, PRECISION.AMOUNT),
      totalCost: round(totalCost, PRECISION.AMOUNT),
      totalProfit: round(totalProfit, PRECISION.AMOUNT),
      totalProfitRate,
      todayProfit: round(todayProfit, PRECISION.AMOUNT),
      yesterdayProfit: round(yesterdayProfit, PRECISION.AMOUNT),
      yesterdayProfitRate,
      todayProfitRate
    }
  })

  /** 持仓基金代码列表 */
  const holdingCodes = computed(() => holdings.value.map((h) => h.code))

  /** 获取某只基金的待确认调仓记录 */
  const getPendingByCode = (code: string) => computed(() =>
    pendingAdjustments.value.filter((p) => p.code === code && p.status === 'pending')
  )


  /** 总资产价值（用于风控集中度计算） */
  const totalAssetValue = computed(() => summary.value.totalValue)

  // ========== Actions ==========

  /**
   * 初始化持仓列表
   * [WHY] APP 启动时从本地存储恢复数据
   * [OPT] 立即显示缓存估值（Stale-While-Revalidate），后台静默刷新最新数据
   */
  function initHoldings(): Promise<void> {
    if (holdingsInitialized) return Promise.resolve()
    if (!holdingsInitializationPromise) {
      holdingsInitializationPromise = initializeHoldings().finally(() => {
        holdingsInitializationPromise = null
      })
    }
    return holdingsInitializationPromise
  }

  async function initializeHoldings() {
    const startTime = performance.now()
    
    try {
      const records = getHoldings()
      // 同时恢复待确认调仓记录
      pendingAdjustments.value = getPendingAdjustments()
      logger.info('INIT', 'LOAD', `从本地加载 ${records.length} 条持仓记录，${pendingAdjustments.value.length} 条待确认调仓`)

      
      // [WHAT] 先从 fund-list.json 批量获取基金类型
      const codes = records.map((r) => r.code)
      const typeMap = await getFundTypes(codes).catch(() => new Map<string, string>())
      
      holdings.value = records.map((r) => ({
        ...r,
        type: r.type || typeMap.get(r.code) || '',
        loading: true
      }))
      
      // [OPT] ★ 核心优化：先从 localStorage 读取上次估值并立即显示！
      if (records.length > 0) {
        let cacheHitCount = 0
        for (const record of records) {
          const cachedEstimate = persistCache.get<FundEstimate>(`estimate_${record.code}`)
          if (cachedEstimate && cachedEstimate.gsz && cachedEstimate.gsz !== '--') {
            updateHoldingWithNewEngine(record.code, cachedEstimate)
            cacheHitCount++
          }
        }
        
        logger.debug('INIT', 'CACHE_RESTORE', 
          `缓存恢复: ${cacheHitCount}/${records.length} 只基金`)
        
        // 后台刷新最新估值（不阻塞UI渲染）
        refreshEstimates()
      }

      const duration = Math.round(performance.now() - startTime)
      holdingsInitialized = true
      logger.info('INIT', 'COMPLETE', 
      `初始化完成: ${records.length} 只基金, 耗时 ${duration}ms`, 
      { durationMs: duration, success: true, data: { count: records.length } }
    )
    } catch (error) {
      logger.error('INIT', 'ERROR', '初始化持仓失败', { error })
    }
  }

  /**
   * 记录初始化日志（便捷方法）- 已内联到 initHoldings()
   */

  /**
   * 刷新所有持仓的估值和收益
   * [OPT] 流式更新：每只基金加载完立即更新UI，不等待全部完成
   * [NEW] 使用新的计算引擎和完整日志记录
   */
  async function refreshEstimates() {
    if (holdings.value.length === 0) {
      isRefreshing.value = false
      return
    }
    if (isRefreshing.value) return

    updateHoldingDays()
    isRefreshing.value = true
    const startTime = performance.now()
    const codes = holdings.value.map((h) => h.code)

    logger.logRefreshStart(codes.length)

    let successCount = 0
    let failCount = 0

    try {
      // [OPT] 流式更新：每只基金独立请求，完成后立即更新UI
      const estimatePromises = codes.map(async (code, index) => {
        const fundStart = performance.now()
        
        try {
          const [data, realData] = await Promise.all([
            fetchFundEstimateFast(code),
            fetchRealDayChange(code).catch(() => null)
          ])

          // A single atomic update prevents the previous official NAV from
          // briefly replacing the same-day estimate while refresh is running.
          updateHoldingWithNewEngine(
            code,
            data,
            realData?.changeRate,
            realData?.date,
            realData?.nav
          )
          if (realData) {
            await confirmPendingAdjustments(code, realData.date)
          }
          await hydrateHoldingSettlementIfMissing(code)
          successCount++
          
          const fundDuration = Math.round(performance.now() - fundStart)
          logger.logSingleFundRefresh(
            code, 
            holdings.value.find(h => h.code === code)?.name || '', 
            true, 
            fundDuration
          )
          
        } catch (error) {
          failCount++
          
          const fundDuration = Math.round(performance.now() - fundStart)
          logger.logSingleFundRefresh(
            code,
            holdings.value.find(h => h.code === code)?.name || '',
            false,
            fundDuration
          )
          
          // 单只失败不影响其他基金
          const item = holdings.value.find((h) => h.code === code)
          if (item) item.loading = false
        }
      })
      
      // [OPT] 等待所有请求完成（但UI已经流式更新了）
      await Promise.all(estimatePromises)
    } finally {
      isRefreshing.value = false
      const totalDuration = Math.round(performance.now() - startTime)
      
      logger.logRefreshComplete(codes.length, successCount, failCount, totalDuration)
    }
  }

  async function hydrateHoldingSettlementIfMissing(code: string) {
    const holding = holdings.value.find((item) => item.code === code)
    if (!holding) return
    // A provider can stamp a new date while returning `--`. That is not an
    // estimate, so keep hydrating the previous completed estimate/NAV pair.
    if (isEstimateDateToday(holding.estimateTime || '', getTodayStr()) && hasUsableEstimateChange(holding.estimateChange)) return

    const current = getValuationComparisonState({
      realChange: holding.realChange,
      realChangeDate: holding.realChangeDate,
      estimateChange: holding.estimateChange,
      estimateTime: holding.estimateTime,
      fundName: holding.name
    })
    if (current.isTrading || current.hasActualDiff) return

    const settlement = await fetchLatestValuationSettlement(code)
    if (!settlement) return

    const comparison = getValuationComparisonState({
      realChange: settlement.realChange,
      realChangeDate: settlement.date,
      estimateChange: settlement.estimateChange,
      estimateTime: `${settlement.date} 15:00`,
      fundName: holding.name
    })
    if (!comparison.hasActualDiff) return

    Object.assign(holding, {
      estimateChange: settlement.estimateChange.toFixed(4),
      estimateTime: `${settlement.date} 15:00`,
      realChange: settlement.realChange,
      realChangeDate: settlement.date,
      todayChange: '--',
      isRealChangeToday: false,
      loading: false
    })
  }

  /**
   * ★ 核心新方法：使用新计算引擎更新单只持仓
   * [REPLACE] 替代旧的 updateHoldingWithEstimate 方法
   * [IMPROVED] 更精确的计算、更好的可读性、完整的日志记录
   */
  function updateHoldingWithNewEngine(
    code: string, 
    data: FundEstimate, 
    realChange?: number | null, 
    realChangeDate?: string | null,
    realNav?: number | null
  ) {
    const index = holdings.value.findIndex((h) => h.code === code)
    if (index === -1) return

    const holding = holdings.value[index]
    const now = new Date()
    const latestReal = selectLatestRealChange({
      incomingChange: realChange,
      incomingDate: realChangeDate,
      cachedChange: holding.realChange,
      cachedDate: holding.realChangeDate
    })
    const effectiveRealChange = latestReal.change
    const effectiveRealDate = latestReal.date
    const retainCachedIntradayEstimate = shouldRetainCurrentIntradayEstimate({
      incomingEstimateChange: data.gszzl,
      incomingEstimateTime: data.gztime,
      cachedEstimateChange: holding.estimateChange,
      cachedEstimateTime: holding.estimateTime,
      now
    })
    const estimate = retainCachedIntradayEstimate
      ? {
          ...data,
          gsz: Number.isFinite(Number(data.gsz)) && Number(data.gsz) > 0
            ? data.gsz
            : String(holding.currentValue || data.gsz),
          gszzl: holding.estimateChange || data.gszzl,
          gztime: holding.estimateTime || data.gztime
        }
      : data
    
    // 构建计算上下文
    const context: CalcContext = {
      holding: holding as HoldingRecord,
      estimate,
      realChange: effectiveRealChange,
      realChangeDate: effectiveRealDate,
      realNav,
      now
    }

    // 使用新引擎计算
    const result = calculateHoldingProfit(context)
    
    const today = getTodayStr(now)
    const isEstimateToday = isEstimateDateToday(estimate.gztime || '', today)
    const retainedMarketEstimate = isRetainedMarketEstimate(estimate)
    
    // 确定显示的涨跌幅
    // The all-market snapshot contains an already-published NAV. It is useful
    // for pricing, but must never replace the captured intraday estimate in
    // the "估值 | 昨" comparison.
    const incomingIsOfficialSnapshot = estimate.source === 'market_snapshot'
    const incomingComparison = getValuationComparisonState({
      realChange: effectiveRealChange,
      realChangeDate: effectiveRealDate,
      estimateChange: incomingIsOfficialSnapshot ? null : estimate.gszzl,
      estimateTime: incomingIsOfficialSnapshot ? null : estimate.gztime,
      fundName: holding.name,
      now
    })
    const cachedComparison = getValuationComparisonState({
      realChange: effectiveRealChange,
      realChangeDate: effectiveRealDate,
      estimateChange: holding.estimateChange,
      estimateTime: holding.estimateTime,
      fundName: holding.name,
      now
    })
    // Preserve the last settled comparison through the next trading day's
    // pre-open period; providers can report a new timestamp before 9:30.
    const useCachedCompletedEstimate = cachedComparison.hasActualDiff && (
      incomingIsOfficialSnapshot ||
      (!isEstimateToday && !incomingComparison.isTrading && !incomingComparison.hasActualDiff)
    )
    const comparison = useCachedCompletedEstimate ? cachedComparison : incomingComparison
    const trading = comparison.isTrading
    const displayEstimateChange = useCachedCompletedEstimate ? holding.estimateChange : estimate.gszzl
    const displayEstimateTime = useCachedCompletedEstimate ? holding.estimateTime : estimate.gztime
    
    const isRealChangeToday = comparison.isCurrentReal
    const useDelayedQdiiPublishedChange = shouldUseDelayedQdiiPublishedChange({
      fundName: holding.name,
      realChange: effectiveRealChange,
      realChangeDate: effectiveRealDate,
      now
    })
    const officialChange = Number(effectiveRealChange)
    const officialNav = Number(realNav)
    const hasCurrentEstimate = hasUsableCurrentEstimate(estimate, today) ||
      retainedMarketEstimate ||
      (retainCachedIntradayEstimate && hasUsableEstimateChange(estimate.gszzl))
    const hasOfficialNavToday = isRealChangeToday && Number.isFinite(officialNav) && officialNav > 0
    const officialDenominator = 1 + officialChange / 100
    const fallbackBaseNav = Number(estimate.dwjz)
    const officialBaseNav = Number.isFinite(officialNav) && officialNav > 0 && officialDenominator > 0
      ? officialNav / officialDenominator
      : fallbackBaseNav
    const isPreviousOfficial = Boolean(effectiveRealDate) && effectiveRealDate! < today
    const previousBaseValue = isPreviousOfficial && Number.isFinite(officialBaseNav) && officialBaseNav > 0
      ? round(officialBaseNav * result.effectiveShares, PRECISION.AMOUNT)
      : holding.previousBaseValue
    const previousProfit = isPreviousOfficial && previousBaseValue !== undefined && Number.isFinite(officialChange)
      ? round(previousBaseValue * officialChange / 100, PRECISION.AMOUNT)
      : holding.previousProfit
    const previousProfitRate = isPreviousOfficial && Number.isFinite(officialChange)
      ? officialChange
      : holding.previousProfitRate

    if (comparison.hasActualDiff && hasUsableEstimateChange(displayEstimateChange) && effectiveRealDate) {
      rememberValuationSettlement(code, {
        date: effectiveRealDate,
        estimateChange: Number(displayEstimateChange),
        realChange: Number(effectiveRealChange),
        source: 'local-cache'
      })
    }
    
    // 构建今日涨跌幅显示值
    let displayTodayChange: string
    if (hasOfficialNavToday && effectiveRealChange !== undefined) {
      displayTodayChange = effectiveRealChange.toFixed(2)
    } else if (hasCurrentEstimate) {
      displayTodayChange = estimate.gszzl || '--'
    } else if (useDelayedQdiiPublishedChange && effectiveRealChange !== undefined) {
      displayTodayChange = effectiveRealChange.toFixed(2)
    } else if (trading) {
      // 盘中：优先显示估值
      displayTodayChange = '--'
    } else {
      // 盘后：优先显示真实涨跌幅
      if (comparison.hasActualDiff && effectiveRealChange !== undefined && effectiveRealChange !== null) {
        displayTodayChange = effectiveRealChange.toFixed(2)
      } else {
        displayTodayChange = (isEstimateToday || retainedMarketEstimate) ? (estimate.gszzl || '--') : '--'
      }
    }

    // 更新持仓数据
    holdings.value[index] = {
      ...holding,
      name: estimate.name || holding.name,
      currentValue: result.currentValue,
      marketValue: result.marketValue,
      profit: result.profit,
      profitRate: result.profitRate,
      todayChange: displayTodayChange,
      estimateChange: (isEstimateToday || retainedMarketEstimate || comparison.hasActualDiff) ? (displayEstimateChange || '--') : '--',
      estimateTime: displayEstimateTime,
      todayProfit: (hasCurrentEstimate || hasOfficialNavToday || useDelayedQdiiPublishedChange) ? result.todayProfit : undefined,
      previousProfit,
      previousProfitRate,
      previousBaseValue,
      loading: false,
      shares: result.effectiveShares,
      serviceFeeDeducted: undefined,
      realChange: effectiveRealChange,
      realChangeDate: effectiveRealDate,
      isRealChangeToday
    }

    // [DEBUG] 详细计算日志（仅在 DEBUG 级别输出）
    logger.logCalculationDetail(code, 'UPDATE_COMPLETE', {
      estimateValue: data.gsz,
      lastValue: data.dwjz,
      shares: holding.shares,
      amount: holding.amount
    }, {
      currentValue: result.currentValue,
      marketValue: result.marketValue,
      profit: result.profit,
      todayProfit: result.todayProfit
    })
  }

  /**
   * 添加或更新持仓（带风控检查）
   * [SECURITY] 先进行风控校验，通过后才执行
   * [COMPATIBLE] 保持原有 API 签名不变
   */
  async function addOrUpdateHolding(record: HoldingRecord): Promise<boolean> {
    const startTime = performance.now()
    
    try {
      // ===== 1. 风控检查 =====
      const riskResult = riskController.checkRisk({
        record,
        existingHoldings: holdings.value as HoldingRecord[],
        totalAssetValue: totalAssetValue.value,
        isAddOperation: !holdings.value.some(h => h.code === record.code)
      })
      
        logger.logRiskCheck(record.code, record.name, riskResult.passed, {
        warnings: riskResult.warnings,
        errors: riskResult.errors,
        score: riskResult.score
      })
      
      if (!riskResult.passed) {
        logger.warn('HOLDING', 'ADD_BLOCKED', 
          `添加被风控拦截: ${record.code}`,
          { code: record.code, name: record.name, data: { errors: riskResult.errors } as Record<string, unknown> }
        )
        
        // 返回错误信息供 UI 显示
        throw new Error(riskResult.errors.join('; '))
      }
      
      // 输出警告但不阻止操作
      if (riskResult.warnings.length > 0) {
        console.warn('[Holding] 风控警告:', riskResult.warnings)
      }

      // ===== 2. 加入写入队列 =====
      await queueWrite({
        type: 'UPSERT',
        code: record.code,
        data: record,
        timestamp: Date.now()
      })

      // ===== 3. 更新内存中的数据 =====
      const index = holdings.value.findIndex((h) => h.code === record.code)
      if (index > -1) {
        holdings.value[index] = {
          ...holdings.value[index],
          ...record
        }
      } else {
        holdings.value.push({
          ...record,
          loading: true
        })
      }

      // ===== 4. 记录交易（频率统计） =====
      riskController.recordTrade(record.amount)

      // ===== 5. 刷新估值 =====
      await refreshEstimates()

      const duration = Math.round(performance.now() - startTime)
      logger.logHoldingAdd(record.code, record.name, record.amount, true)
      logger.debug('HOLDING', 'ADD_COMPLETE', 
        `操作完成: ${record.code}, 耗时 ${duration}ms`,
        { code: record.code, durationMs: duration }
      )

      return true
    } catch (error) {
      const duration = Math.round(performance.now() - startTime)
      logger.logHoldingAdd(record.code, record.name, record.amount, false, error)
      
      throw error
    }
  }

  /**
   * 直接添加持仓到内存（不触发刷新）
   * [USE_CASE] 批量导入时避免每添加一只就刷新一次
   * [COMPATIBLE] 保持原有 API 不变
   */
  async function addHoldingDirect(record: HoldingRecord): Promise<void> {
    // 简化的风控检查（仅做基本校验）
    const riskResult = riskController.checkRisk({
      record,
      existingHoldings: holdings.value as HoldingRecord[],
      isAddOperation: true
    })
    
    if (!riskResult.passed) {
      logger.warn('HOLDING', 'DIRECT_ADD_WARN', 
        `直接添加存在风险: ${record.code}`,
        { code: record.code, data: { warnings: riskResult.warnings } } as Record<string, unknown>
      )
      // 批量导入时仅警告，不阻止
    }

    await queueWrite({
      type: 'UPSERT',
      code: record.code,
      data: record,
      timestamp: Date.now()
    })

    holdings.value.push({
      ...record,
      loading: true
    })
  }

  /**
   * 删除持仓
   * [COMPATIBLE] 保持原有 API 不变
   */
  async function removeHolding(code: string): Promise<boolean> {
    const startTime = performance.now()
    const holding = holdings.value.find((h) => h.code === code)
    
    try {
      // 加入写入队列
      await queueWrite({
        type: 'DELETE',
        code,
        timestamp: Date.now()
      })

      // 从内存中移除
      const index = holdings.value.findIndex((h) => h.code === code)
      if (index > -1) {
        holdings.value.splice(index, 1)
      }

      const duration = Math.round(performance.now() - startTime)
      logger.logHoldingDelete(code, holding?.name || '', true)
      logger.debug('HOLDING', 'DELETE_COMPLETE',
        `删除完成: ${code}, 耗时 ${duration}ms`,
        { code, durationMs: duration }
      )

      return true
    } catch (error) {
      logger.logHoldingDelete(code, holding?.name || '', false)
      throw error
    }
  }

  /**
   * 检查是否有该基金的持仓
   * [COMPATIBLE] 保持原有 API 不变
   */
  function hasHolding(code: string): boolean {
    return holdingCodes.value.includes(code)
  }

  /**
   * 获取单个持仓
   * [COMPATIBLE] 保持原有 API 不变
   */
  function getHoldingByCode(code: string): HoldingWithProfit | undefined {
    return holdings.value.find((h) => h.code === code)
  }

  /**
   * 更新持仓天数
   * [WHY] 每次刷新时更新持仓天数
   * [COMPATIBLE] 保持原有 API 不变
   */
  function updateHoldingDays() {
    const today = getBeijingDateString()
    holdings.value.forEach((h) => {
      if (h.buyDate) {
        h.holdingDays = getCalendarDayDifference(h.buyDate, today)
      }
    })
  }

  // ========== 待确认调仓（加仓/减仓）管理 ==========

  /**
   * 加载待确认调仓记录
   */
  function loadPendingAdjustments() {
    pendingAdjustments.value = getPendingAdjustments()
  }

  /**
   * 添加待确认调仓记录
   * [WHY] 15:00前/后加仓减仓不立即修改持仓，只记录，等官方净值更新后确认
   */
  async function addPendingAdjustment(record: PendingAdjustment): Promise<void> {
    pendingAdjustments.value.push(record)
    savePendingAdjustments(pendingAdjustments.value)
    logger.info(
      'PENDING',
      record.type === 'add' ? 'ADD_RECORD' : 'REDUCE_RECORD',
      `${record.code} ${record.type === 'add' ? '加仓' : '减仓'} 待确认，确认日=${record.confirmDate}`,
      { code: record.code, name: record.name, shares: record.shares, amount: record.amount }
    )
  }

  /**
   * 取消待确认调仓记录
   */
  async function cancelPendingAdjustment(id: string): Promise<void> {
    pendingAdjustments.value = pendingAdjustments.value.filter((p) => p.id !== id)
    savePendingAdjustments(pendingAdjustments.value)
  }

  /**
   * 立即应用待确认调仓到持仓（内部使用）
   */
  async function applyAdjustment(pending: PendingAdjustment, settlementNav: number): Promise<void> {
    const holding = holdings.value.find((h) => h.code === pending.code)
    if (!holding) return

    if (pending.type === 'add') {
      const settledShares = round(calculateSubscriptionShares(pending.amount, pending.fee, settlementNav), 4)
      const newShares = (holding.shares || 0) + settledShares
      const newAmount = (holding.amount || 0) + pending.amount
      const newCostPrice = newShares > 0 ? newAmount / newShares : 0
      const updatedRecord: HoldingRecord = {
        ...holding,
        amount: round(newAmount, PRECISION.AMOUNT),
        shares: newShares,
        buyNetValue: round(settlementNav, PRECISION.RATE),
        costUnitPrice: round(newCostPrice, PRECISION.RATE),
        costPrice: round(newCostPrice, PRECISION.RATE),
        buyFeeAmount: (holding.buyFeeAmount || 0) + pending.fee
      }
      await addOrUpdateHolding(updatedRecord)
    } else if (pending.type === 'reduce') {
      const currentShares = holding.shares || 0
      const remainingShares = currentShares - pending.shares
      if (remainingShares <= 0.0001) {
        await removeHolding(pending.code)
      } else {
        const newAmount = Math.max(0, (holding.amount || 0) - pending.amount)
        const newCostPrice = newAmount / remainingShares
        const updatedRecord: HoldingRecord = {
          ...holding,
          amount: round(newAmount, PRECISION.AMOUNT),
          shares: remainingShares,
          buyNetValue: round(newCostPrice, PRECISION.RATE),
          costUnitPrice: round(newCostPrice, PRECISION.RATE),
          costPrice: round(newCostPrice, PRECISION.RATE)
        }
        await addOrUpdateHolding(updatedRecord)
      }
    }

    pending.status = 'confirmed'
    savePendingAdjustments(pendingAdjustments.value)
    logger.info(
      'PENDING',
      'CONFIRMED',
      `${pending.code} 调仓已确认并清除记录`,
      { code: pending.code, type: pending.type, shares: pending.shares, amount: pending.amount }
    )

    // 确认后从列表中移除
    pendingAdjustments.value = pendingAdjustments.value.filter((p) => p.id !== pending.id)
    savePendingAdjustments(pendingAdjustments.value)
  }

  /**
   * 检查并确认已到确认日的待确认调仓记录
   * [WHEN] 每次官方净值更新后调用（realNav 有值且日期有效）
   */
  async function confirmPendingAdjustments(code?: string, realNavDate?: string | null): Promise<void> {
    if (pendingAdjustments.value.length === 0) return

    const effectiveDate = realNavDate || getTodayStr(new Date())

    const toConfirm = pendingAdjustments.value.filter(
      (p) => p.status === 'pending' && (!code || p.code === code) && !pendingSettlementLocks.has(p.id)
    )

    if (toConfirm.length === 0) return

    for (const pending of toConfirm) {
      pendingSettlementLocks.add(pending.id)
      try {
        const history = await fetchNetValueHistoryFast(pending.code, 1500)
        const settlementStartDate = getSettlementNavStartDate(pending.tradeDate, pending.timeSlot)
        const settlement = findSettlementNav(history, settlementStartDate, effectiveDate)
        if (!settlement) continue

        await applyAdjustment(pending, settlement.netValue)
      } catch (error) {
        logger.error('PENDING', 'SETTLEMENT_FAILED', `Settlement failed: ${pending.code}`, {
          code: pending.code,
          error
        })
      } finally {
        pendingSettlementLocks.delete(pending.id)
      }
    }

    // addOrUpdateHolding 内部已触发刷新，这里不再额外调用
    logger.info('PENDING', 'BATCH_CONFIRMED', `已确认 ${toConfirm.length} 条待确认调仓`, { count: toConfirm.length })
  }



  /**
   * 获取风控配置
   * [NEW] 提供给设置页面使用
   */
  function getRiskConfig() {
    return riskController.getConfig()
  }

  /**
   * 更新风控配置
   * [NEW] 提供给设置页面使用
   */
  function updateRiskConfig(updates: Record<string, unknown>) {
    riskController.updateConfig(updates)
    logger.info('RISK', 'CONFIG_UPDATE', '风控配置已更新', { data: updates })
  }

  /**
   * 获取日志统计
   * [NEW] 用于调试和问题排查
   */
  function getLoggerStats() {
    return logger.getLogStats()
  }

  /**
   * 导出日志
   * [NEW] 用于问题排查
   */
  function exportLogs(level?: 'WARN' | 'ERROR', limit?: number) {
    return logger.exportLogs(level, limit)
  }

  /**
   * 清除日志
   * [NEW] 用户主动清理
   */
  function clearLogs() {
    logger.clearLogs()
  }

  /**
   * 页面关闭前的清理工作
   * [WHAT] 确保所有待写入的数据都已保存
   */
  async function beforeUnload(): Promise<void> {
    await forceFlush()
    logger.debug('LIFECYCLE', 'BEFORE_UNLOAD', '页面关闭，已保存所有数据')
  }

  return {
    // State
    holdings,
    pendingAdjustments,
    isRefreshing,
    // Getters
    summary,
    holdingCodes,
    totalAssetValue,
    getPendingByCode,
    // Actions - 核心功能（保持兼容）
    initHoldings,
    refreshEstimates,
    addOrUpdateHolding,
    addHoldingDirect,
    removeHolding,
    hasHolding,
    getHoldingByCode,
    updateHoldingDays,
    // Actions - 待确认调仓
    loadPendingAdjustments,
    addPendingAdjustment,
    cancelPendingAdjustment,
    confirmPendingAdjustments,
    // Actions - 新增功能
    getRiskConfig,
    updateRiskConfig,
    getLoggerStats,
    exportLogs,
    clearLogs,
    beforeUnload,
    forceFlush
  }

})
