// [WHY] 基金数据状态管理，集中管理自选列表和实时估值
// [WHAT] 使用 Pinia 管理响应式状态，实现数据和 UI 的自动同步
// [DEPS] 依赖 storage 工具持久化数据，依赖 fund API 获取实时数据

import { defineStore } from 'pinia'
import { ref, computed, onUnmounted } from 'vue'
import type { WatchlistItem, FundEstimate, PeriodReturnItem, DataSource } from '@/types/fund'
import { 
  fetchFundEstimateFast, 
  fetchRealDayChange, 
  calculatePeriodReturns,
  fetchFundEstimateBySource,
  fetchSourceComparison,
  fetchSinaEstimate
} from '@/api/fundFast'
import { getFundTypes } from '@/api/fund'
import {
  getWatchlist,
  saveWatchlist,
  addToWatchlist as addToStorage,
  removeFromWatchlist as removeFromStorage,
  isInWatchlist,
  getWatchlistOrder,
  saveWatchlistOrder
} from '@/utils/storage'
import { useSettingsStore } from './settings'
import { getTodayStr, getValuationComparisonState, hasUsableEstimateChange, isEstimateDateToday, isRetainedMarketEstimate, selectLatestRealChange, shouldRetainCurrentIntradayEstimate } from '@/utils/holdingCalculator'
import { fetchLatestValuationSettlement, rememberValuationSettlement } from '@/api/valuationGrid'

