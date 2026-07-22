// [WHY] 优化版基金API，参考多个开源项目的最佳实践
// [WHAT] 使用缓存、并发控制、简化数据结构
// [DEPS] 天天基金公开接口

import { cache, CACHE_TTL } from './cache'
import { persistCache } from './tiantianApi'
import { API_BASE_URL, USE_PROXY } from '@/config/api'
import type { FundEstimate, NetValueRecord, StockHolding, DataSource, FundEstimateWithSource, MultiSourceEstimate } from '@/types/fund'
import { getBeijingDateString, getBeijingDayAndMinutes } from '@/utils/tradingDate'
import { shouldRetainCompletedEstimate, shouldRetainCurrentDayEstimate } from '@/utils/holdingCalculator'

// ========== 股票实时行情接口 ==========

interface StockQuote {
  code: string
  name: string
  price: number
  change: number
  changePercent: number
}

/**
 * 获取股票实时行情（批量）
 * [WHY] 用于根据重仓股计算基金估值
 * [DEPS] 东方财富股票行情接口
 * [FIX] 移除远程后端 /api/stock-quotes 依赖，直接使用 /push2 代理获取
 */
export async function fetchStockQuotes(holdings: StockHolding[]): Promise<Map<string, StockQuote>> {
  const result = new Map<string, StockQuote>()
  if (holdings.length === 0) return result

  // [WHAT] 分离 A股和港股
  const aStocks = holdings.filter(h => h.marketPrefix !== '116')
  const hkStocks = holdings.filter(h => h.marketPrefix === '116')

  // [WHAT] A股批量获取（使用 /push2 代理）
  const push2BaseUrl = USE_PROXY ? `${API_BASE_URL}/push2` : 'https://push2.eastmoney.com'
  if (aStocks.length > 0) {
    const secids = aStocks.map(h => `${h.marketPrefix || '0'}.${h.stockCode}`).join(',')
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), 5000)

    try {
      const url = `${push2BaseUrl}/api/qt/ulist.np/get?fltt=2&secids=${secids}&fields=f2,f3,f12,f14&ut=fa5fd1943c7b386f172d6893dbfba10b&_=${Date.now()}`
      const response = await fetch(url, {
        signal: controller.signal,
        headers: {
          'Referer': 'https://quote.eastmoney.com/',
          'User-Agent': 'Mozilla/5.0'
        }
      })
      clearTimeout(timer)
      if (!response.ok) throw new Error(`HTTP ${response.status}`)
      const data = await response.json()
      if (data.data && data.data.diff) {
        for (const holding of aStocks) {
          const quote = data.data.diff.find((q: any) => q.f12 === holding.stockCode)
          if (quote) {
            result.set(holding.stockCode, {
              code: holding.stockCode,
              name: quote.f14 || '',
              price: quote.f2 || 0,
              change: 0,
              changePercent: quote.f3 || 0
            })
          }
        }
      }
    } catch (err) {
      clearTimeout(timer)
      console.warn('[股票行情] A股获取失败:', err)
    }
  }

  // [WHAT] 港股逐个获取
  for (const holding of hkStocks) {
    try {
      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(), 3000)
      const url = `${push2BaseUrl}/api/qt/stock/get?secid=116.${holding.stockCode}&fields=f2,f3,f12,f14&_=1234567890`
      const response = await fetch(url, {
        signal: controller.signal,
        headers: {
          'Referer': 'https://quote.eastmoney.com/',
          'User-Agent': 'Mozilla/5.0'
        }
      })
      clearTimeout(timer)
      const data = await response.json()
      if (data.data) {
        result.set(holding.stockCode, {
          code: holding.stockCode,
          name: data.data.f14 || '',
          price: data.data.f2 || 0,
          change: 0,
          changePercent: data.data.f3 || 0
        })
      }
    } catch (e) {
      console.error(`[股票行情] 港股 ${holding.stockCode} 获取失败:`, e)
    }
  }

  return result
}

/**
 * 根据重仓股计算基金估值
 * [WHY] 当天天基金JSONP接口失效时的备用方案
 * [WHAT] 根据基金重仓股的实时涨跌幅和持仓占比，加权计算基金估值
 * @param code 基金代码
 * @param holdings 重仓股列表
 * @param lastNetValue 上一交易日净值
 */
export async function calculateEstimateFromHoldings(
  code: string,
  holdings: StockHolding[],
  lastNetValue: number
): Promise<FundEstimate | null> {
  if (!holdings || holdings.length === 0 || lastNetValue <= 0) {
    return null
  }
  
  // [WHAT] 获取重仓股实时行情（需带 marketPrefix 以区分沪深/港股）
  const quotes = await fetchStockQuotes(holdings)
  
  if (quotes.size === 0) {
    return null
  }
  
  // [WHAT] 计算加权涨跌幅
  let totalWeight = 0
  let weightedChange = 0
  
  for (const holding of holdings) {
    const quote = quotes.get(holding.stockCode)
    if (quote && holding.holdingRatio > 0) {
      // [WHAT] 持仓占比作为权重（假设前10大重仓股占总仓位的一定比例）
      // 通常前10大重仓股占基金总资产的40%-60%
      const weight = holding.holdingRatio / 100
      weightedChange += quote.changePercent * weight
      totalWeight += weight
    }
  }
  
  if (totalWeight === 0) {
    return null
  }
  
  // [WHAT] 归一化计算（假设重仓股占总仓位的50%左右）
  // 实际基金持仓还包括现金、债券等，需要调整
  const estimatedChange = weightedChange / totalWeight * 0.5  // 假设股票仓位约50%
  
  // [WHAT] 计算估算净值
  const estimatedNetValue = lastNetValue * (1 + estimatedChange / 100)
  
  return {
    fundcode: code,
    name: '',
    dwjz: lastNetValue.toFixed(4),
    gsz: estimatedNetValue.toFixed(4),
    gszzl: estimatedChange.toFixed(2),
    gztime: new Date().toLocaleString('zh-CN', { 
      year: 'numeric', 
      month: '2-digit', 
      day: '2-digit',
      hour: '2-digit', 
      minute: '2-digit' 
    })
  }
}

// [WHAT] 清除指定基金的缓存数据
export function clearFundCache(code: string): void {
  // 清除所有跟该基金相关的缓存
  const keys = ['estimate', 'netvalue', 'kline', 'period']
  keys.forEach(prefix => {
    // 清除所有可能的days参数组合
    ;[30, 60, 90, 180, 365, 400, 1500].forEach(days => {
      cache.delete(`${prefix}_${code}_${days}`)
    })
    cache.delete(`${prefix}_${code}`)
  })
}

// [WHAT] 清除所有缓存
export function clearAllCache(): void {
  cache.clear()
}

// [OPT] 提高并发数从5→20，充分利用浏览器并行能力
// 东方财富 JSONP 接口支持高并发，实测20并发稳定
const MAX_CONCURRENT = 20
let activeRequests = 0
const requestQueue: (() => void)[] = []

function executeNext() {
  if (requestQueue.length > 0 && activeRequests < MAX_CONCURRENT) {
    const next = requestQueue.shift()
    if (next) next()
  }
}

