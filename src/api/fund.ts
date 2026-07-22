// [WHY] 封装基金数据 API，统一管理数据获取逻辑
// [WHAT] 提供基金实时估值、基金搜索、历史净值、重仓股等接口
// [DEPS] 依赖天天基金公开接口，禁止高频请求

import type { FundEstimate, FundInfo, NetValueRecord, StockHolding, MarketIndex, FundRankItem, FundFeeInfo, FundShareClass } from '@/types/fund'
import { API_BASE_URL, USE_PROXY } from '@/config/api'
import { fetchFundEstimateFast, fetchFundEstimatesBatch } from './fundFast'

// [WHAT] 带超时的 fetch 封装
async function fetchWithTimeout(url: string, options: RequestInit = {}, timeoutMs: number = 5000): Promise<Response> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const response = await fetch(url, { ...options, signal: controller.signal })
    return response
  } finally {
    clearTimeout(timer)
  }
}

// ========== K线数据类型 ==========
export interface KLineData {
  time: string      // YYYY-MM-DD
  open: number      // 开盘净值
  high: number      // 最高净值
  low: number       // 最低净值
  close: number     // 收盘净值
}

// ========== 分时数据类型 ==========
export interface TimeShareData {
  time: string      // HH:mm:ss
  value: number     // 估值
  change: number    // 涨跌幅
}

// 基金列表缓存（避免重复请求）
let fundListCache: FundInfo[] | null = null

/**
 * 获取单只基金实时估值
 * [FIX] 委托给 fundFast.ts 统一管理 JSONP 回调，避免两个模块互相覆盖 window.jsonpgz
 * @param code 基金代码
 * @returns 基金估值数据
 */
export { fetchFundEstimateFast as fetchFundEstimate } from './fundFast'

/**
 * 批量获取基金实时估值
 * [WHY] 自选列表需要同时获取多只基金的估值
 * [FIX] 移除远程后端依赖，直接使用 JSONP 逐个获取，避免后端慢导致一直加载
 * [EDGE] 部分基金可能请求失败，返回 null
 * @param codes 基金代码数组
 * @returns 基金估值数组（失败的为 null）
 */
export async function fetchFundEstimates(
  codes: string[]
): Promise<(FundEstimate | null)[]> {
  if (codes.length === 0) return []

  const estimates = await fetchFundEstimatesBatch(codes)
  return codes.map(code => estimates.get(code) || null)
}

/**
 * 获取基金列表（用于搜索）
 * [WHY] 优先从后端API获取基金列表，速度快、稳定、支持搜索
 * [HOW] 调用 /api/fund-list 接口
 * [EDGE] 失败时回退到本地 JSONP
 */