export const useFundStore = defineStore('fund', () => {
  // ========== State ==========
  
  /** 自选基金列表（包含实时估值） */
  const watchlist = ref<WatchlistItem[]>([])
  
  /** 是否正在刷新 */
  const isRefreshing = ref(false)
  
    /** 上次刷新时间 */
  const lastRefreshTime = ref<string>('')
  
  /** 自动刷新定时器 */
  let refreshTimer: ReturnType<typeof setInterval> | null = null

  // ========== Getters ==========
  
  /** 自选基金代码列表 */
  const watchlistCodes = computed(() => watchlist.value.map((item) => item.code))

  // ========== Actions ==========

  /**
   * 初始化自选列表
   * [WHY] APP 启动时从本地存储恢复数据
   */
    async function initWatchlist() {
    const codes = getWatchlist()
    // [WHAT] 先从 fund-list.json 批量获取基金类型
    const typeMap = await getFundTypes(codes).catch(() => new Map<string, string>())
    watchlist.value = codes.map((code) => ({
      code,
      name: '',
      type: typeMap.get(code) || '',
      loading: true
    }))
    // [WHAT] 初始化后立即刷新估值
    if (codes.length > 0) {
      refreshEstimates()
    }
  }

    /**
   * 判断当前是否为交易时间
   * 交易时间：周一至周五 9:30-15:00
   */
  function isTradingTime(): boolean {
    const now = new Date()
    const day = now.getDay()
    // 周末不交易
    if (day === 0 || day === 6) return false
    
    const hours = now.getHours()
    const minutes = now.getMinutes()
    const timeMinutes = hours * 60 + minutes
    
    // 9:30 - 15:00
    return timeMinutes >= 570 && timeMinutes <= 900
  }

    /**
   * 获取当前应使用的刷新间隔（毫秒）
   */
  function getCurrentInterval(): number {
    const settingsStore = useSettingsStore()
    if (!settingsStore.autoRefresh) return 0
    
    return isTradingTime() 
      ? settingsStore.tradingInterval * 1000 
      : settingsStore.afterHoursInterval * 1000
  }

    /**
   * 启动自动刷新
   */
  function startAutoRefresh() {
    stopAutoRefresh()
    const interval = getCurrentInterval()
    if (interval <= 0) return // 自动刷新已禁用
    
    refreshTimer = setInterval(() => {
      if (watchlist.value.length > 0) {
        refreshEstimates()
      }
    }, interval)
  }

  /**
   * 停止自动刷新
   */
  function stopAutoRefresh() {
    if (refreshTimer) {
      clearInterval(refreshTimer)
      refreshTimer = null
    }
  }

  /**
   * 重启自动刷新（设置变更后调用）
   */
  function restartAutoRefresh() {
    stopAutoRefresh()
    startAutoRefresh()
  }

    /**
   * 刷新所有自选基金的估值
   * [WHY] 下拉刷新或定时刷新时调用
   */
  async function refreshEstimates() {
    if (watchlist.value.length === 0) {
      // [EDGE] 没有自选时也需要重置刷新状态
      isRefreshing.value = false
      return
    }
    
    isRefreshing.value = true
    const codes = watchlist.value.map((item) => item.code)
    
        try {
      // [WHAT] 并发请求所有基金估值 + 真实涨跌幅
      const [estimateResults, realChangeResults] = await Promise.all([
        Promise.all(codes.map(code => fetchFundEstimateFast(code).catch(() => null))),
        Promise.all(codes.map(code => fetchRealDayChange(code).catch(() => null)))
      ])
      
      // [WHAT] 更新每只基金的估值数据
      estimateResults.forEach((data, index) => {
        if (data) {
          updateFundData(codes[index], data, realChangeResults[index] ?? undefined)
        } else {
          // [EDGE] 请求失败时保留原数据，但标记加载完成
          const item = watchlist.value.find((f) => f.code === codes[index])
          if (item) {
            item.loading = false
          }
        }
      })

      // Non-trading fallback only: recover a completed pair from the grid API
      // when the public estimate feed no longer returns yesterday's value.
      await Promise.all(codes.map(code => hydrateSettlementIfMissing(code)))
      
      lastRefreshTime.value = new Date().toLocaleTimeString('zh-CN', {
        hour: '2-digit',
        minute: '2-digit'
      })
    } finally {
      isRefreshing.value = false
    }
  }

  async function hydrateSettlementIfMissing(code: string) {
    const item = watchlist.value.find((fund) => fund.code === code)
    if (!item) return
    if (isEstimateDateToday(item.estimateTime || '', getTodayStr()) && hasUsableEstimateChange(item.estimateChange)) return

    const current = getValuationComparisonState({
      realChange: item.realChange,
      realChangeDate: item.realChangeDate,
      estimateChange: item.estimateChange,
      estimateTime: item.estimateTime,
      fundName: item.name
    })
    if (current.isTrading || current.hasActualDiff) return

    const settlement = await fetchLatestValuationSettlement(code)
    if (!settlement) return

    const comparison = getValuationComparisonState({
      realChange: settlement.realChange,
      realChangeDate: settlement.date,
      estimateChange: settlement.estimateChange,
      estimateTime: `${settlement.date} 15:00`,
      fundName: item.name
    })
    if (!comparison.hasActualDiff) return

    Object.assign(item, {
      estimateChange: settlement.estimateChange.toFixed(4),
      estimateTime: `${settlement.date} 15:00`,
      realChange: settlement.realChange,
      realChangeDate: settlement.date,
      isRealChangeToday: false,
      loading: false
    })
  }

  /**
   * 获取单只基金的阶段涨幅
   * [WHY] 用于左滑显示走势业绩信息
   */
  async function fetchPeriodReturns(code: string): Promise<PeriodReturnItem[]> {
    try {
      const returns = await calculatePeriodReturns(code)
      return returns.map(r => ({
        period: r.period,
        label: r.label,
        change: r.change
      }))
    } catch {
      return []
    }
  }

    /**
   * 刷新单只基金估值
   * [FIX] 使用当前设置的数据源，finally 确保 loading 重置
   */
  async function refreshSingleFund(code: string) {
    const ds = getFundDataSource(code)
    
    try {
      if (ds === 'fundgz') {
        const [data, realChange] = await Promise.all([
          fetchFundEstimateFast(code),
          fetchRealDayChange(code).catch(() => null)
        ])
        updateFundData(code, data, realChange ?? undefined)
      } else {
        const [data, realChange] = await Promise.all([
          fetchFundEstimateBySource(code, ds),
          fetchRealDayChange(code).catch(() => null)
        ])
        
        if (!data || !data.gszzl) {
          // 新浪返回空，降级
          const fallback = await fetchFundEstimateFast(code)
          updateFundData(code, fallback, realChange ?? undefined)
        } else {
          updateFundDataWithSource(code, data, ds, realChange ?? undefined)
        }
      }
      await hydrateSettlementIfMissing(code)
      console.log(`[Store] ${code} 刷新完成, 数据源: ${ds}`)
    } catch (err) {
      console.error(`[Store] ${code} 刷新失败:`, err)
      // 降级
      if (ds !== 'fundgz') {
        try {
          const fallback = await fetchFundEstimateFast(code)
          updateFundData(code, fallback)
        } catch (e) { /* 最终失败 */ }
      }
    } finally {
      // [FIX] 强制重置 loading
      const item = watchlist.value.find(f => f.code === code)
      if (item && item.loading) item.loading = false
    }
  }

    /**
   * 更新单只基金数据
   * [WHAT] 将 API 返回的数据更新到 watchlist 中
   * [EDGE] QDII基金在非交易日时，估值日期可能不是今天，需要特殊处理
   */
  function updateFundData(code: string, data: FundEstimate, realChangeResult?: { changeRate: number; date: string } | null) {
    const index = watchlist.value.findIndex((item) => item.code === code)
    if (index > -1) {
      // [WHAT] 保留已有的 type 和 realChange，避免丢失
      const existingType = watchlist.value[index].type || ''
      const existingRealChange = watchlist.value[index].realChange
      const existingRealChangeDate = watchlist.value[index].realChangeDate
      const existingEstimateChange = watchlist.value[index].estimateChange
      const existingEstimateTime = watchlist.value[index].estimateTime
      
      // [WHAT] 处理真实涨跌幅数据
      let realChange: number | undefined
      let realChangeDate: string | undefined
      
      if (realChangeResult && realChangeResult.changeRate !== undefined) {
        realChange = realChangeResult.changeRate
        realChangeDate = realChangeResult.date
        
      } else {
        // 保留旧值
        realChange = existingRealChange
        realChangeDate = existingRealChangeDate
      }

      const latestReal = selectLatestRealChange({
        incomingChange: realChange,
        incomingDate: realChangeDate,
        cachedChange: existingRealChange,
        cachedDate: existingRealChangeDate
      })
      realChange = latestReal.change
      realChangeDate = latestReal.date

      const retainCachedIntradayEstimate = shouldRetainCurrentIntradayEstimate({
        incomingEstimateChange: data.gszzl,
        incomingEstimateTime: data.gztime,
        cachedEstimateChange: existingEstimateChange,
        cachedEstimateTime: existingEstimateTime
      })
      const incomingIsOfficialSnapshot = data.source === 'market_snapshot'
      // The all-market snapshot is a published NAV result, not an estimate.
      // Keeping it out of the estimate fields prevents a false
      // "estimate = yesterday = actual" comparison on the watchlist.
      const estimateChangeValue = retainCachedIntradayEstimate
        ? existingEstimateChange
        : incomingIsOfficialSnapshot ? undefined : data.gszzl
      const estimateTimeValue = retainCachedIntradayEstimate
        ? existingEstimateTime
        : incomingIsOfficialSnapshot ? undefined : data.gztime

      const incomingComparison = getValuationComparisonState({
        realChange,
        realChangeDate,
        estimateChange: incomingIsOfficialSnapshot ? null : estimateChangeValue,
        estimateTime: incomingIsOfficialSnapshot ? null : estimateTimeValue,
        fundName: data.name
      })
      const cachedComparison = getValuationComparisonState({
        realChange,
        realChangeDate,
        estimateChange: existingEstimateChange,
        estimateTime: existingEstimateTime,
        fundName: data.name
      })
      // Some providers begin stamping data with the new calendar day before
      // 9:30. Keep the last completed trading-day pair until the market opens.
      const hasIncomingCurrentEstimate = isEstimateDateToday(estimateTimeValue || '')
      const useCachedCompletedEstimate = cachedComparison.hasActualDiff && (
        incomingIsOfficialSnapshot ||
        (!hasIncomingCurrentEstimate && !incomingComparison.isTrading && !incomingComparison.hasActualDiff)
      )
      const comparison = useCachedCompletedEstimate ? cachedComparison : incomingComparison
      const displayEstimateChange = useCachedCompletedEstimate ? existingEstimateChange : estimateChangeValue
      const displayEstimateTime = useCachedCompletedEstimate ? existingEstimateTime : estimateTimeValue

      if (comparison.hasActualDiff && hasUsableEstimateChange(displayEstimateChange) && realChangeDate) {
        rememberValuationSettlement(code, {
          date: realChangeDate,
          estimateChange: Number(displayEstimateChange),
          realChange: Number(realChange),
          source: 'local-cache'
        })
      }
      
            // [WHAT] 检查估值日期是否为今天
      // [WHY] QDII基金在港股非交易日时，天天基金仍返回上一交易日的估值数据
      //       如果估值日期不是今天，说明该市场今日没有开盘，估值应该显示为"--"
      const today = getTodayStr()
      // [FIX] gztime 格式可能是 "2026/07/07 23:45" 或 "2026-07-07 23:45"
      //       需要提取日期部分并统一格式进行比较
      const isEstimateToday = (() => {
        if (!estimateTimeValue) return false
        const datePart = estimateTimeValue.split(' ')[0] // 提取日期部分
        const normalizedDate = datePart.replace(/\//g, '-') // 统一日期分隔符为 "-"
        return normalizedDate === today
      })()
      const retainedMarketEstimate = !incomingIsOfficialSnapshot && isRetainedMarketEstimate(data)
      
      // [WHAT] 如果估值日期不是今天，将估值设为"--"表示无今日估值
      const estimateValue = (isEstimateToday || retainedMarketEstimate)
        ? (Number.isFinite(Number(data.gsz)) && Number(data.gsz) > 0 ? data.gsz : watchlist.value[index].estimateValue)
        : '--'
      const estimateChange = (isEstimateToday || retainedMarketEstimate || comparison.hasActualDiff) ? (displayEstimateChange || '--') : '--'
      
      watchlist.value[index] = {
        code: data.fundcode,
        name: data.name,
        type: existingType,
        estimateValue,
        estimateChange,
        estimateTime: displayEstimateTime,
        lastValue: data.dwjz,
        loading: false,
        realChange,
        realChangeDate,
        isRealChangeToday: comparison.isCurrentReal
      }
    }
  }
  /**
   * 添加基金到自选
   * [EDGE] 已存在则不重复添加
   * [EDGE] 添加时设置默认估值，避免JSONP失败时显示空白
   */
    async function addFund(code: string, name: string) {
    if (isInWatchlist(code)) return false
    
    // [WHAT] 先获取基金类型
    const typeMap = await getFundTypes([code]).catch(() => new Map<string, string>())
    const fundType = typeMap.get(code) || ''
    
    // [WHAT] 先添加到列表（显示加载状态），再获取估值
    addToStorage(code)
        watchlist.value.unshift({
      code,
      name,
      type: fundType,
      // [EDGE] 设置默认估值数据，避免空白
      estimateValue: '--',
      estimateChange: '--',
      lastValue: '--',
      loading: true
    })
    
    // 立即获取该基金的估值
    await refreshSingleFund(code)
    return true
    }

  /**
   * 从自选中移除基金
   */
  function removeFund(code: string) {
    removeFromStorage(code)
    const index = watchlist.value.findIndex((item) => item.code === code)
    if (index > -1) {
      watchlist.value.splice(index, 1)
    }
  }

  /**
   * 检查基金是否在自选中
   */
  function isFundInWatchlist(code: string): boolean {
    return watchlistCodes.value.includes(code)
  }

  /**
   * 重新排序自选基金
   * [WHAT] 将基金从旧位置移动到新位置
   */
  function reorderWatchlist(oldIndex: number, newIndex: number) {
    if (oldIndex === newIndex) return
    
    // [WHAT] 从数组中移除并插入新位置
    const item = watchlist.value.splice(oldIndex, 1)[0]
    watchlist.value.splice(newIndex, 0, item)
    
    // [WHAT] 保存排序顺序到本地存储
    const codes = watchlist.value.map(item => item.code)
    saveWatchlistOrder(codes)
  }

  // ========== 多数据源功能（新增） ==========
  
  /** 每只基金的数据源设置（默认 fundgz） */
  const fundDataSources = ref<Map<string, DataSource>>(new Map())
  
  /** 全局自动选源开关 */
  const autoSelectSource = ref(false)

  /**
   * 获取某只基金的数据源
   */
  function getFundDataSource(code: string): DataSource {
    return fundDataSources.value.get(code) || 'fundgz'
  }

  /**
   * 设置某只基金的数据源
   */
  /**
   * 设置基金的数据源并立即刷新
   * [FIX] 返回 Promise，允许调用方 await 刷新完成
   */
  function setFundDataSource(code: string, source: DataSource): Promise<void> {
    fundDataSources.value.set(code, source)
    
    // 更新 watchlist 中的数据源标记
    const item = watchlist.value.find(f => f.code === code)
    if (item) {
      item.dataSource = source
    }
    
    // 立即用新数据源刷新该基金（返回 Promise 供调用方 await）
    return refreshSingleFundWithSource(code, source)
  }

  /**
   * 使用指定数据源刷新单只基金
   * [FIX] 用 finally 确保 loading 状态一定会被重置
   */
  async function refreshSingleFundWithSource(code: string, source?: DataSource) {
    const ds = source || getFundDataSource(code)
    
    try {
      if (ds === 'fundgz') {
        // 天天基金：保持原有逻辑
        const [data, realChange] = await Promise.all([
          fetchFundEstimateFast(code),
          fetchRealDayChange(code).catch(() => null)
        ])
        updateFundData(code, data, realChange ?? undefined)
      } else {
        // 新浪数据源
        const [data, realChange] = await Promise.all([
          fetchFundEstimateBySource(code, ds),
          fetchRealDayChange(code).catch(() => null)
        ])
        
        // [FIX] 检查数据是否有效
        if (!data || !data.gszzl) {
          console.warn(`[Store] ${code} 新浪${ds} 返回空数据，降级到 fundgz`)
          const fallbackData = await fetchFundEstimateFast(code)
          updateFundData(code, fallbackData, realChange ?? undefined)
          // 标记数据源
          const item = watchlist.value.find(f => f.code === code)
          if (item) item.dataSource = ds
        } else {
          updateFundDataWithSource(code, data, ds, realChange ?? undefined)
        }
        
        // 获取对比数据（非阻塞）
        fetchSourceComparison(code).then(comparison => {
          const item = watchlist.value.find(f => f.code === code)
          if (item) item.sourceComparison = comparison
        }).catch(() => {})
        return
      }
    } catch (err) {
      console.error(`[Store] ${code} 刷新失败(${ds}):`, err)
      // 降级到天天基金
      if (ds !== 'fundgz') {
        try {
          const fallbackData = await fetchFundEstimateFast(code)
          updateFundData(code, fallbackData)
          console.log(`[Store] ${code} 已从 ${ds} 降级到 fundgz`)
        } catch (e) {
          console.error(`[Store] ${code} 降级也失败:`, e)
        }
      }
    } finally {
      // [FIX] 最终确保 loading 被重置
      const item = watchlist.value.find(f => f.code === code)
      if (item && item.loading) {
        item.loading = false
        console.log(`[Store] ${code} finally: loading → false`)
      }
    }
    
    // fundgz 分支的对比数据获取
    try {
      const comparison = await fetchSourceComparison(code)
      const item = watchlist.value.find(f => f.code === code)
      if (item) {
        item.sourceComparison = comparison
      }
    } catch {
      // 对比数据获取失败不影响主流程
    }
  }

  /**
   * 更新单只基金数据（带数据源标记）
   */
  function updateFundDataWithSource(
    code: string, 
    data: FundEstimate, 
    source: DataSource,
    realChangeResult?: { changeRate: number; date: string } | null
  ) {
    // 复用原有逻辑，但添加数据源标记
    updateFundData(code, data, realChangeResult)
    
    // 覆盖数据源标记
    const index = watchlist.value.findIndex((item) => item.code === code)
    if (index > -1) {
      watchlist.value[index].dataSource = source
    }
  }

  /**
   * 获取所有数据源的估值用于弹窗展示
   */
  async function getAllSourcesForFund(code: string): Promise<{
    sources: Partial<Record<DataSource, { gszzl: string; gsz: string; gztime: string }>>
    activeSource: DataSource
  }> {
    // 并行请求3个数据源
    const [fundgzResult, sina2Result, sina3Result] = await Promise.allSettled([
      fetchFundEstimateFast(code).catch(() => null),
      fetchSinaEstimate(code, 'sina_ds2').catch(() => null),
      fetchSinaEstimate(code, 'sina_ds3').catch(() => null)
    ])

    const sources: Partial<Record<DataSource, { gszzl: string; gsz: string; gztime: string }>> = {}
    
    if (fundgzResult.status === 'fulfilled' && fundgzResult.value) {
      sources.fundgz = {
        gszzl: fundgzResult.value.gszzl,
        gsz: fundgzResult.value.gsz,
        gztime: fundgzResult.value.gztime
      }
    }
    
    if (sina2Result.status === 'fulfilled' && sina2Result.value) {
      sources.sina_ds2 = {
        gszzl: sina2Result.value.gszzl,
        gsz: sina2Result.value.gsz,
        gztime: sina2Result.value.gztime
      }
    }
    
    if (sina3Result.status === 'fulfilled' && sina3Result.value) {
      sources.sina_ds3 = {
        gszzl: sina3Result.value.gszzl,
        gsz: sina3Result.value.gsz,
        gztime: sina3Result.value.gztime
      }
    }
    
    return {
      sources,
      activeSource: getFundDataSource(code)
    }
  }

  /**
   * 切换全局自动选源模式
   */
  function toggleAutoSource(enabled: boolean) {
    autoSelectSource.value = enabled
  }

        return {
    // State
    watchlist,
    isRefreshing,
    lastRefreshTime,
    fundDataSources,
    autoSelectSource,
    // Getters
    watchlistCodes,
    // Actions
    initWatchlist,
    refreshEstimates,
    refreshSingleFund,
    refreshSingleFundWithSource,
    addFund,
    removeFund,
    isFundInWatchlist,
    fetchPeriodReturns,
    reorderWatchlist,
    // Multi-source data source actions
    getFundDataSource,
    setFundDataSource,
    getAllSourcesForFund,
    toggleAutoSource,
    // Auto-refresh
    startAutoRefresh,
    stopAutoRefresh,
    restartAutoRefresh,
    isTradingTime
  }
})