function withConcurrencyControl<T>(fn: () => Promise<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    const execute = async () => {
      activeRequests++
      try {
        const result = await fn()
        resolve(result)
      } catch (err) {
        reject(err)
      } finally {
        activeRequests--
        executeNext()
      }
    }
    
    if (activeRequests < MAX_CONCURRENT) {
      execute()
    } else {
      requestQueue.push(execute)
    }
  })
}

// ========== 后端API接口 ==========

async function fetchBackendEstimateChunk(codes: string[]): Promise<Map<string, FundEstimate>> {
  const results = new Map<string, FundEstimate>()
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 3000)
  try {
    const url = `${API_BASE_URL}/api/fund-estimates?codes=${encodeURIComponent(codes.join(','))}`
    const response = await fetch(url, { signal: controller.signal })
    if (!response.ok) throw new Error(`HTTP ${response.status}`)
    const payload = await response.json()
    for (const code of codes) {
      const item = payload?.data?.[code]
      if (item?.fundcode === code && item.name) results.set(code, item as FundEstimate)
    }
    return results
  } finally {
    clearTimeout(timer)
  }
}

async function fetchBackendEstimates(codes: string[]): Promise<Map<string, FundEstimate>> {
  const uniqueCodes = [...new Set(codes)]
  const chunks: string[][] = []
  for (let index = 0; index < uniqueCodes.length; index += 100) {
    chunks.push(uniqueCodes.slice(index, index + 100))
  }
  const chunkResults = await Promise.all(chunks.map(fetchBackendEstimateChunk))
  return new Map(chunkResults.flatMap(chunk => [...chunk]))
}

async function fetchBackendEstimate(code: string): Promise<FundEstimate | null> {
  return (await fetchBackendEstimates([code])).get(code) || null
}

// ========== JSONP请求队列 ==========
interface PendingRequest {
  code: string
  resolve: (data: FundEstimate) => void
  reject: (error: Error) => void
  timeout: ReturnType<typeof setTimeout>
}

let pendingRequests: PendingRequest[] = []
let jsonpInitialized = false

function initJsonpCallback() {
  if (jsonpInitialized) return
  jsonpInitialized = true
  
    // [NOTE] 天天基金返回的JSONP格式为jsonpgz({...})，回调函数名固定为jsonpgz
    ;(window as any).jsonpgz = (data: any) => {
    // [FIX] 添加空值检查，防止data为undefined时报错
    if (!data || !data.fundcode) {
      console.warn('[JSONP] 收到无效数据:', data)
      return
    }
    console.log('[JSONP] 收到数据:', data.fundcode, data.name)
    const index = pendingRequests.findIndex(req => req.code === data.fundcode)
    if (index !== -1) {
      const req = pendingRequests[index]!
      clearTimeout(req.timeout)
      pendingRequests.splice(index, 1)
      req.resolve(data)
    } else {
      // [FIX] 降低日志级别
      // console.debug('[JSONP] 未找到匹配请求:', data.fundcode)
    }
  }
}

// ========== 实时估值API（优化版） ==========

/**
 * 获取基金实时估值（带缓存）
 * [NOTE] 开盘前使用缓存数据，开盘后获取实时数据
 * [WHY] 主接口失效时，根据重仓股计算估值
 * [EDGE] QDII基金（港股等）在非交易日时，估值日期可能不是今天，需要特殊处理
 */