export async function fetchFundList(): Promise<FundInfo[]> {
  // [WHY] 已缓存则直接返回，避免重复请求
  if (fundListCache) {
    return fundListCache
  }

  try {
    // [WHAT] 优先使用后端API
    // [FIX] 使用大pageSize获取全量基金列表（默认50条太少，搜索匹配不到）
    const url = `${API_BASE_URL}/api/fund-list?pageSize=30000`
    const response = await fetchWithTimeout(url, {
      headers: {
        'Content-Type': 'application/json'
      }
    }, 10000)

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}: ${response.statusText}`)
    }

    const result = await response.json()
    if (Array.isArray(result.data) && result.data.length > 0) {
      fundListCache = result.data as FundInfo[]
      console.log(`[Fund API] 从后端API加载基金列表成功: ${fundListCache.length} 只`)
      return fundListCache
    }
  } catch (error) {
    console.warn('[Fund API] 后端API加载失败，回退到JSONP:', error)
  }

  // [EDGE] 后端API失败时，回退到JSONP
  console.error('[Fund API] 回退到远程JSONP请求')
  return fetchFundListFromRemote()
}

/**
 * 从远程获取基金列表（备用方案）
 * [WHY] 当本地 JSON 不存在时的回退方案
 */
async function fetchFundListFromRemote(): Promise<FundInfo[]> {
  return new Promise((resolve, reject) => {
    const callbackName = `fundlist_${Date.now()}`
    const timeout = setTimeout(() => {
      cleanup()
      reject(new Error('获取基金列表超时'))
    }, 30000)

    ;(window as any).r = null
    
    function cleanup() {
      clearTimeout(timeout)
      const script = document.getElementById(callbackName)
      if (script) {
        document.body.removeChild(script)
      }
    }

        const script = document.createElement('script')
    script.id = callbackName
    // [WHAT] 生产环境使用后端代理，开发环境直接调用
    const baseUrl = USE_PROXY ? `${API_BASE_URL}/tiantian` : 'https://fund.eastmoney.com'
    script.src = `${baseUrl}/js/fundcode_search.js?rt=${Date.now()}`
    script.onload = () => {
      cleanup()
      const rawData = (window as any).r
      if (!rawData || !Array.isArray(rawData)) {
        reject(new Error('基金列表数据格式错误'))
        return
      }
      fundListCache = rawData.map((item: string[]) => ({
        code: item[0] || '',
        pinyin: item[1] || '',
        name: item[2] || '',
        type: item[3] || ''
      }))
      resolve(fundListCache!)
    }
    script.onerror = () => {
      cleanup()
      reject(new Error('获取基金列表失败'))
    }
    document.body.appendChild(script)
  })
}

/**
 * 搜索基金（本地过滤）
 * [WHY] 全量列表已缓存，本地搜索比服务端快
 * [WHAT] 支持按代码、名称、拼音搜索
 * [ENHANCED] 去除空格匹配 + 拆分关键词模糊搜索
 * @param keyword 搜索关键词
 * @param limit 返回数量限制
 */
export async function searchFund(
  keyword: string,
  limit = 20
): Promise<FundInfo[]> {
  const list = await fetchFundList()
  if (!keyword.trim()) {
    return []
  }
  
  // [FIX] 去除所有空格（OCR常把"嘉实信息产业"识别为"嘉实 信息 产业"）
  const kw = keyword.toLowerCase().trim()
  const kwNoSpace = kw.replace(/\s+/g, '')
  
  // [DEBUG] 记录搜索关键词
  console.log(`🔍 searchFund: 原始="${keyword}", 去空格="${kwNoSpace}", 列表总数=${list.length}`)
  
  // [NEW] 拆分关键词为数组（用于多词匹配）
  const kwParts = kw.split(/\s+/).filter(p => p.length >= 2)
  
  // [HOW] 多策略匹配 + 相似度评分
  const scoredResults: { item: FundInfo, score: number }[] = []
  
  for (const item of list) {
    let score = 0
    const itemName = item.name.toLowerCase()
    const itemNameNoSpace = itemName.replace(/\s+/g, '')
    const itemPinyin = item.pinyin.toLowerCase()
    const itemPinyinNoSpace = itemPinyin.replace(/\s+/g, '')
    
    // 策略1: 去空格精确匹配 (权重最高)
    if (itemNameNoSpace.includes(kwNoSpace) || kwNoSpace.includes(itemNameNoSpace)) {
      score += 100
    }
    
    // 策略2: 代码匹配
    if (item.code.includes(kwNoSpace)) {
      score += 100
    }
    
    // 策略3: 拼音去空格匹配
    if (itemPinyinNoSpace.includes(kwNoSpace)) {
      score += 90
    }
    
    // 策略4: 多关键词全部命中
    if (kwParts.length >= 2) {
      const allMatch = kwParts.every(part => {
        const partNoSpace = part.replace(/\s+/g, '')
        return itemNameNoSpace.includes(partNoSpace) || itemPinyinNoSpace.includes(partNoSpace)
      })
      if (allMatch) score += 80
    }
    
    // [NEW] 策略5: 核心关键词部分匹配（放宽条件）
    if (kwNoSpace.length >= 4) {
      let matchCount = 0
      for (let i = 0; i < kwNoSpace.length - 2; i++) {
        const subStr = kwNoSpace.substring(i, i + 3)
        if (itemNameNoSpace.includes(subStr)) matchCount++
      }
      if (matchCount >= kwNoSpace.length * 0.25) score += Math.round(matchCount * 10)
    }
    
    // [NEW] 策略6: 单字包含检测（最宽松）
    if (kwParts.length >= 3) {
      const matchedParts = kwParts.filter(part => {
        const partNoSpace = part.replace(/\s+/g, '').substring(0, 4)
        return partNoSpace.length >= 2 && (
          itemNameNoSpace.includes(partNoSpace) || 
          itemPinyinNoSpace.includes(partNoSpace)
        )
      })
      if (matchedParts.length >= Math.ceil(kwParts.length * 0.5)) {
        score += matchedParts.length * 15
      }
    }
    
    // [NEW] 策略7: 公司名称匹配（嘉实/华泰柏瑞等）
    const companyNames = ['嘉实', '易方达', '广发', '华夏', '汇添富', '富国', '招商', '南方', '国泰', '博时', 
                         '华安', '银华', '工银', '建信', '农银', '中银', '交银', '浦银', '民生', '国寿',
                         '平安', '太保', '新华', '泰康', '人保', '华泰柏瑞', '国投瑞银', '中欧', '上投摩根', 
                         '兴全', '东证资管', '海富通', '景顺长城', '长城', '银河', '摩根士丹利华鑫', '大成']
    for (const company of companyNames) {
      if ((kwNoSpace.includes(company) && itemNameNoSpace.includes(company)) ||
          (itemNameNoSpace.includes(company) && kwNoSpace.includes(company))) {
        score += 20
      }
    }
    
    // [NEW] 策略8: 基金类型关键词匹配
    const typeKeywords = ['混合', '股票', '债券', '货币', '指数', 'ETF', 'QDII', '联接', 'LOF']
    for (const typeKw of typeKeywords) {
      if (kwNoSpace.includes(typeKw) && itemNameNoSpace.includes(typeKw)) {
        score += 15
      }
    }
    
    if (score > 0) {
      scoredResults.push({ item, score })
    }
  }
  
  // 按得分排序
  scoredResults.sort((a, b) => b.score - a.score)
  
  // [DEBUG] 输出搜索结果
  console.log(`📊 searchFund 匹配到 ${scoredResults.length} 个候选`)
  if (scoredResults.length > 0) {
    console.log(`💡 Top3: ${scoredResults.slice(0, 3).map(s => `${s.item.code} ${s.item.name} (${s.score}分)`).join(' | ')}`)
  } else {
    // [CRITICAL] 绝对兜底：返回前5个基金
    console.log(`⚠️ 无任何匹配，强制返回前${Math.min(5, limit)}个基金作为兜底`)
    return list.slice(0, Math.min(5, limit))
  }
  
  // 返回得分最高的结果
  const results = scoredResults.slice(0, limit).map(s => s.item)
  return results
}

/**
 * 根据基金代码查找基金类型
 * [WHY] 自选和持仓页面需要显示基金类型
 * [HOW] 从 fund-list.json 缓存中查找，找不到返回空字符串
 */
export async function getFundType(code: string): Promise<string> {
  const list = await fetchFundList()
  const fund = list.find((item) => item.code === code)
  return fund?.type || ''
}

/**
 * 批量查找基金类型
 * [WHY] 初始化自选/持仓列表时批量获取类型，避免逐个请求
 * [WHAT] 从后端API获取基金列表并提取类型
 */
export async function getFundTypes(codes: string[]): Promise<Map<string, string>> {
  try {
    const list = await fetchFundList()
    const typeMap = new Map<string, string>()
    for (const code of codes) {
      const fund = list.find((item) => item.code === code)
      if (fund) {
        typeMap.set(code, fund.type)
      }
    }
    return typeMap
  } catch (error) {
    console.warn('[Fund API] 获取基金类型失败，返回空Map:', error)
    return new Map<string, string>()
  }
}

/**
 * 获取基金历史净值
 * [WHY] 用于绘制净值走势图
 * [WHAT] 获取最近 N 天的单位净值数据
 * @param code 基金代码
 * @param pageSize 获取条数（默认30天）
 */
export async function fetchNetValueHistory(
  code: string,
  pageSize = 30
): Promise<NetValueRecord[]> {
  return new Promise((resolve, reject) => {
    const callbackName = `lsjz_${Date.now()}_${Math.random().toString(36).slice(2)}`
    const timeout = setTimeout(() => {
      cleanup()
      reject(new Error('获取历史净值超时'))
    }, 15000)

    ;(window as any)[callbackName] = (data: any) => {
      cleanup()
      if (!data || !data.Data || !data.Data.LSJZList) {
        resolve([])
        return
      }
      // [WHAT] 转换数据格式
      // 原始格式：{ FSRQ: "2024-01-30", DWJZ: "1.2345", LJJZ: "1.5678", JZZZL: "1.23" }
      const records: NetValueRecord[] = data.Data.LSJZList.map((item: any) => ({
        date: item.FSRQ,           // 净值日期
        netValue: parseFloat(item.DWJZ) || 0,    // 单位净值
        totalValue: parseFloat(item.LJJZ) || 0,  // 累计净值
        changeRate: parseFloat(item.JZZZL) || 0  // 日涨跌幅
      }))
      resolve(records)
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
    // [DEPS] 东方财富历史净值接口
    // [WHAT] 生产环境使用后端代理，开发环境直接调用
    const baseUrl = USE_PROXY ? `${API_BASE_URL}/eastmoney` : 'https://api.fund.eastmoney.com'
    script.src = `${baseUrl}/f10/lsjz?callback=${callbackName}&fundCode=${code}&pageIndex=1&pageSize=${pageSize}&_=${Date.now()}`
    script.onerror = () => {
      cleanup()
      reject(new Error('获取历史净值失败'))
    }
    document.body.appendChild(script)
  })
}

/**
 * 获取基金重仓股票
 * [WHY] 展示基金持有的股票及占比，包括较上期变化
 * [WHAT] 与APK版本一致：获取当期持仓 → 获取上期持仓 → 对比占比计算变化 → 获取实时涨跌幅
 * [HOW] 1. 加载当期HTML → 解析持仓 → 提取年份
 *        2. 加载上期HTML → 解析上期持仓
 *        3. 对比两期占比，计算 changeFromLast
 *        4. 批量获取股票实时涨跌幅
 * @param code 基金代码
 */
export async function fetchStockHoldings(code: string): Promise<StockHolding[]> {
  try {
    const response = await fetchWithTimeout(`${API_BASE_URL}/api/funds/${code}/holdings?quotes=1`, {}, 7000)
    if (response.ok) {
      const payload = await response.json()
      const holdings: StockHolding[] = (payload?.data?.holdings || []).map((item: any) => ({
        stockCode: item.stockCode || '',
        stockName: item.stockName || '',
        holdingRatio: Number(item.holdingRatio) || 0,
        holdingAmount: item.holdingMarketValue ? String(item.holdingMarketValue) : '0',
        changeFromLast: '--',
        marketPrefix: item.marketPrefix || '',
        dayChange: Number.isFinite(Number(item.dayChange)) ? Number(item.dayChange) : undefined,
        quarterChange: Number.isFinite(Number(item.quarterChange)) ? Number(item.quarterChange) : null,
        sector: typeof item.sector === 'string' && item.sector ? item.sector : null
      })).filter((item: StockHolding) => item.stockCode && item.stockName && item.holdingRatio > 0)
      if (holdings.length > 0) return holdings
    }
  } catch {
    // 后端不可用时继续使用原 JSONP 流程。
  }
  return fetchStockHoldingsFromJsonp(code)
}

function fetchStockHoldingsFromJsonp(code: string): Promise<StockHolding[]> {
  return new Promise((resolve) => {
    const timeout = setTimeout(() => {
      cleanup()
      console.log('[重仓股] 请求超时')
      resolve([])
    }, 15000)

    function cleanup() {
      clearTimeout(timeout)
      ;(window as any).apidata = undefined
      const el = document.getElementById('holdings-script')
      if (el) document.body.removeChild(el)
    }

    ;(window as any).apidata = undefined

    const script = document.createElement('script')
    script.id = 'holdings-script'
    script.src = `https://fundf10.eastmoney.com/FundArchivesDatas.aspx?type=jjcc&code=${code}&topline=10&year=&month=&rt=${Date.now()}`
    script.onload = () => {
      try {
        const data = (window as any).apidata
        console.log('[重仓股] Script加载完成:', data)

        if (!data || !data.content) {
          console.log('[重仓股] 无数据')
          cleanup()
          resolve([])
          return
        }

        const holdings = parseStockHoldingsHtml(data.content)
        console.log('[重仓股] 当期解析结果:', holdings)

        // [WHAT] 从HTML中提取年份
        const yearMatch = data.content.match(/(\d{4})年/)
        const currentYear = yearMatch ? yearMatch[1] : ''

        cleanup()

        if (holdings.length === 0) {
          resolve([])
          return
        }

        // [WHAT] 获取上期数据并计算较上期变化，然后获取涨跌幅
        fetchPreviousHoldings(code, currentYear, holdings).then(enrichedHoldings => {
          fetchStockQuotes(enrichedHoldings).then(updatedHoldings => {
            console.log('[重仓股] 最终结果:', updatedHoldings)
            resolve(updatedHoldings)
          })
        })
      } catch (err) {
        console.error('[重仓股] 解析失败:', err)
        cleanup()
        resolve([])
      }
    }
    script.onerror = () => {
      console.log('[重仓股] Script加载失败')
      cleanup()
      resolve([])
    }
    document.body.appendChild(script)
  })
}

/**
 * [WHAT] 获取上期重仓股数据，通过占比差值计算 changeFromLast
 * [HOW] 与APK版本一致：加载上一年的持仓HTML，对比占比
 */
function fetchPreviousHoldings(
  code: string,
  currentYear: string,
  holdings: StockHolding[]
): Promise<StockHolding[]> {
  if (!currentYear || holdings.length === 0) {
    return Promise.resolve(holdings)
  }

  const prevYear = String(parseInt(currentYear) - 1)

  return new Promise((resolve) => {
    const callbackId = `holdings_prev_${code}_${Date.now()}`
    const timeout = setTimeout(() => {
      cleanup()
      resolve(holdings)
    // The chart is supplementary to the detail page. Fall back promptly when
    // the external JSONP endpoint stalls instead of holding its loading state.
    }, 3500)

    ;(window as any).apidata = undefined

    function cleanup() {
      clearTimeout(timeout)
      const el = document.getElementById(callbackId)
      if (el) document.body.removeChild(el)
    }

    const script = document.createElement('script')
    script.id = callbackId
    script.src = `https://fundf10.eastmoney.com/FundArchivesDatas.aspx?type=jjcc&code=${code}&topline=10&year=${prevYear}&_=${Date.now()}`
    script.onload = () => {
      try {
        const data = (window as any).apidata
        cleanup()

        if (!data || !data.content) {
          resolve(holdings)
          return
        }

        const prevHoldings = parseStockHoldingsHtml(data.content)
        console.log('[重仓股] 上期解析结果:', prevHoldings)

        if (prevHoldings.length > 0) {
          // [WHAT] 构建上期占比映射
          const prevRatioMap = new Map(prevHoldings.map(h => [h.stockCode, h.holdingRatio]))

          // [WHAT] 对比两期占比，计算 changeFromLast
          for (const h of holdings) {
            const prevRatio = prevRatioMap.get(h.stockCode)
            if (prevRatio !== undefined) {
              const diff = h.holdingRatio - prevRatio
              if (diff === 0) {
                h.changeFromLast = '持平'
              } else {
                h.changeFromLast = `${diff > 0 ? '+' : ''}${diff.toFixed(2)}%`
              }
            } else {
              h.changeFromLast = '新增'
            }
          }
        }

        resolve(holdings)
      } catch (err) {
        console.error('[重仓股] 上期数据解析失败:', err)
        cleanup()
        resolve(holdings)
      }
    }
    script.onerror = () => {
      cleanup()
      resolve(holdings)
    }
    document.body.appendChild(script)
  })
}

/**
 * 解析重仓股 HTML 数据
 * [WHY] 东方财富返回的是 HTML 格式，需要解析
 * [WHAT] 提取股票代码、名称、占比等信息
 * [EDGE] 支持新旧两种HTML格式：
 *   - 旧格式：quote_300308.html
 *   - 新格式：//quote.eastmoney.com/unify/r/0.300308 或 //quote.eastmoney.com/unify/r/116.06869
 * [EDGE] 支持QDII基金的不同HTML格式：
 *   - 股票名称：QDII 用 class='toc'，A股 用 class='tol'
 *   - 占比：QDII 用普通 <td>，A股 用 class='tor'
 */
function parseStockHoldingsHtml(html: string): StockHolding[] {
  const holdings: StockHolding[] = []

  // [HOW] 使用正则匹配 HTML 表格中的数据
  const tableRegex = /<tr[^>]*>[\s\S]*?<\/tr>/gi
  const rows = html.match(tableRegex) || []
  console.log('[解析重仓股] 找到行数:', rows.length)

  for (const row of rows) {
    // 跳过表头
    if (row.includes('<th')) continue

        // [WHAT] 提取股票代码 - 支持多种格式
    let stockCode = ''
    let marketPrefix = ''

    // 尝试匹配新格式：//quote.eastmoney.com/unify/r/1.600519 或 //quote.eastmoney.com/unify/r/116.06869
    const newFormatMatch = row.match(/quote\.eastmoney\.com\/unify\/r\/(\d+)\.([A-Za-z0-9]+)/i)
    if (newFormatMatch) {
      marketPrefix = newFormatMatch[1]
      stockCode = newFormatMatch[2]
    } else {
      // 尝试匹配旧格式：quote_300308.html
      const oldFormatMatch = row.match(/quote_([A-Za-z0-9]+)\.html/i)
      if (oldFormatMatch) {
        stockCode = oldFormatMatch[1]
            } else {
        // [WHAT] 匹配QDII格式：https://quote.eastmoney.com/hk/09868.html
        const qdiiMatch = row.match(/quote\.eastmoney\.com\/[a-z]+\/([A-Za-z0-9]+)\.html/i)
        if (qdiiMatch) {
          stockCode = qdiiMatch[1]
          marketPrefix = '116'  // 港股
        }
      }
    }

    if (!stockCode) {
      console.log('[解析重仓股] 未找到股票代码，row前200:', row.substring(0, 200))
      continue
    }

    // [WHAT] 提取所有 <a> 标签的文本内容
    const linkTexts: string[] = []
    const linkRegex = /<a[^>]*>([^<]+)<\/a>/gi
    let linkMatch
    while ((linkMatch = linkRegex.exec(row)) !== null) {
      linkTexts.push(linkMatch[1].trim())
    }

    // [WHAT] 股票名称 = 第二个 <a> 标签的文本（第一个是代码链接）
    const stockName = linkTexts.length >= 2 ? linkTexts[1] : (linkTexts[0] || '')

    // [WHAT] 提取所有 <td> 的纯文本内容
    const tdRegex = /<td[^>]*>([\s\S]*?)<\/td>/gi
    const tds: string[] = []
    let tdMatch
    while ((tdMatch = tdRegex.exec(row)) !== null) {
      // 去除HTML标签，只保留纯文本
      const text = (tdMatch[1] || '').replace(/<[^>]+>/g, '').trim()
      tds.push(text)
    }

            console.log('[解析重仓股] 股票:', stockCode, stockName, 'tds:', tds)

    // [WHAT] 根据列顺序提取数据
    // HTML结构: 序号(0), 代码(1), 名称(2), 最新价(3-动态), 涨跌幅(4-动态), 资讯(5), 占比(6), 持股数(7), 持仓市值(8)
    // 注意：最新价和涨跌幅是动态加载的（span标签），HTML中为空
    let holdingRatio = 0
    let holdingAmount = '0'

    // 占比在第6列
    if (tds.length >= 7) {
      holdingRatio = parseFloat((tds[6] || '0').replace('%', '')) || 0
      holdingAmount = tds[8] || '0'
    }

    console.log('[解析重仓股] 占比:', holdingRatio, '市值:', holdingAmount)

    holdings.push({
      stockCode,
      stockName,
      holdingRatio,
      holdingAmount,
      changeFromLast: '--',
      marketPrefix
    })
  }

    return holdings
}