export async function fetchFundEstimateFast(code: string): Promise<FundEstimate> {
  const cacheKey = `estimate_${code}`
  
  // [WHAT] 检查内存缓存
  const cached = cache.get<FundEstimate>(cacheKey)
  if (cached) return cached
  
  // [WHAT] 获取持久化缓存（作为兜底）
  const persisted = persistCache.get<FundEstimate>(cacheKey)
  
  // [WHAT] 校验估值数据是否有效（排除0值/空值）
  // [EDGE] "--" 表示无估值（如QDII基金非交易日），也是有效数据
  function isValidEstimate(d: FundEstimate): boolean {
    // [FIX] "--" 是特殊标记，表示无估值，也是有效数据
    if (d.gsz === '--') return true
    const gsz = parseFloat(d.gsz)
    return !isNaN(gsz) && gsz > 0
  }
  
    // [WHAT] 检查估值日期是否为今天
  // [WHY] QDII基金在港股非交易日时，天天基金仍返回上一交易日的估值数据
  //       需要判断估值日期是否为今天，如果不是，说明该市场今日没有开盘
  function isEstimateToday(d: FundEstimate): boolean {
    if (!d.gztime) return false
    const today = getBeijingDateString()
    // [FIX] gztime 格式可能是 "2026/07/07 23:45" 或 "2026-07-07 23:45"
    //       需要提取日期部分进行比较
    const datePart = d.gztime.split(' ')[0] // 提取日期部分
    // 统一日期分隔符为 "-" 进行比较
    const normalizedDate = datePart.replace(/\//g, '-')
    return normalizedDate === today
  }
  
    // [FIX] 总是尝试获取最新数据，不再用 isTradingTime() 跳过
  // [WHY] 天天基金接口在收盘后仍返回当天最终估值，应尽量获取
  // [FIX] 添加总超时限制（5秒），防止主接口+重仓股估值链路过长导致页面一直loading
  const totalTimeout = new Promise<never>((_, reject) => {
    setTimeout(() => reject(new Error(`总超时: ${code}`)), 5000)
  })
  
    const doFetch = async (): Promise<FundEstimate> => {
    // 后端统一完成实时/日终/货币基金分流，并提供限流保护。
    try {
      const backend = await fetchBackendEstimate(code)
      if (backend && isValidEstimate(backend)) {
        if (persisted && shouldRetainCompletedEstimate({
          incomingSource: backend.source,
          incomingEstimateTime: backend.gztime,
          cachedSource: persisted.source,
          cachedEstimateChange: persisted.gszzl,
          cachedEstimateTime: persisted.gztime,
          fundName: persisted.name || backend.name
        })) {
          cache.set(cacheKey, persisted, CACHE_TTL.ESTIMATE)
          return persisted
        }
        if (persisted && shouldRetainCurrentDayEstimate({
          incomingEstimateChange: backend.gszzl,
          incomingEstimateTime: backend.gztime,
          cachedEstimateChange: persisted.gszzl,
          cachedEstimateTime: persisted.gztime
        })) {
          cache.set(cacheKey, persisted, CACHE_TTL.ESTIMATE)
          return persisted
        }
        cache.set(cacheKey, backend, CACHE_TTL.ESTIMATE)
        // A market snapshot is an official NAV fallback, not an intraday
        // estimate. Do not overwrite the device's last same-day fundgz value:
        // it is needed after close to compare the published NAV with the
        // actual intraday estimate.
        if (backend.source !== 'market_snapshot') {
          persistCache.set(cacheKey, backend)
        }
        return backend
      }
    } catch {
      // 后端不可用时保留浏览器 JSONP 作为灾备。
    }

    // [WHAT] 后端API失败时，尝试JSONP接口
    try {
      const data = await fetchEstimateFromMainApi(code)
      if (isValidEstimate(data)) {
        // [EDGE] QDII基金估值日期检查：如果估值日期不是今天，说明该市场今日没有开盘
        //       返回一个特殊估值，表示"无今日估值"
        if (!isEstimateToday(data)) {
          if (persisted && shouldRetainCurrentDayEstimate({
            incomingEstimateChange: data.gszzl,
            incomingEstimateTime: data.gztime,
            cachedEstimateChange: persisted.gszzl,
            cachedEstimateTime: persisted.gztime
          })) {
            cache.set(cacheKey, persisted, CACHE_TTL.ESTIMATE)
            return persisted
          }
          console.warn(`[估值] JSONP返回非今日数据: ${data.gztime}`)
          const noEstimate: FundEstimate = {
            fundcode: code,
            name: data.name,
            dwjz: data.dwjz,
            gsz: '--',
            gszzl: '--',
            gztime: data.gztime
          }
          cache.set(cacheKey, noEstimate, CACHE_TTL.ESTIMATE)
          persistCache.set(cacheKey, noEstimate)
          return noEstimate
        }
        cache.set(cacheKey, data, CACHE_TTL.ESTIMATE)
        persistCache.set(cacheKey, data)
        return data
      }
      // [FIX] 静默处理无效数据（QDII/货币基金等无估值是正常情况）
      // console.debug('[估值] JSONP返回无效数据:', code, data.gsz)
    } catch (err) {
      // [FIX] 静默处理JSONP失败（部分基金无估值数据是正常的）
      // console.debug('[估值] JSONP失败，尝试重仓股估值:', code, err)
    }
    
    // [WHAT] JSONP失败时，根据重仓股计算估值
    try {
      const estimate = await fetchEstimateFromHoldings(code)
      if (estimate && isValidEstimate(estimate)) {
        cache.set(cacheKey, estimate, CACHE_TTL.ESTIMATE)
        persistCache.set(cacheKey, estimate)
        return estimate
      }
    } catch (err) {
      console.warn('[估值] 重仓股估值也失败:', code, err)
    }
    
    // [EDGE] 都失败时使用持久化缓存
    if (persisted && isValidEstimate(persisted)) {
      cache.set(cacheKey, persisted, CACHE_TTL.ESTIMATE)
      return persisted
    }
    
    // [FIX] 夜间兜底：用历史净值作为"静态估值"，避免页面卡在loading
    // [WHY] 夜间JSONP不返回数据，重仓股方案也失败，需要用最近净值兜底
    try {
      const history = await fetchNetValueHistoryFast(code, 5)
      if (history.length > 0 && history[0]!.netValue > 0) {
        const latest = history[0]!
        const fallback: FundEstimate = {
          fundcode: code,
          name: '',
          dwjz: latest.netValue.toFixed(4),
          gsz: latest.netValue.toFixed(4),
          gszzl: '0.00',
          gztime: latest.date
        }
        cache.set(cacheKey, fallback, CACHE_TTL.ESTIMATE)
        persistCache.set(cacheKey, fallback)
        return fallback
      }
    } catch (err) {
      console.warn('[估值] 历史净值兜底也失败:', code, err)
    }
    
    throw new Error(`无法获取估值: ${code}`)
  }
  
  return Promise.race([doFetch(), totalTimeout])
}

// ========== 多数据源估值（新增） ==========

/** 新浪估值接口去重 Map */
const sinaEstimateNetworthInflight = new Map<string, Promise<FundEstimateWithSource>>()

/**
 * 从新浪财经获取基金估值（通过后端API代理）
 * [WHY] 提供第二个/第三个数据源用于对比和智能选源
 * [FIX] 改为通过后端 /sina 代理获取，避免 WebView 环境下跨域问题
 * [DATA] 后端接口: GET /sina/fundInfo/api/openapi.php/FdFundService.getEstimateNetworthPic?symbol=xxx
 * [DATA] 后端返回: { result: { data: { networth: [{ growthrate, pre_nav, growthrate2, pre_nav2, min_time, pre_date }] } } }
 * @param code 基金代码
 * @param dsType 数据源类型: 'sina_ds2' 取 growthrate+pre_nav, 'sina_ds3' 取 growthrate2+pre_nav2
 */
export async function fetchSinaEstimate(code: string, dsType: 'sina_ds2' | 'sina_ds3'): Promise<FundEstimateWithSource | null> {
  const cacheKey = `sina_${dsType}_${code}`
  const cached = cache.get<FundEstimateWithSource>(cacheKey)
  if (cached) return cached
  
  // 检查是否已在请求中（去重）
  const inflight = sinaEstimateNetworthInflight.get(cacheKey)
  if (inflight) return inflight
  
  // 创建新请求（通过后端API代理）
  const promise = (async (): Promise<FundEstimateWithSource | null> => {
    try {
      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(), 5000)
      const response = await fetch(`${API_BASE_URL}/api/fund-estimate-sources?code=${code}`, { signal: controller.signal })
      clearTimeout(timer)
      if (!response.ok) return null
      const payload = await response.json()
      const item = payload?.data?.sources?.[dsType]
      if (!item?.gsz || !item?.gszzl) return null
      const result = item as FundEstimateWithSource

      cache.set(cacheKey, result, CACHE_TTL.ESTIMATE)
      return result
    } catch (err) {
      if (err instanceof DOMException && err.name === 'AbortError') {
        console.warn(`[新浪估值${dsType}] 请求超时:`, code)
      } else {
        console.error(`[新浪估值${dsType}] 请求失败:`, code, err)
      }
      return null
    } finally {
      sinaEstimateNetworthInflight.delete(cacheKey)
    }
  })()

  sinaEstimateNetworthInflight.set(cacheKey, promise)
  return promise
}

/**
 * 按指定数据源获取基金估值
 * [WHY] 统一入口，支持 fundgz/sina_ds2/sina_ds3 三种数据源
 * @param code 基金代码
 * @param source 数据源类型，默认 fundgz
 */
export async function fetchFundEstimateBySource(
  code: string, 
  source: DataSource = 'fundgz'
): Promise<FundEstimateWithSource> {
  switch (source) {
    case 'fundgz': {
      // 使用现有的天天基金JSONP接口
      const data = await fetchFundEstimateFast(code)
      return { ...data, source: 'fundgz' }
    }
    
    case 'sina_ds2': 
    case 'sina_ds3': {
      const data = await fetchSinaEstimate(code, source)
      if (data) return data
      // 新浪失败时降级到天天基金
      console.warn(`[多数据源] ${source} 失败，降级到 fundgz: ${code}`)
      const fallback = await fetchFundEstimateFast(code)
      return { ...fallback, source: 'fundgz' }
    }
      
    default:
      throw new Error(`未知数据源: ${source}`)
  }
}

/**
 * 批量获取多数据源估值（用于对比）
 * [WHY] 同时获取3个数据源的估值，用于展示和选源
 * @param code 基金代码
 */
export async function fetchMultiSourceEstimates(code: string): Promise<MultiSourceEstimate> {
  // 并行请求3个数据源
  const results = await Promise.allSettled([
    fetchFundEstimateBySource(code, 'fundgz'),
    fetchSinaEstimate(code, 'sina_ds2'),
    fetchSinaEstimate(code, 'sina_ds3')
  ])

  const sources: Partial<Record<DataSource, FundEstimateWithSource>> = {}
  
  if (results[0].status === 'fulfilled') sources.fundgz = results[0].value
  if (results[1].status === 'fulfilled' && results[1].value) sources.sina_ds2 = results[1].value
  if (results[2].status === 'fulfilled' && results[2].value) sources.sina_ds3 = results[2].value

  return {
    code,
    sources,
    activeSource: 'fundgz', // 默认使用天天基金
  }
}