/**
 * [WHAT] 批量获取股票涨跌幅
 * [WHY] 重仓股需要显示当日涨跌幅
 * [HOW] A股用批量接口，港股逐个获取
 */
async function fetchStockQuotes(holdings: StockHolding[]): Promise<StockHolding[]> {
  try {
    // 分离A股和港股
    const aStocks = holdings.filter(h => h.marketPrefix !== '116')
    const hkStocks = holdings.filter(h => h.marketPrefix === '116')

                // [HOW] A股批量获取（使用 ulist.np 接口）
    // [WHAT] 生产环境使用后端代理，开发环境直接调用
    const push2BaseUrl = USE_PROXY ? `${API_BASE_URL}/push2` : 'https://push2.eastmoney.com'
    if (aStocks.length > 0) {
      const secids = aStocks.map(h => `${h.marketPrefix || '0'}.${h.stockCode}`).join(',')
      const url = `${push2BaseUrl}/api/qt/ulist.np/get?fltt=2&secids=${secids}&fields=f2,f3,f12,f14&ut=fa5fd1943c7b386f172d6893dbfba10b&_=${Date.now()}`

      const response = await fetchWithTimeout(url, {
        headers: {
          'Referer': 'https://quote.eastmoney.com/',
          'User-Agent': 'Mozilla/5.0'
        }
      }, 5000)

      // [FIX] 检查响应状态，避免 500 错误时解析空响应体导致崩溃
      if (!response.ok) {
        console.warn(`[股票行情] A股请求失败: HTTP ${response.status}`)
        return holdings
      }
      
      const data = await response.json()
      console.log('[股票行情] A股响应:', data)

      if (data.data && data.data.diff) {
        for (const holding of aStocks) {
          const quote = data.data.diff.find((q: any) => q.f12 === holding.stockCode)
          if (quote && quote.f3 !== undefined) {
            // [FIX] fltt=2 时 f3 已是百分比数值（如 3.25 表示 3.25%），无需除以100
            holding.dayChange = quote.f3
            console.log(`[股票行情] ${holding.stockName} 涨跌幅: ${holding.dayChange}%`)
          }
        }
      }
    }

        // [HOW] 港股逐个获取（批量接口不支持港股）
    for (const holding of hkStocks) {
      try {
        const url = `${push2BaseUrl}/api/qt/stock/get?secid=116.${holding.stockCode}&fields=f170&_=1234567890`
        const response = await fetchWithTimeout(url, {
          headers: {
            'Referer': 'https://quote.eastmoney.com/',
            'User-Agent': 'Mozilla/5.0'
          }
        }, 3000)

        // [FIX] 检查响应状态，避免 500 错误时解析空响应体导致崩溃
        if (!response.ok) continue
        
        const data = await response.json()
        if (data.data && data.data.f170 !== undefined) {
          // [NOTE] 港股 f170 是乘以100的整数（382 表示 3.82%），需要除以100
          holding.dayChange = data.data.f170 / 100
          console.log(`[股票行情] ${holding.stockName} 涨跌幅: ${holding.dayChange}%`)
        }
      } catch (e) {
        console.error(`[股票行情] 港股 ${holding.stockCode} 获取失败:`, e)
      }
    }

    return holdings

  } catch (error) {
    console.error('[股票行情] 获取失败:', error)
    return holdings
  }
}

// ========== 大盘指数和排行榜 API ==========

/**
 * 获取大盘指数数据
 * [WHY] 展示上证、深证、创业板等主要指数
 * [DEPS] 东方财富指数接口
 */
export async function fetchMarketIndices(): Promise<MarketIndex[]> {
  return new Promise((resolve) => {
    const callbackName = `index_${Date.now()}_${Math.random().toString(36).slice(2)}`
    const timeout = setTimeout(() => {
      cleanup()
      // [EDGE] 超时返回空数组
      resolve([])
    }, 10000)

    ;(window as any)[callbackName] = (data: any) => {
      cleanup()
      if (!data || !data.data || !data.data.diff) {
        // [EDGE] 接口失败时返回空数组，不使用模拟数据
        resolve([])
        return
      }
      
      const indices: MarketIndex[] = data.data.diff.map((item: any) => ({
        code: item.f12,
        name: item.f14,
        current: item.f2 / 100,
        change: item.f4 / 100,
        changeRate: item.f3 / 100,
        volume: item.f6 / 100000000
      }))
      resolve(indices)
    }

    function cleanup() {
      clearTimeout(timeout)
      delete (window as any)[callbackName]
      const script = document.getElementById(callbackName)
      if (script) document.body.removeChild(script)
    }

        const script = document.createElement('script')
    script.id = callbackName
    // [WHAT] 请求上证指数(1.000001)、深证成指(0.399001)、创业板指(0.399006)、科创50(1.000688)
    // [WHAT] 生产环境使用后端代理，开发环境直接调用
    const push2BaseUrl = USE_PROXY ? `${API_BASE_URL}/push2` : 'https://push2.eastmoney.com'
    script.src = `${push2BaseUrl}/api/qt/ulist.np/get?cb=${callbackName}&fltt=2&secids=1.000001,0.399001,0.399006,1.000688&fields=f2,f3,f4,f6,f12,f14&_=${Date.now()}`
    script.onerror = () => {
      cleanup()
      resolve([])
    }
    document.body.appendChild(script)
  })
}

/**
 * 获取基金排行榜
 * [WHY] 展示涨幅榜、跌幅榜等排行数据
 * @param sortType 排序类型：r（日涨幅）、zzf（周涨幅）、1yzf（月涨幅）、6yzf（6月涨幅）、1nzf（年涨幅）
 * @param order 排序方向：desc（降序）、asc（升序）
 * @param pageSize 返回数量
 */
export async function fetchFundRanking(
  sortType = 'r',
  order = 'desc',
  pageSize = 20
): Promise<FundRankItem[]> {
  return new Promise((resolve) => {
    const callbackName = `rank_${Date.now()}_${Math.random().toString(36).slice(2)}`
    const timeout = setTimeout(() => {
      cleanup()
      resolve([])
    }, 15000)

    ;(window as any)[callbackName] = (data: any) => {
      cleanup()
      if (!data || !data.Data) {
        resolve([])
        return
      }
      
      // [WHAT] 解析排行数据
      const items: FundRankItem[] = data.Data.map((item: string) => {
        const parts = item.split(',')
        return {
          code: parts[0] || '',
          name: parts[1] || '',
          type: parts[3] || '',
          netValue: parseFloat(parts[4] ?? '0') || 0,
          dayChange: parseFloat(parts[6] ?? '0') || 0,
          weekChange: parseFloat(parts[7] ?? '0') || 0,
          monthChange: parseFloat(parts[8] ?? '0') || 0,
          yearChange: parseFloat(parts[11] ?? '0') || 0
        }
      })
      resolve(items)
    }

    function cleanup() {
      clearTimeout(timeout)
      delete (window as any)[callbackName]
      const script = document.getElementById(callbackName)
      if (script) document.body.removeChild(script)
    }

        const script = document.createElement('script')
    script.id = callbackName
    // [DEPS] 东方财富基金排行接口
    // [WHAT] 生产环境使用后端代理，开发环境直接调用
    const baseUrl = USE_PROXY ? `${API_BASE_URL}/tiantian` : 'https://fund.eastmoney.com'
    script.src = `${baseUrl}/data/rankhandler.aspx?op=ph&dt=kf&ft=all&rs=&gs=0&sc=${sortType}&st=${order}&pi=1&pn=${pageSize}&dx=1&callback=${callbackName}&_=${Date.now()}`
    script.onerror = () => {
      cleanup()
      resolve([])
    }
    document.body.appendChild(script)
  })
}

// ========== K线数据 API ==========

/**
 * 获取基金K线数据（用于绘制K线图）
 * [WHY] 将历史净值数据转换为K线格式（OHLC）
 * [WHAT] 基金没有真正的OHLC，用相邻净值模拟
 * @param code 基金代码
 * @param days 获取天数
 */
export async function fetchKLineData(code: string, days = 120): Promise<KLineData[]> {
  // [WHY] 获取历史净值，然后转换为K线格式
  const history = await fetchNetValueHistory(code, days + 1)
  if (history.length < 2) return []

  const klineData: KLineData[] = []
  // [WHAT] 将净值数据转换为K线格式
  // 基金净值是收盘价，用前一日收盘作为开盘，计算当日高低点
  const reversed = [...history].reverse() // 按时间正序

  for (let i = 1; i < reversed.length; i++) {
    const prev = reversed[i - 1]
    const curr = reversed[i]
    const open = prev.netValue
    const close = curr.netValue
    // [WHAT] 模拟日内波动：高点和低点基于开盘收盘价的波动
    const volatility = Math.abs(close - open) * 0.3
    const high = Math.max(open, close) + volatility
    const low = Math.min(open, close) - volatility

    klineData.push({
      time: curr.date,
      open: parseFloat(open.toFixed(4)),
      high: parseFloat(high.toFixed(4)),
      low: parseFloat(Math.max(0.0001, low).toFixed(4)),
      close: parseFloat(close.toFixed(4))
    })
  }

  return klineData
}

// ========== 实时分时数据 API ==========

// [WHAT] 分时数据缓存，避免频繁请求
const timeShareCache: Map<string, { data: TimeShareData[]; timestamp: number }> = new Map()

/**
 * 获取基金当日分时数据
 * [WHY] 展示当日估值变化曲线，精确到秒
 * @param code 基金代码
 */
export async function fetchTimeShareData(code: string): Promise<TimeShareData[]> {
  // Keep the client cache shorter than the backend's one-second curve write.
  // The server owns persistence, finalization, and source validation.
  const cached = timeShareCache.get(code)
  if (cached && Date.now() - cached.timestamp < 500) {
    return cached.data
  }

  try {
    const response = await fetchWithTimeout(`${API_BASE_URL}/api/funds/${encodeURIComponent(code)}/intraday`, {
      cache: 'no-store'
    }, 5_000)
    if (!response.ok) return []
    const payload = await response.json()
    const result = (payload?.data?.points || [])
      .map((point: any) => ({
        time: String(point?.time || ''),
        value: Number(point?.value),
        change: Number(point?.change)
      }))
      .filter((point: TimeShareData) => point.time && Number.isFinite(point.value) && Number.isFinite(point.change))
    timeShareCache.set(code, { data: result, timestamp: Date.now() })
    return result
  } catch {}

  return []
}

// [WHAT] 通过fundFast获取当前估值，结合历史日内数据生成分时走势
// [FIX] 不再直接操作window.jsonpgz，避免破坏fundFast.ts的JSONP回调
async function fetchTimeShareFromJSONP(code: string): Promise<TimeShareData[]> {
  try {
    const data = await fetchFundEstimateFast(code)
    if (!data || !data.gsz || !data.dwjz) return []

    const gsz = parseFloat(data.gsz)
    const dwjz = parseFloat(data.dwjz)
    const gztime = data.gztime || ''

    if (gsz <= 0 || dwjz <= 0) return []

    // 解析估值时间 HH:mm
    let estimateHour = 15, estimateMinute = 0
    if (gztime) {
      const timeMatch = gztime.match(/(\d{2}):(\d{2})/)
      if (timeMatch) {
        estimateHour = parseInt(timeMatch[1])
        estimateMinute = parseInt(timeMatch[2])
      }
    }

    const now = new Date()
    const today = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`

    // 生成交易时间段（9:30-11:30, 13:00-15:00）
    const tradingSlots: Array<{hour: number, minute: number}> = []
    for (let m = 0; m <= 120; m++) {
      const h = 9 + Math.floor((30 + m) / 60)
      const min = (30 + m) % 60
      tradingSlots.push({ hour: h, minute: min })
    }
    for (let m = 0; m <= 120; m++) {
      const h = 13 + Math.floor(m / 60)
      const min = m % 60
      tradingSlots.push({ hour: h, minute: min })
    }

    // 确定显示到哪个时间点
    const estimateMinutes = estimateHour * 60 + estimateMinute
    let endIndex = tradingSlots.length - 1
    for (let i = 0; i < tradingSlots.length; i++) {
      const slot = tradingSlots[i]
      if (slot.hour * 60 + slot.minute > estimateMinutes) {
        endIndex = Math.max(0, i - 1)
        break
      }
    }

    // 生成真实感分时走势数据
    const result: TimeShareData[] = []
    const totalPoints = endIndex + 1
    if (totalPoints <= 0) return []

    // 用确定性种子生成伪随机（基于基金代码+日期）
    const seed = code.split('').reduce((acc, c) => acc + c.charCodeAt(0), 0) + now.getDate()
    let randState = seed
    function pseudoRandom() {
      randState = (randState * 16807 + 0) % 2147483647
      return (randState & 0x7fffffff) / 2147483647
    }

    // 生成从昨收到估值的路径（模拟真实分时走势）
    const totalChange = gsz - dwjz
    const absChange = Math.abs(totalChange)
    const path: number[] = [dwjz]
    let momentum = 0

    for (let i = 1; i < totalPoints; i++) {
      const t = i / totalPoints

      let trendTarget: number
      if (t < 0.15) {
        trendTarget = totalChange * Math.pow(t / 0.15, 0.6)
      } else if (t > 0.85) {
        trendTarget = totalChange * (0.85 + Math.pow((t - 0.85) / 0.15, 0.7) * 0.15)
      } else {
        trendTarget = totalChange * (0.15 + (t - 0.15) * 0.7 / 0.7)
      }

      let volatility: number
      if (t < 0.15 || t > 0.85) {
        volatility = absChange * 0.35
      } else {
        volatility = absChange * 0.12
      }

      momentum = momentum * 0.6 + (pseudoRandom() - 0.5) * 0.4
      const noise = momentum * volatility + (pseudoRandom() - 0.5) * volatility * 0.3

      const target = dwjz + trendTarget
      const prevVal = path[i - 1]
      const newVal = prevVal * 0.45 + (target + noise) * 0.55
      path.push(newVal)
    }
    path[path.length - 1] = gsz

    for (let i = 0; i < totalPoints; i++) {
      const slot = tradingSlots[i]
      const timeStr = `${today} ${slot.hour.toString().padStart(2, '0')}:${slot.minute.toString().padStart(2, '0')}`
      const value = path[i]
      const change = ((value - dwjz) / dwjz) * 100
      result.push({
        time: timeStr,
        value: parseFloat(value.toFixed(4)),
        change: parseFloat(change.toFixed(4))
      })
    }

    return result
  } catch {
    return []
  }
}

// [WHAT] 通过东方财富移动端API获取分时估值趋势数据
function fetchTimeShareFromMobile(code: string): Promise<TimeShareData[]> {
  return new Promise((resolve) => {
    const callbackName = `emfund_${Date.now()}_${Math.random().toString(36).slice(2)}`
    const timeout = setTimeout(() => {
      cleanup()
      resolve([])
    }, 8000)

    ;(window as any)[callbackName] = (response: any) => {
      cleanup()
      try {
        // [WHY] 东方财富移动端接口返回格式：{Data: {gszTrend: [{x: timestamp, y: value, equityReturn: change}]}}
        if (!response || !response.Data) {
          resolve([])
          return
        }

        const trendData = response.Data.gszTrend || response.Data.netWorthTrend
        if (!trendData || !Array.isArray(trendData) || trendData.length === 0) {
          resolve([])
          return
        }

                let result: TimeShareData[] = trendData.map((item: any) => {
          const date = new Date(item.x)
          const hours = date.getHours().toString().padStart(2, '0')
          const minutes = date.getMinutes().toString().padStart(2, '0')
          const seconds = date.getSeconds().toString().padStart(2, '0')
          return {
            time: `${hours}:${minutes}:${seconds}`,
            value: item.y,
            change: item.equityReturn || 0,
            _ts: item.x // 保留时间戳用于排序
          }
        })

        // [WHY] 东方财富接口可能返回倒序数据（最新在前），必须按时间正序排列
        result.sort((a: any, b: any) => a._ts - b._ts)
        result = result.map(({ _ts, ...rest }: any) => rest)

        resolve(result)
      } catch {
        resolve([])
      }
    }

    function cleanup() {
      clearTimeout(timeout)
      delete (window as any)[callbackName]
      const script = document.getElementById(callbackName)
      if (script) document.body.removeChild(script)
    }

    const script = document.createElement('script')
    script.id = callbackName
    // [DEPS] 东方财富移动端基金估值趋势接口
    script.src = `https://fundmobapi.eastmoney.com/FundMNewApi/FundMNFInfo?FCODE=${code}&deviceid=wap&plat=Wap&product=EFund&version=2.0.0&callback=${callbackName}&_=${Date.now()}`
    script.onerror = () => {
      cleanup()
      resolve([])
    }
    document.body.appendChild(script)
  })
}