/**
 * 获取各数据源的实时估值差异（用于准确度对比）
 * [WHY] 展示每个数据源的预测值，方便用户选择最准的
 * @param code 基金代码
 * @returns 各数据源的涨跌幅映射
 */
export async function fetchSourceComparison(code: string): Promise<Partial<Record<DataSource, number>>> {
  const multi = await fetchMultiSourceEstimates(code)
  const result: Partial<Record<DataSource, number>> = {}
  
  for (const [source, estimate] of Object.entries(multi.sources) as [DataSource, FundEstimateWithSource][]) {
    if (estimate && estimate.gszzl !== '--') {
      result[source] = parseFloat(estimate.gszzl) || 0
    }
  }
  
  return result
}

/**
 * 根据指定数据源获取估值（修改版主函数）
 * [NOTE] 保持向后兼容，默认仍使用 fundgz 数据源
 */
export async function fetchFundEstimateWithSource(
  code: string, 
  source?: DataSource
): Promise<FundEstimate> {
  if (source && source !== 'fundgz') {
    const result = await fetchFundEstimateBySource(code, source)
    return result
  }
  // 默认行为不变
  return fetchFundEstimateFast(code)
}

/**
 * 从主接口获取估值（JSONP）
 * [FIX] 移除onload中的清理逻辑，完全依赖超时机制
 * [WHY] onload可能在jsonpgz回调之前触发，导致pendingRequests被提前清理
 */
function fetchEstimateFromMainApi(code: string): Promise<FundEstimate> {
  return withConcurrencyControl(() => {
    return new Promise((resolve, reject) => {
      initJsonpCallback()
      
      const scriptId = `fund_${code}_${Date.now()}`
            // [OPT] 超时从2秒降到1秒（正常200ms返回），加速整体加载
      const timeout = setTimeout(() => {
        cleanup()
        const idx = pendingRequests.findIndex(r => r.code === code)
        if (idx !== -1) {
          clearTimeout(pendingRequests[idx]!.timeout)
          pendingRequests.splice(idx, 1)
        }
        reject(new Error(`超时: ${code}`))
      }, 2000)
      
      let resolved = false
      pendingRequests.push({
        code,
        resolve: (data) => {
          resolved = true
          clearTimeout(timeout)
          cleanup()
          resolve(data)
        },
        reject: (err) => {
          resolved = true
          clearTimeout(timeout)
          cleanup()
          reject(err)
        },
        timeout
      })
      
      function cleanup() {
        const s = document.getElementById(scriptId)
        if (s) document.body.removeChild(s)
      }
      
            const script = document.createElement('script')
      script.id = scriptId
      // [WHAT] 生产环境使用后端代理，开发环境直接调用
      // [FIX] 估值接口必须用 /fundgz 代理（fundgz.1234567.com.cn），不是 /tiantian（fund.eastmoney.com）
      const baseUrl = USE_PROXY ? `${API_BASE_URL}/fundgz` : 'https://fundgz.1234567.com.cn'
      script.src = `${baseUrl}/js/${code}.js?rt=${Date.now()}`
      // [FIX] 静默调试日志（生产环境不需要每只基金都打印请求）
      // console.log('[JSONP] 请求估值:', code)
      script.onerror = (err) => {
        // [FIX] 降低日志级别为 warn（非 error），避免控制台红色报错
        console.warn('[JSONP] 加载失败:', code)
        const idx = pendingRequests.findIndex(r => r.code === code)
        if (idx !== -1) {
          clearTimeout(pendingRequests[idx]!.timeout)
          pendingRequests.splice(idx, 1)
        }
        cleanup()
        reject(new Error(`失败: ${code}`))
      }
      // [FIX] 移除onload中的清理逻辑，完全依赖超时机制
      // [WHY] onload可能在jsonpgz回调之前触发，导致pendingRequests被提前清理
      //       如果脚本加载成功但回调未触发，会在3秒超时后被清理
      document.body.appendChild(script)
    })
  })
}

/**
 * 根据重仓股计算估值（备用方案）
 * [WHY] 当天天基金JSONP接口失效时使用
 */
async function fetchEstimateFromHoldings(code: string): Promise<FundEstimate | null> {
  // [WHAT] 获取基金重仓股
  const holdings = await fetchStockHoldingsForEstimate(code)
  if (!holdings || holdings.length === 0) {
    return null
  }
  
  // [WHAT] 获取上一交易日净值
  const history = await fetchNetValueHistoryFast(code, 5)
  if (history.length === 0) {
    return null
  }
  const lastNetValue = history[0]!.netValue
  if (lastNetValue <= 0) {
    return null
  }
  
  // [WHAT] 根据重仓股计算估值
  return calculateEstimateFromHoldings(code, holdings, lastNetValue)
}

/**
 * 获取基金重仓股（用于估值计算）
 */
async function fetchStockHoldingsForEstimate(code: string): Promise<StockHolding[]> {
  try {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), 5000)
    const response = await fetch(`${API_BASE_URL}/api/funds/${code}/holdings`, { signal: controller.signal })
    clearTimeout(timer)
    if (response.ok) {
      const payload = await response.json()
      const holdings: StockHolding[] = (payload?.data?.holdings || []).map((item: any) => ({
        stockCode: item.stockCode || '',
        stockName: item.stockName || '',
        holdingRatio: Number(item.holdingRatio) || 0,
        holdingAmount: item.holdingMarketValue ? String(item.holdingMarketValue) : '0',
        changeFromLast: '--',
        marketPrefix: item.marketPrefix || ''
      })).filter((item: StockHolding) => item.stockCode && item.stockName && item.holdingRatio > 0)
      if (holdings.length > 0) return holdings
    }
  } catch {
    // 后端不可用时继续使用 JSONP 灾备。
  }

  return new Promise((resolve) => {
    const callbackName = `jjcc_${Date.now()}_${Math.random().toString(36).slice(2)}`
    const timeout = setTimeout(() => {
      cleanup()
      resolve([])
    }, 10000)
    
    function cleanup() {
      clearTimeout(timeout)
      delete (window as any)[callbackName]
      const script = document.getElementById(callbackName)
      if (script) document.body.removeChild(script)
    }
    
    ;(window as any)[callbackName] = (data: any) => {
      cleanup()
      if (!data || !data.content) {
        resolve([])
        return
      }
      const holdings = parseStockHoldingsHtml(data.content)
      resolve(holdings)
    }
    
        const script = document.createElement('script')
    script.id = callbackName
    // [FIX] 始终使用代理路径，避免直接请求 fundf10.eastmoney.com 被 CORS 阻止
    const baseUrl = '/fundf10'
    script.src = `${baseUrl}/FundArchivesDatas.aspx?type=jjcc&code=${code}&topline=10&year=&month=&callback=${callbackName}&_=${Date.now()}`
    script.onerror = () => {
      cleanup()
      resolve([])
    }
    document.body.appendChild(script)
  })
}

/**
 * 解析重仓股 HTML 数据
 * [EDGE] 支持新旧两种HTML格式：
 *   - 旧格式：quote_300308.html
 *   - 新格式：//quote.eastmoney.com/unify/r/0.300308 或 //quote.eastmoney.com/unify/r/116.06869
 * [EDGE] 支持QDII基金的不同HTML格式：
 *   - 股票名称：QDII 用 class='toc'，A股 用 class='tol'
 *   - 占比：QDII 用普通 <td>，A股 用 class='tor'
 */