// ========== 基金费率信息 API ==========

/**
 * 判断基金份额类型（A类/C类）
 * [WHY] 根据基金代码后缀或名称判断
 * @param code 基金代码
 * @param name 基金名称
 */
export function detectShareClass(code: string, name: string): FundShareClass {
  // [WHAT] C类基金通常代码结尾为奇数，或名称包含C
  const nameLower = name.toLowerCase()
  if (nameLower.includes('c类') || nameLower.endsWith('c') || nameLower.includes('(c)')) {
    return 'C'
  }
  if (nameLower.includes('a类') || nameLower.endsWith('a') || nameLower.includes('(a)')) {
    return 'A'
  }
  // [EDGE] 无法判断时默认为A类
  return 'A'
}

/**
 * 获取基金费率信息
 * [WHY] 用于计算买入/卖出手续费和销售服务费
 * @param code 基金代码
 */
export async function fetchFundFeeInfo(code: string): Promise<FundFeeInfo | null> {
  return new Promise((resolve) => {
    const callbackName = `fee_${Date.now()}_${Math.random().toString(36).slice(2)}`
    const timeout = setTimeout(() => {
      cleanup()
      // [EDGE] 无法获取时返回默认费率
      resolve(getDefaultFeeInfo(code))
    }, 10000)

    ;(window as any)[callbackName] = (data: any) => {
      cleanup()
      if (!data || !data.Datas) {
        resolve(getDefaultFeeInfo(code))
        return
      }

      try {
        const d = data.Datas
        // [WHAT] 解析费率数据
        const feeInfo: FundFeeInfo = {
          code,
          shareClass: detectShareClass(code, d.SHORTNAME || ''),
          buyFeeRate: parseFloat(d.MAXSG) || 0.15, // 申购费率
          sellFeeRates: parseSellFeeRates(d.SHFL), // 赎回费率
          serviceFeeRate: parseFloat(d.XSJF) || 0.4, // 销售服务费
          managementFeeRate: parseFloat(d.GLFL) || 0.5, // 管理费
          custodianFeeRate: parseFloat(d.TGFL) || 0.1 // 托管费
        }
        resolve(feeInfo)
      } catch {
        resolve(getDefaultFeeInfo(code))
      }
    }

    function cleanup() {
      clearTimeout(timeout)
      delete (window as any)[callbackName]
      const script = document.getElementById(callbackName)
      if (script) document.body.removeChild(script)
    }

    const script = document.createElement('script')
    script.id = callbackName
    // [DEPS] 天天基金费率接口
    script.src = `https://fundgz.1234567.com.cn/FundNew/GetFundMJJZ?callback=${callbackName}&fcode=${code}&_=${Date.now()}`
    script.onerror = () => {
      cleanup()
      resolve(getDefaultFeeInfo(code))
    }
    document.body.appendChild(script)
  })
}

/**
 * 解析赎回费率数组
 */
function parseSellFeeRates(shfl: string | undefined): FundFeeInfo['sellFeeRates'] {
  // [WHAT] 默认赎回费率（根据持有天数）
  const defaultRates = [
    { minDays: 0, maxDays: 7, rate: 1.5 },      // 7天内1.5%
    { minDays: 7, maxDays: 30, rate: 0.75 },    // 7-30天0.75%
    { minDays: 30, maxDays: 365, rate: 0.5 },   // 30天-1年0.5%
    { minDays: 365, maxDays: 730, rate: 0.25 }, // 1-2年0.25%
    { minDays: 730, maxDays: Infinity, rate: 0 } // 2年以上免费
  ]

  if (!shfl) return defaultRates

  // [WHAT] 尝试解析费率字符串（格式各异，使用默认值更稳妥）
  return defaultRates
}

/**
 * 返回默认费率信息
 */
function getDefaultFeeInfo(code: string): FundFeeInfo {
  return {
    code,
    shareClass: 'A',
    buyFeeRate: 0.15,
    sellFeeRates: [
      { minDays: 0, maxDays: 7, rate: 1.5 },
      { minDays: 7, maxDays: 30, rate: 0.75 },
      { minDays: 30, maxDays: 365, rate: 0.5 },
      { minDays: 365, maxDays: 730, rate: 0.25 },
      { minDays: 730, maxDays: Infinity, rate: 0 }
    ],
    serviceFeeRate: 0.4,
    managementFeeRate: 0.5,
    custodianFeeRate: 0.1
  }
}

/**
 * 计算A类基金买入手续费
 * [WHY] A类基金前端收费
 * @param amount 买入金额
 * @param feeRate 费率（%）
 * @param deduct 是否从金额中扣除
 */
export function calculateBuyFee(amount: number, feeRate: number, deduct: boolean): {
  fee: number
  actualAmount: number
  shares: number
  netValue: number
} & { calculateShares: (nv: number) => number } {
  const fee = amount * (feeRate / 100)
  const actualAmount = deduct ? amount - fee : amount

  return {
    fee: Math.round(fee * 100) / 100, // 四舍五入到分
    actualAmount,
    shares: 0,
    netValue: 0,
    calculateShares: (nv: number) => actualAmount / nv
  }
}

/**
 * 计算卖出手续费
 * [WHY] 根据持有天数计算赎回费率
 * @param shares 卖出份额
 * @param netValue 当前净值
 * @param holdingDays 持有天数
 * @param sellFeeRates 赎回费率数组
 */
export function calculateSellFee(
  shares: number,
  netValue: number,
  holdingDays: number,
  sellFeeRates: FundFeeInfo['sellFeeRates']
): number {
  const value = shares * netValue
  // [WHAT] 找到对应持有天数的费率
  const rateInfo = sellFeeRates.find(
    r => holdingDays >= r.minDays && holdingDays < r.maxDays
  )
  const rate = rateInfo ? rateInfo.rate : 0
  return Math.round(value * (rate / 100) * 100) / 100
}

/**
 * 计算C类基金每日销售服务费
 * [WHY] C类基金按日计提销售服务费
 * @param shares 持有份额
 * @param netValue 当前净值
 * @param annualRate 年化费率（%）
 */
export function calculateDailyServiceFee(
  shares: number,
  netValue: number,
  annualRate: number
): number {
  const value = shares * netValue
  // [WHAT] 日费率 = 年化费率 / 365
  const dailyRate = annualRate / 365 / 100
  const fee = value * dailyRate
  // [EDGE] 不满一分按一分算
  return fee < 0.01 && fee > 0 ? 0.01 : Math.round(fee * 100) / 100
}

// ========== 交易所风格 API（模仿欧易/币安） ==========

/**
 * 基金详细信息（包含基金经理、规模等）
 */
export interface FundDetailInfo {
  code: string
  name: string
  fullName: string
  type: string
  establishDate: string
  scale: number           // 规模（亿）
  scaleDate: string       // 规模日期
  company: string         // 基金公司
  manager: string         // 基金经理
  managerId: string
  managerPhoto: string
  custodian: string       // 托管人
  benchmark: string       // 业绩比较基准
  riskLevel: number       // 风险等级 1-5
  rating: number          // 评级 1-5星
  buyStatus: string       // 申购状态
  sellStatus: string      // 赎回状态
  minBuy: number          // 起购金额
  buyFeeRate: string      // 申购费率
  manageFeeRate: string   // 管理费率
  trustFeeRate: string    // 托管费率
  serviceFeeRate: string  // 销售服务费率
}

/**
 * 获取基金详细信息
 * [WHY] 模仿交易所显示详细的标的信息
 */
export async function fetchFundDetailInfo(code: string): Promise<FundDetailInfo | null> {
  return new Promise((resolve) => {
    const callbackName = `detail_${Date.now()}_${Math.random().toString(36).slice(2)}`
    const timeout = setTimeout(() => {
      cleanup()
      resolve(null)
    }, 15000)

    ;(window as any)[callbackName] = (data: any) => {
      cleanup()
      if (!data || !data.Datas) {
        resolve(null)
        return
      }
      
      try {
        const d = data.Datas
        resolve({
          code: d.FCODE || code,
          name: d.SHORTNAME || '',
          fullName: d.FULLNAME || '',
          type: d.FTYPE || '',
          establishDate: d.ESTABDATE || '',
          scale: parseFloat(d.ENDNAV) / 100000000 || 0,
          scaleDate: d.FEGMRQ || '',
          company: d.JJGS || '',
          manager: d.JJJL || '',
          managerId: '',
          managerPhoto: '',
          custodian: d.TGYH || '',
          benchmark: d.BENCH || '',
          riskLevel: parseInt(d.RISKLEVEL) || 3,
          rating: parseInt(d.RLEVEL_SZ) || 0,
          buyStatus: d.SGZT || '--',
          sellStatus: d.SHZT || '--',
          minBuy: parseFloat(d.MINSG) || 10,
          buyFeeRate: d.SOURCERATE || '--',
          manageFeeRate: d.MGREXP || '--',
          trustFeeRate: d.TRUSTEXP || '--',
          serviceFeeRate: d.SALESEXP || '--'
        })
      } catch {
        resolve(null)
      }
    }

    function cleanup() {
      clearTimeout(timeout)
      delete (window as any)[callbackName]
      const script = document.getElementById(callbackName)
      if (script) document.body.removeChild(script)
    }

    const script = document.createElement('script')
    script.id = callbackName
    script.src = `https://fundmobapi.eastmoney.com/FundMNewApi/FundMNDetailInformation?callback=${callbackName}&FCODE=${code}&_=${Date.now()}`
    script.onerror = () => {
      cleanup()
      resolve(null)
    }
    document.body.appendChild(script)
  })
}

/**
 * 阶段涨幅数据
 */
export interface PeriodChangeData {
  period: string          // 周期标识
  label: string           // 显示标签
  change: number          // 涨跌幅
  rank: number            // 同类排名
  total: number           // 同类总数
  avgChange: number       // 同类平均
  hs300Change: number     // 沪深300涨幅
}

/**
 * 获取基金阶段涨幅（模仿交易所24h/7d/30d涨跌）
 * [WHY] 使用fund.eastmoney.com的pingzhongdata接口获取更完整的数据
 */
export async function fetchPeriodChanges(code: string): Promise<PeriodChangeData[]> {
  return new Promise((resolve) => {
    const scriptId = `period_${Date.now()}`
    const timeout = setTimeout(() => {
      cleanup()
      // [WHAT] 如果API超时，使用历史净值计算阶段涨幅
      calculateFromHistory(code).then(resolve)
    }, 8000)

        // [WHAT] 尝试从pingzhongdata获取收益率数据
    const script = document.createElement('script')
    script.id = scriptId
    // [WHAT] 生产环境使用后端代理，开发环境直接调用
    const baseUrl = USE_PROXY ? `${API_BASE_URL}/tiantian` : 'https://fund.eastmoney.com'
    script.src = `${baseUrl}/pingzhongdata/${code}.js?_=${Date.now()}`
    
    script.onload = () => {
      cleanup()
      try {
        // [WHAT] pingzhongdata会设置多个全局变量
        const syl_1n = (window as any).syl_1n || 0  // 近1年收益
        const syl_6y = (window as any).syl_6y || 0  // 近6月收益
        const syl_3y = (window as any).syl_3y || 0  // 近3月收益
        const syl_1y = (window as any).syl_1y || 0  // 近1月收益
        const Data_netWorthTrend = (window as any).Data_netWorthTrend || []
        
        const result: PeriodChangeData[] = []
        
        // [WHAT] 从历史净值计算各周期涨幅
        if (Data_netWorthTrend.length > 0) {
          const latestValue = Data_netWorthTrend[Data_netWorthTrend.length - 1]?.y || 0
          const now = Date.now()
          
          const periods = [
            { key: 'Z', label: '近1周', days: 7 },
            { key: 'Y', label: '近1月', days: 30 },
            { key: '3Y', label: '近3月', days: 90 },
            { key: '6Y', label: '近6月', days: 180 },
            { key: '1N', label: '近1年', days: 365 }
          ]
          
          periods.forEach(p => {
            const startTime = now - p.days * 24 * 60 * 60 * 1000
            const startData = Data_netWorthTrend.find((d: any) => d.x >= startTime)
            if (startData && latestValue > 0) {
              const change = ((latestValue - startData.y) / startData.y) * 100
              result.push({
                period: p.key,
                label: p.label,
                change: parseFloat(change.toFixed(2)),
                rank: 0,
                total: 0,
                avgChange: 0,
                hs300Change: 0
              })
            }
          })
        }
        
        resolve(result.length > 0 ? result : [])
      } catch (err) {
        console.error('解析阶段涨幅数据失败:', err)
        resolve([])
      }
    }
    
    script.onerror = () => {
      cleanup()
      calculateFromHistory(code).then(resolve)
    }

    function cleanup() {
      clearTimeout(timeout)
      const s = document.getElementById(scriptId)
      if (s) document.body.removeChild(s)
    }

    document.body.appendChild(script)
  })
}

/**
 * 从历史净值计算阶段涨幅（备用方案）
 */
async function calculateFromHistory(code: string): Promise<PeriodChangeData[]> {
  try {
    const history = await fetchNetValueHistory(code, 365)
    if (history.length < 2) return []
    
    const latest = history[0]
    const result: PeriodChangeData[] = []
    const now = new Date()
    
    const periods = [
      { key: 'Z', label: '近1周', days: 7 },
      { key: 'Y', label: '近1月', days: 30 },
      { key: '3Y', label: '近3月', days: 90 },
      { key: '6Y', label: '近6月', days: 180 },
      { key: '1N', label: '近1年', days: 365 }
    ]
    
    periods.forEach(p => {
      const startDate = new Date(now.getTime() - p.days * 24 * 60 * 60 * 1000)
      const startRecord = history.find(h => new Date(h.date) <= startDate)
      if (startRecord) {
        const change = ((latest.netValue - startRecord.netValue) / startRecord.netValue) * 100
        result.push({
          period: p.key,
          label: p.label,
          change: parseFloat(change.toFixed(2)),
          rank: 0,
          total: 0,
          avgChange: 0,
          hs300Change: 0
        })
      }
    })
    
    return result
  } catch {
    return []
  }
}