function parseStockHoldingsHtml(html: string): StockHolding[] {
  const holdings: StockHolding[] = []
  
  const tableRegex = /<tr[^>]*>[\s\S]*?<\/tr>/gi
  const rows = html.match(tableRegex) || []
  
  for (const row of rows) {
    if (row.includes('<th')) continue
    
    // [WHAT] 提取股票代码 - 支持新旧两种格式
    let stockCode = ''
    let marketPrefix = ''
    
    // 尝试匹配新格式
    const newFormatMatch = row.match(/quote\.eastmoney\.com\/unify\/r\/(\d+)\.(\d+)/i)
    if (newFormatMatch) {
      marketPrefix = newFormatMatch[1] // 市场前缀：0=深市，116=港股等
      stockCode = newFormatMatch[2] // 股票代码
    } else {
      // 尝试匹配旧格式
      const oldFormatMatch = row.match(/quote_(\d{6})\.html/i)
      if (oldFormatMatch) {
        stockCode = oldFormatMatch[1]
      }
    }
    
    // [WHAT] 提取股票名称 - 支持QDII和A股两种格式
    let stockName = ''
    // QDII基金使用 class='toc'
    const qdiiNameMatch = row.match(/class=['"]toc['"][^>]*>([^<]+)/i)
    if (qdiiNameMatch) {
      stockName = qdiiNameMatch[1].trim()
    } else {
      // A股基金使用普通 <a> 标签
      const nameMatch = row.match(/<a[^>]*>([^<]+)<\/a>/i)
      if (nameMatch) {
        stockName = nameMatch[1].trim()
      }
    }
    
    // [WHAT] 提取持仓占比 - 支持QDII和A股两种格式
    let holdingRatio = 0
    // A股基金使用 class='tor'
    const torMatch = row.match(/class=['"]tor['"][^>]*>([^<]+)/i)
    if (torMatch) {
      holdingRatio = parseFloat((torMatch[1] || '0').replace('%', '')) || 0
    } else {
      // QDII基金使用普通 <td>，占比通常在第四列
      const tdRegex = /<td[^>]*>([^<]*)<\/td>/gi
      const tds: string[] = []
      let tdMatch
      while ((tdMatch = tdRegex.exec(row)) !== null) {
        tds.push((tdMatch[1] || '').trim())
      }
      if (tds.length >= 4) {
        holdingRatio = parseFloat((tds[3] || '0').replace('%', '')) || 0
      }
    }
    
    // [WHAT] 提取持仓市值和较上期变化
    const tdRegex = /<td[^>]*>([^<]*)<\/td>/gi
    const tds: string[] = []
    let tdMatch
    while ((tdMatch = tdRegex.exec(row)) !== null) {
      tds.push((tdMatch[1] || '').trim())
    }
    
    const holdingAmount = tds[2] || '0' // 持仓市值（万元）
    const changeFromLast = tds[4] || '--' // 较上期变化
    
    // [WHAT] 只有获取到有效数据才添加
    if (stockCode && stockName) {
      holdings.push({
        stockCode,
        stockName,
        holdingRatio,
        holdingAmount,
        changeFromLast,
        marketPrefix // 添加市场前缀，用于获取涨跌幅
      })
    }
  }
  
  return holdings
}

/**
 * 批量获取基金估值（并发优化）
 */
export async function fetchFundEstimatesBatch(codes: string[]): Promise<Map<string, FundEstimate>> {
  const uniqueCodes = [...new Set(codes)]
  let results = new Map<string, FundEstimate>()
  try {
    results = await fetchBackendEstimates(uniqueCodes)
  } catch {
    // 后端不可用时仅对缺失项启用逐只灾备。
  }

  const promises = uniqueCodes.filter(code => !results.has(code)).map(async code => {
    try {
      const data = await fetchFundEstimateFast(code)
      results.set(code, data)
    } catch {
      // 静默失败
    }
  })
  
  await Promise.all(promises)
  return results
}

// ========== 历史净值API（pingzhongdata 串行加载避免竞态） ==========

/**
 * 串行加载队列：确保同一时刻只有一个 pingzhongdata 脚本在加载
 * [WHY] 多个 <script> 标签并行加载 pingzhongdata 时，脚本都写入 window.Data_netWorthTrend
 *       导致竞态：脚本A加载完 → 脚本B覆盖 → 脚本A的onload读到脚本B的数据
 * [FIX] 用 Promise 链串行化加载，同一时刻只有一个脚本执行，彻底避免竞态
 */
let scriptQueue: Promise<any> = Promise.resolve()

/**
 * 获取历史净值（带缓存，使用 pingzhongdata 脚本串行加载）
 * [DATA] equityReturn = 净值日增长率(%)，y = 单位净值
 * [WHAT] 盘后使用更短的缓存时间，确保能获取到最新公布的真实净值
 */
export async function fetchNetValueHistoryFast(code: string, days = 30): Promise<NetValueRecord[]> {
  const cacheKey = `netvalue_${code}_${days}`
  const cached = cache.get<NetValueRecord[]>(cacheKey)
  if (cached) return cached
  
  // [WHAT] 盘后使用更短的缓存时间（30秒），确保能获取到最新公布的真实净值
    const ttl = getMarketAwareTtl()

  // 优先使用后端统一历史净值服务；服务端提供持久化旧缓存降级，
  // 可避免浏览器串行加载 pingzhongdata 全局变量。
  let backendRecords: NetValueRecord[] = []
  try {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), 5000)
    const response = await fetch(`${API_BASE_URL}/api/funds/${code}/nav-history?limit=${Math.min(days, 500)}`, {
      signal: controller.signal
    })
    clearTimeout(timer)
    if (response.ok) {
      const payload = await response.json()
      backendRecords = (payload?.data?.items || []).map((item: any) => ({
        date: item.date || '',
        netValue: Number(item.nav) || 0,
        totalValue: Number(item.accumulatedNav) || 0,
        changeRate: Number(item.changePercent) || 0
      })).filter((item: NetValueRecord) => item.date && item.netValue > 0)
      if (backendRecords.length >= Math.min(days, 30)) {
        cache.set(cacheKey, backendRecords, ttl)
        return backendRecords
      }
    }
  } catch {
    // 后端不可用时继续使用现有 JSONP 灾备。
  }

  // [WHAT] 排入串行队列，等待前面的脚本加载完再加载自己的
  const result = await new Promise<NetValueRecord[]>((resolve) => {
    scriptQueue = scriptQueue.then(() => {
      return new Promise<void>((res) => {
        const scriptId = `pingzhongdata_${code}_${Date.now()}`
        const timeout = setTimeout(() => {
          cleanup()
          resolve(backendRecords)
          res()
        }, 10000)

                const script = document.createElement('script')
        script.id = scriptId
        // [WHAT] 生产环境使用后端代理，开发环境直接调用
        const baseUrl = USE_PROXY ? `${API_BASE_URL}/tiantian` : 'https://fund.eastmoney.com'
        script.src = `${baseUrl}/pingzhongdata/${code}.js?v=${Date.now()}`

        script.onload = () => {
          try {
            const trend: any[] = (window as any).Data_netWorthTrend || []
            cleanup()

            if (!Array.isArray(trend) || trend.length === 0) {
              resolve(backendRecords)
              res()
              return
            }

            // [WHAT] 按时间倒序取最近 days 条
            const recent = trend.slice(-days).reverse()
            const records: NetValueRecord[] = recent.map((item: any) => ({
              date: item.x ? getBeijingDateString(new Date(item.x)) : '',
              netValue: typeof item.y === 'number' ? item.y : 0,
              totalValue: 0,
              changeRate: typeof item.equityReturn === 'number' ? item.equityReturn : 0
            }))

            const byDate = new Map(records.map(item => [item.date, item]))
            backendRecords.forEach(item => byDate.set(item.date, item))
            const merged = [...byDate.values()]
              .filter(item => item.date && item.netValue > 0)
              .sort((left, right) => right.date.localeCompare(left.date))
              .slice(0, days)
            cache.set(cacheKey, merged, ttl)
            resolve(merged)
            res()
          } catch (err) {
            console.error('解析历史净值失败:', code, err)
            cleanup()
            resolve(backendRecords)
            res()
          }
        }

        script.onerror = () => {
          cleanup()
          resolve(backendRecords)
          res()
        }

        function cleanup() {
          clearTimeout(timeout)
          const s = document.getElementById(scriptId)
          if (s) document.body.removeChild(s)
        }

        document.body.appendChild(script)
      })
    })
  })

  return result
}

// ========== 当日真实涨跌幅 ==========

/**
 * 从东方财富历史净值接口获取当天真实净值
 * [WHY] 盘后基金公司公布真实净值后，这个接口会更新，但 pingzhongdata 接口可能延迟
 * [HOW] 使用 JSONP 方式调用 api.fund.eastmoney.com/f10/lsjz 接口
 * [EDGE] 浏览器 CORS 限制，必须使用 JSONP
 */
async function fetchTodayRealNav(code: string): Promise<{ nav: number; changeRate: number; date: string } | null> {
  return new Promise((resolve) => {
    const callbackName = `realnav_${Date.now()}_${Math.random().toString(36).slice(2)}`
    const timeout = setTimeout(() => {
      cleanup()
      resolve(null)
    }, 10000)

    ;(window as any)[callbackName] = (data: any) => {
      cleanup()
      try {
        if (!data?.Data?.LSJZList || data.Data.LSJZList.length === 0) {
          resolve(null)
          return
        }
        
                const latest = data.Data.LSJZList[0]
        const nav = parseFloat(latest.DWJZ)
        const changeRate = parseFloat(latest.JZZZL)
        // [FIX] 日期格式统一：东方财富 API 可能返回 YYYY/MM/DD 或 YYYY-MM-DD，统一转换为 YYYY-MM-DD
        const rawDate = latest.FSRQ || ''
        const date = rawDate.replace(/\//g, '-')
        
        if (isNaN(nav) || nav <= 0 || isNaN(changeRate)) {
          resolve(null)
          return
        }
        
        // [FIX] 静默调试日志（生产环境不需要每只基金都打印净值）
        // console.log(`[真实净值] ${code}: ${nav}, 涨跌幅: ${changeRate}%, 日期: ${date}`)
        resolve({ nav, changeRate, date })
      } catch {
        resolve(null)
      }
    }

    function cleanup() {
      clearTimeout(timeout)
      delete (window as any)[callbackName]
      const script = document.getElementById(callbackName)
      if (script) {
        document.body.removeChild(script)
      }
    }

        const script = document.createElement('script')
    script.id = callbackName
    // [WHAT] 生产环境使用后端代理，开发环境直接调用
    const baseUrl = USE_PROXY ? `${API_BASE_URL}/eastmoney` : 'https://api.fund.eastmoney.com'
    script.src = `${baseUrl}/f10/lsjz?callback=${callbackName}&fundCode=${code}&pageIndex=1&pageSize=1&_=${Date.now()}`
    script.onerror = () => {
      cleanup()
      resolve(null)
    }
    document.body.appendChild(script)
  })
}

/**
 * 判断当前是否为盘后时间（15:00-23:59）
 * [WHY] 盘后基金机构会公布真实净值，需要使用更短的缓存以获取最新数据
 */
function isAfterMarketClose(): boolean {
  const { day, minutes } = getBeijingDayAndMinutes()
  const hours = Math.floor(minutes / 60)
  // 周末也算盘后
  if (day === 0 || day === 6) return true
  // 工作日 15:00 之后算盘后
  return hours >= 15 && hours < 24
}

/**
 * 判断当前是否为盘前（00:00-09:29）
 * [WHY] 盘前应使用盘后缓存策略，因为此时数据与盘后一致
 */
function isBeforeMarketOpen(): boolean {
  const { minutes } = getBeijingDayAndMinutes()
  return minutes < 9 * 60 + 30
}

/**
 * 获取盘后/盘前专用缓存 TTL
 * [WHY] 盘后和盘前都应使用短缓存，确保能获取到最新公布的真实净值
 */
function getMarketAwareTtl(): number {
  if (isAfterMarketClose() || isBeforeMarketOpen()) {
    return 15000 // 盘后/盘前：15秒缓存
  }
  return CACHE_TTL.NET_VALUE // 盘中：1分钟缓存
}

/**
 * 获取基金当日真实涨跌幅（盘后基金机构公布的净值变化）
 * [WHY] 用于与盘中估值对比，计算"实差"
 * [HOW] 盘后优先使用 api.fund.eastmoney.com/f10/lsjz 获取最新净值
 *       如果失败，再使用 pingzhongdata 接口作为兜底
 * [WHAT] 盘后使用更短缓存时间，确保能获取到最新公布的真实涨跌幅
 */
export async function fetchRealDayChange(code: string): Promise<{ nav: number; changeRate: number; date: string } | null> {
  const cacheKey = `realchange_${code}`
  const ttl = getMarketAwareTtl()
  const cached = cache.get<{ nav: number; changeRate: number; date: string }>(cacheKey)
  if (cached !== null && cached !== undefined) return cached

  // [WHAT] 使用北京时间（UTC+8）
  const today = getBeijingDateString()

  try {
    // [WHAT] 盘后优先使用 lsjz 接口获取当天真实净值
    if (isAfterMarketClose() || isBeforeMarketOpen()) {
      const realNav = await fetchTodayRealNav(code)
      if (realNav && realNav.date === today) {
        // [FIX] 静默调试日志
        // console.log(`[真实涨跌幅] ${code}: nav=${realNav.nav}, ${realNav.changeRate}% (日期: ${realNav.date})`)
        const result = { nav: realNav.nav, changeRate: realNav.changeRate, date: realNav.date }
        cache.set(cacheKey, result, ttl)
        return result
      }
      // [FIX] 静默调试日志
      // console.log(`[真实涨跌幅] ${code}: lsjz 接口未返回今日数据，尝试 pingzhongdata`)
    }

    // [WHAT] 兜底：从历史净值中取最新一条的 changeRate
    const history = await fetchNetValueHistoryFast(code, 5)
    if (history.length === 0) return null

    const latest = history[0]!
    // [WHAT] changeRate 是百分比数值（如 1.23 表示 +1.23%）
    const val = latest.changeRate
    if (val === undefined || val === null || isNaN(val)) return null

    const result = { nav: latest.netValue, changeRate: val, date: latest.date }
    cache.set(cacheKey, result, ttl)
    return result
  } catch {
    return null
  }
}

// ========== K线数据（简化版，不需要复杂的OHLC模拟） ==========

export interface SimpleKLineData {
  time: string
  value: number
  change: number
}

/**
 * 获取简化K线数据（直接使用净值，不模拟OHLC）
 */
export async function fetchSimpleKLineData(code: string, days = 60): Promise<SimpleKLineData[]> {
  const cacheKey = `kline_${code}_${days}`
  const cached = cache.get<SimpleKLineData[]>(cacheKey)
  if (cached) return cached
  
  const history = await fetchNetValueHistoryFast(code, days)
  
  // 转换为K线格式（按时间正序）
  const klineData = history
    .map(item => ({
      time: item.date,
      value: item.netValue,
      change: item.changeRate
    }))
    .reverse()
  
  cache.set(cacheKey, klineData, CACHE_TTL.NET_VALUE)
  return klineData
}

// ========== 阶段涨幅（直接计算，不依赖外部API） ==========

export interface PeriodReturn {
  period: string
  label: string
  days: number
  change: number
}

/**
 * 计算阶段涨幅（从历史净值直接计算）
 * [WHY] 与京东金融对齐：按自然日往前推算，找到目标日期或之前最近的交易日净值
 */
export async function calculatePeriodReturns(code: string): Promise<PeriodReturn[]> {
  const cacheKey = `period_${code}`
  const cached = cache.get<PeriodReturn[]>(cacheKey)
  if (cached) return cached
  
  // [WHY] 获取足够长的历史数据（1500天覆盖5年）
  const history = await fetchNetValueHistoryFast(code, 1500)
  if (history.length < 2) return []
  
  const latest = history[0]!
  
  // [EDGE] 如果最新净值为0或无效，跳过计算
  if (!latest || latest.netValue <= 0) {
    return []
  }
  
    const results: PeriodReturn[] = []
  const latestDate = new Date(latest.date)
  
    // [WHAT] 与京东金融对齐：使用精确的日期计算
  // 近1周=7天，近1月=1个月，近3月=3个月，近6月=6个月，近1年=1年，近3年=3年，近5年=5年
  const periods = [
    { period: 'Z', label: '近1周', days: 7 },
    { period: 'Y', label: '近1月', months: 1 },
    { period: '3Y', label: '近3月', months: 3 },
    { period: '6Y', label: '近6月', months: 6 },
    { period: '1N', label: '近1年', years: 1 },
    { period: '3N', label: '近3年', years: 3 },
    { period: '5N', label: '近5年', years: 5 },
    { period: 'YTD', label: '今年来', special: 'ytd' },
    { period: 'SINCE', label: '成立以来', special: 'since' },
  ]
  
    for (const p of periods) {
    // [WHAT] 计算目标日期
    let found: NetValueRecord | null = null
    
    if ('special' in p && p.special === 'ytd') {
      // 今年来：从今年1月1日开始
      const yearStart = `${latestDate.getFullYear()}-01-01`
      for (const record of history) {
        if (record.date >= yearStart) {
          found = record
        }
      }
      // 找到今年第一个交易日
      if (found && found.netValue > 0) {
        const change = ((latest.netValue - found.netValue) / found.netValue) * 100
        results.push({
          period: p.period,
          label: p.label,
          days: Math.floor((latestDate.getTime() - new Date(found.date).getTime()) / (1000 * 60 * 60 * 24)),
          change: parseFloat(change.toFixed(2))
        })
      }
      continue
    }
    
    if ('special' in p && p.special === 'since') {
      // 成立以来：使用最早的历史数据
      found = history[history.length - 1]
      if (found && found.netValue > 0) {
        const change = ((latest.netValue - found.netValue) / found.netValue) * 100
        results.push({
          period: p.period,
          label: p.label,
          days: Math.floor((latestDate.getTime() - new Date(found.date).getTime()) / (1000 * 60 * 60 * 24)),
          change: parseFloat(change.toFixed(2))
        })
      }
      continue
    }
    
    const targetDate = new Date(latestDate)
    if ('days' in p) {
      targetDate.setDate(targetDate.getDate() - p.days)
    } else if ('months' in p) {
      targetDate.setMonth(targetDate.getMonth() - p.months)
    } else if ('years' in p) {
      targetDate.setFullYear(targetDate.getFullYear() - p.years)
    }
    
    // [WHAT] 找到目标日期或之前最近的交易日净值
    for (const record of history) {
      const recordDate = new Date(record.date)
      if (recordDate <= targetDate) {
        found = record
        break
      }
    }
    
    if (found && found.netValue > 0) {
      const change = ((latest.netValue - found.netValue) / found.netValue) * 100
      results.push({
        period: p.period,
        label: p.label,
        days: ('days' in p ? p.days : 'months' in p ? p.months * 30 : p.years * 365),
        change: parseFloat(change.toFixed(2))
      })
    }
  }
  
  cache.set(cacheKey, results, CACHE_TTL.NET_VALUE)
  return results
}

// ========== 大盘指数（简化版） ==========

export interface MarketIndexSimple {
  code: string
  name: string
  current: number
  change: number
  changePercent: number
}

/**
 * 获取大盘指数
 * [WHAT] 上证指数、深证成指、创业板指、沪深300
 */
export async function fetchMarketIndicesFast(): Promise<MarketIndexSimple[]> {
  const cacheKey = 'market_indices'
  const cached = cache.get<MarketIndexSimple[]>(cacheKey)
  if (cached) return cached
  
    try {
    // [WHAT] 添加沪深300指数 (1.000300)
    // [WHAT] 生产环境使用后端代理，开发环境直接调用
    const baseUrl = USE_PROXY ? `${API_BASE_URL}/push2` : 'https://push2.eastmoney.com'
    const url = `${baseUrl}/api/qt/ulist.np/get?fltt=2&secids=1.000001,0.399001,0.399006,1.000300&fields=f2,f3,f4,f12,f14`
    const response = await fetch(url)
    const data = await response.json()
    
    if (!data?.data?.diff) return []
    
    const indices: MarketIndexSimple[] = data.data.diff.map((item: any) => ({
      code: item.f12,
      name: item.f14,
      current: item.f2,
      change: item.f4,
      changePercent: item.f3
    }))
    
    cache.set(cacheKey, indices, CACHE_TTL.MARKET_INDEX)
    return indices
  } catch {
    return []
  }
}

// ========== 基金排行榜（新接口） ==========

export interface FundRankItemSimple {
  code: string
  name: string
  netValue: number
  dayChange: number
}

/**
 * 获取基金排行榜（使用push2接口）
 * @param order 排序方向：1（降序/涨幅榜）、0（升序/跌幅榜）
 * @param pageSize 返回数量
 */
// ========== 基金经理信息 ==========

export interface FundManagerInfo {
  name: string           // 经理姓名
  photo: string          // 头像URL
  workTime: string       // 从业时间
  fundSize: string       // 管理规模
  bestReturn: string     // 最佳回报
  experience: string     // 简介
  funds: {               // 管理的基金
    code: string
    name: string
    type: string
    size: string
    returnRate: string   // 任职回报
    startDate: string    // 任职日期
  }[]
}

/**
 * 获取基金经理信息
 * [WHY] 从天天基金 pingzhongdata 提取经理数据
 */
export async function fetchFundManagerInfo(fundCode: string): Promise<FundManagerInfo | null> {
  const cacheKey = `manager_${fundCode}`
  const cached = cache.get<FundManagerInfo>(cacheKey)
  if (cached) return cached
  
  return new Promise((resolve) => {
    const scriptId = `manager_${fundCode}_${Date.now()}`
    const timeout = setTimeout(() => {
      cleanup()
      resolve(null)
    }, 15000)
    
        const script = document.createElement('script')
    script.id = scriptId
    // [WHAT] 生产环境使用后端代理，开发环境直接调用
    const baseUrl = USE_PROXY ? `${API_BASE_URL}/tiantian` : 'https://fund.eastmoney.com'
    script.src = `${baseUrl}/pingzhongdata/${fundCode}.js?v=${Date.now()}`
    
    script.onload = () => {
      cleanup()
      try {
        // [WHAT] 解析经理数据
        const managerData = (window as any).Data_currentFundManager || []
        
        if (managerData.length === 0) {
          resolve(null)
          return
        }
        
        // [WHY] 通常取第一个经理（主要管理人）
        const main = managerData[0]
        
        // [WHAT] 安全提取最佳回报
        // [EDGE] profit 是复杂对象: { series: [{ data: [{ y: 99.13 }] }] }
        // 其中 data[0].y 是任期收益
        let bestReturn = '--'
        if (main.profit && typeof main.profit === 'object') {
          try {
            const val = main.profit.series?.[0]?.data?.[0]?.y
            if (val !== undefined && val !== null) {
              bestReturn = `${val.toFixed(2)}%`
            }
          } catch {
            bestReturn = '--'
          }
        }
        
        // [WHAT] 提取经理能力评估信息
        // [EDGE] power 包含能力雷达图数据
        let experience = ''
        if (main.power?.categories && main.power?.data) {
          // 组合能力评估为简要说明
          const abilities = main.power.categories.map((cat: string, i: number) => 
            `${cat}: ${main.power.data[i]?.toFixed?.(1) || main.power.data[i] || '--'}分`
          ).join('、')
          experience = `综合能力评分 ${main.power.avr || '--'}。${abilities}`
        }
        
        const manager: FundManagerInfo = {
          name: main.name || '未知',
          photo: main.pic || '',
          workTime: main.workTime || '--',
          fundSize: main.fundSize || '--',
          bestReturn,
          experience,
          // [EDGE] pingzhongdata 不包含基金列表，受 CORS 限制暂无法获取
          funds: []
        }
        
        cache.set(cacheKey, manager, CACHE_TTL.FUND_INFO)
        resolve(manager)
      } catch (err) {
        console.error('解析经理数据失败:', err)
        resolve(null)
      }
    }
    
    script.onerror = () => {
      cleanup()
      resolve(null)
    }
    
    function cleanup() {
      clearTimeout(timeout)
      const s = document.getElementById(scriptId)
      if (s) document.body.removeChild(s)
    }
    
    document.body.appendChild(script)
  })
}

export async function fetchFundRankingFast(
  order: 1 | 0 = 1,
  pageSize = 30
): Promise<FundRankItemSimple[]> {
  const cacheKey = `ranking_${order}_${pageSize}`
  const cached = cache.get<FundRankItemSimple[]>(cacheKey)
  if (cached) return cached
  
    try {
    // [WHY] 使用push2接口获取场内基金排行（ETF/LOF等）
    // [WHAT] 生产环境使用后端代理，开发环境直接调用
    const baseUrl = USE_PROXY ? `${API_BASE_URL}/push2` : 'https://push2.eastmoney.com'
    const url = `${baseUrl}/api/qt/clist/get?pn=1&pz=${pageSize}&po=${order}&np=1&fltt=2&invt=2&fid=f3&fs=b:MK0021&fields=f2,f3,f4,f12,f14&_=${Date.now()}`
    
    const response = await fetch(url)
    const data = await response.json()
    
    if (!data?.data?.diff) return []
    
    const items: FundRankItemSimple[] = data.data.diff.map((item: any) => ({
      code: item.f12,
      name: item.f14,
      netValue: item.f2 || 0,
      dayChange: item.f3 || 0
    }))
    
    cache.set(cacheKey, items, 30000)  // 30秒缓存
    return items
  } catch (err) {
    console.error('获取基金排行失败:', err)
    return []
  }
}

// ========== 经理业绩走势 ==========

export interface ManagerProfitPoint {
  date: string      // 日期 YYYY-MM-DD
  profit: number    // 累计收益率%
}

/**
 * 获取经理任职期间业绩走势
 * [WHY] 展示经理管理该基金的累计收益曲线
 * [HOW] 从 pingzhongdata.js 获取 Data_grandTotal（累计收益走势）
 */
export async function fetchManagerProfit(fundCode: string): Promise<ManagerProfitPoint[]> {
  const cacheKey = `manager_profit_${fundCode}`
  const cached = cache.get<ManagerProfitPoint[]>(cacheKey)
  if (cached) return cached
  
  return new Promise((resolve) => {
    const scriptId = `mprofit_${fundCode}_${Date.now()}`
    const timeout = setTimeout(() => {
      cleanup()
      resolve([])
    }, 10000)
    
        const script = document.createElement('script')
    script.id = scriptId
    // [WHAT] 生产环境使用后端代理，开发环境直接调用
    const baseUrl = USE_PROXY ? `${API_BASE_URL}/tiantian` : 'https://fund.eastmoney.com'
    script.src = `${baseUrl}/pingzhongdata/${fundCode}.js?v=${Date.now()}`
    
    script.onload = () => {
      cleanup()
      
      try {
        // [WHAT] Data_grandTotal 格式: [[timestamp, value], ...]
        // 表示累计收益率走势
        const grandTotal = (window as any).Data_grandTotal || []
        
        if (!Array.isArray(grandTotal) || grandTotal.length === 0) {
          resolve([])
          return
        }
        
        // [WHAT] 转换为日期-收益率格式
        // [EDGE] 数据量可能很大，采样到最多200个点
        const step = Math.max(1, Math.floor(grandTotal.length / 200))
        const result: ManagerProfitPoint[] = []
        
        for (let i = 0; i < grandTotal.length; i += step) {
          const item = grandTotal[i]
          if (Array.isArray(item) && item.length >= 2) {
            const date = new Date(item[0])
            result.push({
              date: getBeijingDateString(date),
              profit: item[1] || 0
            })
          }
        }
        
        // [EDGE] 确保包含最后一个点
        const last = grandTotal[grandTotal.length - 1]
        const lastResult = result[result.length - 1]
        if (last && lastResult && lastResult.date !== getBeijingDateString(new Date(last[0]))) {
          const date = new Date(last[0])
          result.push({
            date: getBeijingDateString(date),
            profit: last[1] || 0
          })
        }
        
        cache.set(cacheKey, result, CACHE_TTL.NET_VALUE)
        resolve(result)
      } catch {
        resolve([])
      }
    }
    
    script.onerror = () => {
      cleanup()
      resolve([])
    }
    
    function cleanup() {
      clearTimeout(timeout)
      const s = document.getElementById(scriptId)
      if (s) document.body.removeChild(s)
    }
    
    document.body.appendChild(script)
  })
}