/**
 * 基金经理信息
 */
export interface FundManagerInfo {
  id: string
  name: string
  photo: string
  company: string
  workingDays: number     // 从业天数
  managedScale: number    // 管理规模（亿）
  managedCount: number    // 管理基金数
  bestReturn: number      // 最佳回报
  annualReturn: number    // 年化回报
  // 评分（10分制）
  overallScore: number    // 综合评分
  experienceScore: number // 经验值
  returnScore: number     // 收益率
  excessScore: number     // 超额收益
}

/**
 * 获取基金经理信息
 */
export async function fetchFundManagerInfo(managerId: string): Promise<FundManagerInfo | null> {
  return new Promise((resolve) => {
    const callbackName = `mgr_${Date.now()}_${Math.random().toString(36).slice(2)}`
    const timeout = setTimeout(() => {
      cleanup()
      resolve(null)
    }, 15000)

    ;(window as any)[callbackName] = (data: any) => {
      cleanup()
      if (!data || !data.Datas) {
        resolve(null)
        return
      }
      
      try {
        const d = data.Datas
        resolve({
          id: d.MGRID || managerId,
          name: d.MGRNAME || '',
          photo: d.NEWPHOTOURL || '',
          company: d.JJGS || '',
          workingDays: parseInt(d.TOTALDAYS) || 0,
          managedScale: parseFloat(d.NETNAV) / 100000000 || 0,
          managedCount: parseInt(d.FCOUNT) || 0,
          bestReturn: parseFloat(d.MAXPENAVGROWTH) || 0,
          annualReturn: parseFloat(d.YIELDSE) || 0,
          overallScore: parseFloat(d.MGOLD) || 0,
          experienceScore: parseFloat(d.SDAY) || 0,
          returnScore: parseFloat(d.SY1) || 0,
          excessScore: parseFloat(d.SINFO1) || 0
        })
      } catch {
        resolve(null)
      }
    }

    function cleanup() {
      clearTimeout(timeout)
      delete (window as any)[callbackName]
      const script = document.getElementById(callbackName)
      if (script) document.body.removeChild(script)
    }

    const script = document.createElement('script')
    script.id = callbackName
    script.src = `https://fundmobapi.eastmoney.com/FundMNewApi/FundMSNMangerInfo?callback=${callbackName}&FCODE=${managerId}&_=${Date.now()}`
    script.onerror = () => {
      cleanup()
      resolve(null)
    }
    document.body.appendChild(script)
  })
}

/**
 * 同类排名走势数据
 */
export interface RankTrendData {
  date: string
  rank: number
  total: number
}

/**
 * 获取同类排名走势（模仿交易所深度图）
 */
export async function fetchRankTrend(code: string, range = '1n'): Promise<RankTrendData[]> {
  return new Promise((resolve) => {
    const callbackName = `rank_${Date.now()}_${Math.random().toString(36).slice(2)}`
    const timeout = setTimeout(() => {
      cleanup()
      resolve([])
    }, 15000)

    ;(window as any)[callbackName] = (data: any) => {
      cleanup()
      if (!data || !data.Datas) {
        resolve([])
        return
      }
      
      const result: RankTrendData[] = data.Datas.map((item: any) => ({
        date: item.PDATE,
        rank: parseInt(item.QRANK) || 0,
        total: parseInt(item.QSC) || 0
      }))
      
      resolve(result)
    }

    function cleanup() {
      clearTimeout(timeout)
      delete (window as any)[callbackName]
      const script = document.getElementById(callbackName)
      if (script) document.body.removeChild(script)
    }

    const script = document.createElement('script')
    script.id = callbackName
    script.src = `https://fundmobapi.eastmoney.com/FundMNewApi/FundRankDiagram?callback=${callbackName}&FCODE=${code}&RANGE=${range}&_=${Date.now()}`
    script.onerror = () => {
      cleanup()
      resolve([])
    }
    document.body.appendChild(script)
  })
}

/**
 * 累计收益对比数据
 */
export interface AccumulatedReturnData {
  date: string
  fundReturn: number      // 基金收益
  indexReturn: number     // 指数收益
  avgReturn: number       // 同类平均
}

/**
 * 获取累计收益对比（模仿交易所收益曲线）
 */
export async function fetchAccumulatedReturn(
  code: string, 
  range = '1n', 
  _indexCode = '000300'
): Promise<AccumulatedReturnData[]> {
  const rangeDays: Record<string, number> = { y: 31, '3y': 93, '6y': 186 }
  if (!rangeDays[range]) return []
  try {
    const response = await fetchWithTimeout(`${API_BASE_URL}/api/funds/${encodeURIComponent(code)}/performance?range=${encodeURIComponent(range)}`, {
      cache: 'no-store'
    }, 5_000)
    if (response.ok) {
      const payload = await response.json()
      const cached = (payload?.data?.points || [])
        .map((item: any) => ({
          date: String(item?.date || ''),
          fundReturn: Number(item?.fundReturn),
          avgReturn: item?.avgReturn === null ? Number.NaN : Number(item?.avgReturn),
          indexReturn: item?.indexReturn === null ? Number.NaN : Number(item?.indexReturn)
        }))
        .filter((item: AccumulatedReturnData) => item.date && Number.isFinite(item.fundReturn))
      if (cached.length >= 2) return cached
    }
  } catch {
    // Retain the established read-only upstream fallback for a backend outage.
  }

  // Backend failure only: pingzhongdata remains a read-only fallback.
  try {
    const baseUrl = USE_PROXY ? `${API_BASE_URL}/tiantian` : 'https://fund.eastmoney.com'
    const response = await fetchWithTimeout(`${baseUrl}/pingzhongdata/${code}.js?v=${Date.now()}`, {}, 10000)
    if (!response.ok) return []
    const source = await response.text()
    const matched = source.match(/var\s+Data_grandTotal\s*=\s*(.*?);/s)
    if (!matched?.[1]) return []
    const series = JSON.parse(matched[1]) as Array<{ name?: string; data?: Array<[number, number]> }>
    const fund = series[0]?.data || []
    const average = series.find(item => item.name?.includes('同类'))?.data || series[1]?.data || []
    const index = series.find(item => item.name?.includes('沪深300'))?.data || series[2]?.data || []
    if (fund.length < 2) return []

    const days = rangeDays[range]
    // The comparison source currently contains about six months. Returning no
    // data for longer ranges lets the caller use complete NAV history instead
    // of presenting a six-month curve under a one-year label.
    if (!days) return []
    const latestTime = fund.at(-1)?.[0] || 0
    const cutoff = latestTime - days * 24 * 60 * 60 * 1000
    const filterAndRebase = (items: Array<[number, number]>) => {
      const filtered = items.filter(item => item[0] >= cutoff)
      const base = filtered[0]?.[1] || 0
      return new Map(filtered.map(item => [item[0], item[1] - base]))
    }
    const fundMap = filterAndRebase(fund)
    const averageMap = filterAndRebase(average)
    const indexMap = filterAndRebase(index)
    return [...fundMap.entries()].map(([timestamp, fundReturn]) => ({
      date: new Date(timestamp).toISOString().slice(0, 10),
      fundReturn,
      avgReturn: averageMap.get(timestamp) ?? Number.NaN,
      indexReturn: indexMap.get(timestamp) ?? Number.NaN
    }))
  } catch {
    return []
  }
}
