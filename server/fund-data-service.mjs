import {
  fetchFundEstimates,
  fetchOverseasSecurityProfile,
  fetchStockQuotes,
  fetchUpstream,
  getBeijingMarketState,
  getFundEstimateMarketState,
  getCache,
  getFundList,
  getFundSnapshot,
  loadFromFile,
  saveToFile,
  setCache
} from './cache.mjs'
import {
  getStoredFundHoldings,
  getStoredFundHistory,
  holdingChangeType,
  storeFundHistory
} from './market-database.mjs'

const DEFAULT_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
  'Referer': 'https://fund.eastmoney.com/',
  'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8'
}
const HISTORY_CACHE_FILE = 'fund-history-cache.json'
const HOLDINGS_CACHE_FILE = 'fund-holdings-cache.json'
const ESTIMATE_CACHE_FILE = 'fund-estimate-cache.json'
const MAX_PERSISTED_FUNDS = 500
const ESTIMATE_PERSIST_INTERVAL_MS = 60 * 1000
const LINKED_ETF_FALLBACKS = Object.freeze({
  // Eastmoney's link-fund F10 is empty for this fund even though the target
  // ETF publishes a complete portfolio. Keep the verified target explicit.
  '017472': '159667'
})
const OVERSEAS_NAME_MARKETS = Object.freeze([
  {
    marketPrefix: 'kr',
    pattern: /三星|海力士|现代汽车|现代摩比斯|起亚|LG(?:电子|新能源|化学|显示)|浦项|NAVER|Kakao|韩华|斗山|三星SDI|三星生物/i
  },
  {
    marketPrefix: 'jp',
    pattern: /KIOXIA|索尼|任天堂|丰田|本田|三菱|三井|软银|东京电子|信越|日立|爱德万|迅销|KEYENCE|松下|住友/i
  }
])
let historyFileCache = null
let holdingsFileCache = null
let estimateFileCache = null
let fundListIndex = null
let indexedFundList = null

function numberOrNull(value) {
  const parsed = Number.parseFloat(String(value ?? '').replaceAll(',', '').replace('%', ''))
  return Number.isFinite(parsed) ? parsed : null
}

function normalizeSecurityName(value) {
  return String(value || '')
    .toUpperCase()
    .replace(/[\s\-_.()（）,，*]/g, '')
    .replace(/股份有限公司|有限公司|集团|公司/g, '')
}

function isSameSecurityName(left, right) {
  const a = normalizeSecurityName(left)
  const b = normalizeSecurityName(right)
  return Boolean(a && b && (a === b || a.includes(b) || b.includes(a)))
}

function overseasMarketCandidates(holding) {
  if (String(holding?.marketPrefix || '') !== '0') return []
  const symbol = String(holding?.stockCode || '').trim()
  const name = String(holding?.stockName || '').trim()
  if (!symbol) return []
  const candidates = OVERSEAS_NAME_MARKETS
    .filter(candidate => candidate.pattern.test(name))
    .map(candidate => candidate.marketPrefix)
  // Eastmoney's domestic F10 route cannot represent alphabetic Tokyo symbols.
  if (!/^\d{6}$/.test(symbol) && !candidates.includes('jp')) candidates.push('jp')
  return [...new Set(candidates)]
}

export function selectVerifiedOverseasMarket(holding, domesticQuote, profiles) {
  const candidates = overseasMarketCandidates(holding)
  if (!candidates.length || isSameSecurityName(holding?.stockName, domesticQuote?.name)) return holding
  const profile = (profiles || []).find(item => item && candidates.includes(item.marketPrefix))
  return profile ? { ...holding, marketPrefix: profile.marketPrefix, marketSource: profile.marketSource } : holding
}

export async function resolveOverseasHoldingMarkets(holdings) {
  const candidates = (holdings || []).filter(holding => overseasMarketCandidates(holding).length)
  if (!candidates.length) return holdings || []

  const domesticSecids = [...new Set(candidates
    .filter(holding => /^\d{6}$/.test(String(holding.stockCode || '')))
    .map(holding => `0.${holding.stockCode}`))]
  const domesticQuotes = domesticSecids.length ? await fetchStockQuotes(domesticSecids).catch(() => ({})) : {}
  const profilesBySecurity = new Map(await Promise.all(candidates.map(async holding => {
    const markets = overseasMarketCandidates(holding)
    const profiles = await Promise.all(markets.map(async marketPrefix => {
      const profile = await fetchOverseasSecurityProfile(`${marketPrefix}.${holding.stockCode}`)
      return profile ? {
        ...profile,
        marketPrefix,
        marketSource: marketPrefix === 'kr' ? 'naver_finance' : 'yahoo_japan_finance'
      } : null
    }))
    return [`${holding.marketPrefix}.${holding.stockCode}`, profiles]
  })))

  return (holdings || []).map(holding => selectVerifiedOverseasMarket(
    holding,
    domesticQuotes[String(holding.stockCode || '')],
    profilesBySecurity.get(`${holding.marketPrefix}.${holding.stockCode}`)
  ))
}

async function resolveSnapshotMarkets(snapshot) {
  if (!snapshot?.holdings?.length) return snapshot
  return { ...snapshot, holdings: await resolveOverseasHoldingMarkets(snapshot.holdings) }
}

function previousWeekdayDate(value) {
  const date = new Date(`${value}T12:00:00Z`)
  if (Number.isNaN(date.getTime())) return ''
  do date.setUTCDate(date.getUTCDate() - 1)
  while (date.getUTCDay() === 0 || date.getUTCDay() === 6)
  return date.toISOString().slice(0, 10)
}

export function getEligibleEstimateMarketDate(market) {
  if (!market?.date) return ''
  if (market.market === 'cn') return market.date
  if (market.market !== 'hk' && market.market !== 'us') return market.date
  const beforeOpen = market.isWeekday && Number(market.minutes) < 9 * 60 + 30
  return !market.isWeekday || beforeOpen ? previousWeekdayDate(market.date) : market.date
}

export function isEstimateEligibleForMarket(estimate, market) {
  if (!estimate || !market) return false
  const estimateDate = String(estimate.marketDate || estimate.baseDate || estimate.gztime || '')
    .split(' ')[0]
    .replaceAll('/', '-')
  return Boolean(estimateDate) && estimateDate === getEligibleEstimateMarketDate(market)
}

export function isEstimateSessionActive(market) {
  if (market?.market !== 'cn') return Boolean(market?.isOpen)
  return Boolean(
    market.isEstimateSession ||
    (market.isWeekday && market.isAfterClose && market.minutes < 20 * 60)
  )
}

function isSameMarketDate(value, marketDate) {
  return String(value || '').replaceAll('/', '-') === marketDate
}

function codeIsValid(code) {
  return /^\d{6}$/.test(code)
}

function getFundListEntry(code) {
  const list = getFundList() || []
  if (list !== indexedFundList) {
    indexedFundList = list
    fundListIndex = new Map(list.map(fund => [fund.code, fund]))
  }
  return fundListIndex?.get(code) || null
}

function loadPersistentCache(filename, current) {
  if (current) return current
  const stored = loadFromFile(filename)
  return stored?.entries && typeof stored.entries === 'object' ? stored : { entries: {} }
}

function updatePersistentCache(filename, cache, code, data) {
  cache.entries[code] = { updatedAt: new Date().toISOString(), data }
  const entries = Object.entries(cache.entries)
    .sort((a, b) => Date.parse(b[1].updatedAt) - Date.parse(a[1].updatedAt))
    .slice(0, MAX_PERSISTED_FUNDS)
  cache.entries = Object.fromEntries(entries)
  saveToFile(filename, cache)
}

function getPersistentEntry(cache, code) {
  const entry = cache.entries?.[code]
  if (!entry?.data || !entry.updatedAt) return null
  return { ...entry.data, cachedAt: entry.updatedAt }
}

function persistFundEstimate(code, estimate, market) {
  if (!estimate || estimate.source === 'market_snapshot' || numberOrNull(estimate.gszzl) === null) return
  estimateFileCache = loadPersistentCache(ESTIMATE_CACHE_FILE, estimateFileCache)
  const existing = estimateFileCache.entries?.[code]
  const recentlyPersisted = existing?.updatedAt && Date.now() - Date.parse(existing.updatedAt) < ESTIMATE_PERSIST_INTERVAL_MS
  if (recentlyPersisted && existing.data?.source === estimate.source && existing.data?.marketDate === market?.date) return
  updatePersistentCache(ESTIMATE_CACHE_FILE, estimateFileCache, code, {
    ...estimate,
    market: market?.market || 'cn',
    marketDate: estimate.marketDate || market?.date || ''
  })
}

function getPersistedFundEstimate(code, market) {
  estimateFileCache = loadPersistentCache(ESTIMATE_CACHE_FILE, estimateFileCache)
  const persisted = getPersistentEntry(estimateFileCache, code)
  if (!persisted || persisted.market !== market?.market || !isEstimateEligibleForMarket(persisted, market)) return null
  return {
    ...persisted,
    realtime: Boolean(market?.isOpen),
    stale: Boolean(market?.isOpen),
    frozen: !market?.isOpen,
    cache: 'disk'
  }
}

export function classifyFund(fund = {}) {
  const name = fund.name || ''
  const type = fund.type || ''
  const text = `${name} ${type}`.toUpperCase()

  if (text.includes('货币')) {
    return { valuationType: 'not_supported', confidence: 1, confidenceNote: '货币基金展示实际单位净值、万份收益和七日年化，不生成盘中估值' }
  }
  if ((text.includes('ETF') && !text.includes('联接')) || text.includes('LOF')) {
    return { valuationType: 'real_time_price', confidence: 1, confidenceNote: '场内基金优先采用交易所实时价格' }
  }
  if (text.includes('QDII')) {
    return { valuationType: 'hybrid_qdii', confidence: 0.7, confidenceNote: 'QDII 受海外市场时差影响，采用公开估值并保留实际净值降级' }
  }
  if (text.includes('指数') || text.includes('ETF联接') || text.includes('联接')) {
    return { valuationType: 'index_based', confidence: 0.85, confidenceNote: '指数及联接基金优先采用公开指数估值' }
  }
  if (text.includes('偏债') || text.includes('二级债') || text.includes('混合债')) {
    return { valuationType: 'hybrid_bond', confidence: 0.7, confidenceNote: '偏债产品需要债券与股票持仓混合估值' }
  }
  if (text.includes('股票') || text.includes('混合')) {
    return { valuationType: 'holdings_based', confidence: 0.65, confidenceNote: '主动基金可使用公开估值，并以重仓持股覆盖率评估置信度' }
  }
  return { valuationType: 'benchmark_only', confidence: 0.3, confidenceNote: '缺少明确跟踪标的时仅提供公开估值或最新实际净值' }
}

export function getFundProfile(code) {
  const listEntry = getFundListEntry(code)
  const snapshot = getFundSnapshot(code)
  if (!listEntry && !snapshot) return null
  const base = {
    code,
    name: snapshot?.name || listEntry?.name || '',
    type: snapshot?.type || listEntry?.type || '',
    pinyin: listEntry?.pinyin || '',
    fullPinyin: listEntry?.fullPinyin || '',
    snapshot
  }
  return { ...base, ...classifyFund(base) }
}

export function parseFundHistoryPayload(payload, code) {
  const items = payload?.Data?.LSJZList
  if (!Array.isArray(items)) return []
  return items.map(item => ({
    code,
    date: String(item.FSRQ || '').replaceAll('/', '-'),
    nav: numberOrNull(item.DWJZ),
    accumulatedNav: numberOrNull(item.LJJZ),
    changePercent: numberOrNull(item.JZZZL),
    purchaseStatus: item.SGZT || '',
    redemptionStatus: item.SHZT || '',
    dividend: item.FHFCZ || item.FHFCBZ || null,
    navType: item.NAVTYPE || null
  })).filter(item => item.date && item.nav !== null)
}

function historyTtlMs() {
  const market = getBeijingMarketState()
  if (market.isOpen) return 30 * 60 * 1000
  if (market.isWeekday && market.minutes >= 15 * 60 && market.minutes < 23 * 60) return 2 * 60 * 1000
  return 6 * 60 * 60 * 1000
}

export async function getFundHistory(code, limit = 30) {
  if (!codeIsValid(code)) throw new Error('基金代码必须是6位数字')
  const boundedLimit = Math.max(1, Math.min(Number(limit) || 30, 500))
  const cacheKey = `fund:history:${code}:${boundedLimit}`
  const cached = getCache(cacheKey)
  if (cached) return cached

  historyFileCache = loadPersistentCache(HISTORY_CACHE_FILE, historyFileCache)
  const persisted = getPersistentEntry(historyFileCache, code)
  const ttl = historyTtlMs()
  const database = await getStoredFundHistory(code)
  if (database?.items?.length >= Math.min(boundedLimit, 5) && Date.now() - Date.parse(database.cachedAt) < ttl) {
    const result = { ...database, items: database.items.slice(0, boundedLimit), cache: 'database', stale: false }
    setCache(cacheKey, result, ttl)
    return result
  }
  if (persisted && Date.now() - Date.parse(persisted.cachedAt) < ttl && persisted.items?.length >= Math.min(boundedLimit, 5)) {
    const result = { ...persisted, items: persisted.items.slice(0, boundedLimit), cache: 'disk', stale: false }
    // Promote an existing durable file cache on the first request so history
    // charts gain the same database-first path without waiting for its TTL.
    void storeFundHistory(code, persisted).catch(() => false)
    setCache(cacheKey, result, ttl)
    return result
  }

  try {
    const response = await fetchUpstream(`https://api.fund.eastmoney.com/f10/lsjz?fundCode=${code}&pageIndex=1&pageSize=${boundedLimit}`, {
      headers: { ...DEFAULT_HEADERS, 'Accept': 'application/json' },
      timeoutMs: 8_000,
      retries: 2,
      dedupeKey: `fund:history:${code}:${boundedLimit}`
    })
    const payload = await response.json()
    const items = parseFundHistoryPayload(payload, code)
    if (items.length === 0) throw new Error('历史净值为空')
    const result = {
      code,
      name: getFundProfile(code)?.name || '',
      fundType: payload?.Data?.FundType || getFundProfile(code)?.type || '',
      source: 'eastmoney_lsjz',
      updatedAt: new Date().toISOString(),
      stale: false,
      items
    }
    updatePersistentCache(HISTORY_CACHE_FILE, historyFileCache, code, result)
    await storeFundHistory(code, result).catch(() => false)
    setCache(cacheKey, result, ttl)
    return result
  } catch (error) {
    if (database?.items?.length) {
      return { ...database, items: database.items.slice(0, boundedLimit), cache: 'stale_database', stale: true, error: error.message }
    }
    if (persisted?.items?.length) {
      return { ...persisted, items: persisted.items.slice(0, boundedLimit), cache: 'stale_disk', stale: true, error: error.message }
    }
    throw error
  }
}

function decodeHtml(value) {
  return String(value || '')
    .replace(/<[^>]+>/g, '')
    .replaceAll('&nbsp;', ' ')
    .replaceAll('&amp;', '&')
    .replaceAll('&lt;', '<')
    .replaceAll('&gt;', '>')
    .trim()
}

export function parseFundHoldingsHtml(source, code) {
  const reportDate = source.match(/截止至：\s*<font[^>]*>(\d{4}-\d{2}-\d{2})<\/font>/i)?.[1] || null
  const fundName = decodeHtml(source.match(/<a[^>]*title=['"]([^'"]+)['"][^>]*>/i)?.[1] || '')
  const currentTable = source.match(/<table[^>]*class=['"][^'"]*tzxq[^'"]*['"][^>]*>[\s\S]*?<\/table>/i)?.[0] || source
  const rows = currentTable.match(/<tr[^>]*>[\s\S]*?<\/tr>/gi) || []
  const holdings = []

  for (const row of rows) {
    if (/<th/i.test(row)) continue
    const cells = [...row.matchAll(/<td[^>]*>([\s\S]*?)<\/td>/gi)].map(match => match[1])
    if (cells.length < 7) continue
    const marketMatch = row.match(/quote\.eastmoney\.com\/unify\/r\/(\d+)\.([A-Z0-9.-]+)/i)
    const stockCode = marketMatch?.[2] || decodeHtml(cells[1]).match(/[A-Z0-9.-]{2,}/i)?.[0] || ''
    const stockName = decodeHtml(cells[2])
    // F10 uses different column counts for the latest and historical tables.
    // The last percentage is always the portfolio weight, after the daily quote.
    const holdingRatio = numberOrNull([...cells]
      .map(cell => decodeHtml(cell))
      .reverse()
      .find(cell => /-?\d+(?:\.\d+)?%$/.test(cell)))
    if (!stockCode || !stockName || holdingRatio === null || holdingRatio <= 0) continue
    holdings.push({
      fundCode: code,
      stockCode,
      stockName,
      marketPrefix: marketMatch?.[1] || (stockCode.startsWith('6') ? '1' : '0'),
      holdingRatio,
      holdingShares: numberOrNull(decodeHtml(cells[cells.length - 2])),
      holdingMarketValue: numberOrNull(decodeHtml(cells[cells.length - 1])),
      reportDate
    })
  }

  // The upstream page occasionally repeats one security within the same report.
  // A fund/report can only have one position per market-qualified security.
  const uniqueHoldings = new Map()
  for (const holding of holdings) {
    const key = `${holding.marketPrefix}.${holding.stockCode}`
    const current = uniqueHoldings.get(key)
    if (!current || holding.holdingRatio > current.holdingRatio) uniqueHoldings.set(key, holding)
  }

  return {
    fundName,
    reportDate,
    holdings: [...uniqueHoldings.values()].sort((a, b) => b.holdingRatio - a.holdingRatio).slice(0, 10)
  }
}

export function parseFundHoldingPeriodsHtml(source, code) {
  const tables = [...source.matchAll(/<table[^>]*class=['"][^'"]*tzxq[^'"]*['"][^>]*>[\s\S]*?<\/table>/gi)]
  const fundName = decodeHtml(source.match(/<a[^>]*title=['"]([^'"]+)['"][^>]*>/i)?.[1] || '')
  const periods = []
  for (const table of tables) {
    const prefix = source.slice(Math.max(0, table.index - 500), table.index)
    const dates = [...prefix.matchAll(/\d{4}-\d{2}-\d{2}/g)]
    const reportDate = dates.at(-1)?.[0] || null
    if (!reportDate || periods.some(period => period.reportDate === reportDate)) continue
    const parsed = parseFundHoldingsHtml(table[0], code)
    periods.push({
      ...parsed,
      fundName: fundName || parsed.fundName,
      reportDate,
      holdings: parsed.holdings.map(holding => ({ ...holding, reportDate }))
    })
  }
  return periods.sort((left, right) => right.reportDate.localeCompare(left.reportDate))
}

export function previousQuarter(reportDate) {
  const match = String(reportDate || '').match(/^(\d{4})-(\d{2})-/)
  if (!match) return null
  const year = Number(match[1])
  const month = Number(match[2])
  const previousMonth = month === 3 ? 12 : month - 3
  return { year: month === 3 ? year - 1 : year, month: previousMonth }
}

export async function fetchF10Holdings(code, year = '', month = '') {
  const response = await fetchUpstream(`https://fundf10.eastmoney.com/FundArchivesDatas.aspx?type=jjcc&code=${code}&topline=10&year=${year}&month=${month}`, {
    headers: DEFAULT_HEADERS, timeoutMs: 10_000, retries: 2, dedupeKey: `fund:holdings:${code}:${year}:${month}`
  })
  return parseFundHoldingsHtml(await response.text(), code)
}

export async function fetchF10HoldingPeriods(code, year = '') {
  const response = await fetchUpstream(`https://fundf10.eastmoney.com/FundArchivesDatas.aspx?type=jjcc&code=${code}&topline=10&year=${year}&month=`, {
    headers: DEFAULT_HEADERS,
    timeoutMs: 10_000,
    retries: 2,
    dedupeKey: `fund:holding-periods:${code}:${year}`
  })
  return parseFundHoldingPeriodsHtml(await response.text(), code)
}

async function resolveLinkedEtfHoldings(code, fundName) {
  if (!/ETF.*联接|联接.*ETF/.test(fundName || '')) return null
  const profile = await fetchUpstream(`https://fundf10.eastmoney.com/jbgk_${code}.html`, { headers: DEFAULT_HEADERS, timeoutMs: 8_000, retries: 1 })
  const html = await profile.text()
  const target = decodeHtml(html.match(/跟踪标的<\/th>\s*<td[^>]*>([^<]+)/i)?.[1]
    || fundName.match(/(中证[^E（(]+)(?=ETF)/)?.[1]
    || '')
  if (!target) return null
  const response = await fetchUpstream(`https://searchapi.eastmoney.com/api/suggest/get?input=${encodeURIComponent(target)}&count=20&type=14`, { headers: DEFAULT_HEADERS, timeoutMs: 8_000, retries: 1 })
  const candidates = (await response.json())?.QuotationCodeTable?.Data || []
  const managerHint = (fundName.match(/^[\u4e00-\u9fa5]{2}/)?.[0] || '')
  const candidate = candidates.find(item => /^\d{6}$/.test(String(item.Code)) && String(item.Code) !== code && String(item.Name || '').includes(managerHint))
    || candidates.find(item => /^\d{6}$/.test(String(item.Code)) && String(item.Code) !== code)
  if (!candidate) return null
  const parsed = await fetchF10Holdings(String(candidate.Code))
  return parsed.holdings.length ? { ...parsed, targetCode: String(candidate.Code), targetName: String(candidate.Name || '') } : null
}

export async function fetchFundHoldingSnapshotsFromUpstream(code) {
  if (!codeIsValid(code)) throw new Error('Fund code must contain six digits')
  const profile = getFundProfile(code)
  let parsed = await fetchF10Holdings(code)
  let linked = null
  if (parsed.holdings.length === 0) {
    linked = await resolveLinkedEtfHoldings(code, profile?.name || '').catch(() => null)
  }
  if (!linked && LINKED_ETF_FALLBACKS[code]) {
    const targetCode = LINKED_ETF_FALLBACKS[code]
    const target = await fetchF10Holdings(targetCode)
    linked = target.holdings.length
      ? { ...target, targetCode, targetName: target.fundName || '' }
      : null
  }
  if (linked) parsed = linked
  parsed = await resolveSnapshotMarkets(parsed)

  const source = linked ? 'eastmoney_f10_linked_etf' : 'eastmoney_f10'
  const sourceCode = linked?.targetCode || code
  const currentYear = String(parsed.reportDate || '').slice(0, 4)
  const currentYearPeriods = currentYear
    ? await fetchF10HoldingPeriods(sourceCode, currentYear).catch(() => [])
    : []
  const resolvedCurrentYearPeriods = await Promise.all(currentYearPeriods.map(resolveSnapshotMarkets))
  let previous = resolvedCurrentYearPeriods.find(period => period.reportDate < parsed.reportDate) || null
  if (!previous && currentYear) {
    const priorYear = String(Number(currentYear) - 1)
    previous = await resolveSnapshotMarkets((await fetchF10HoldingPeriods(sourceCode, priorYear).catch(() => []))[0] || null)
  }
  previous ||= { holdings: [], reportDate: null }
  const comparablePrevious = previous.reportDate && previous.reportDate !== parsed.reportDate
    ? previous
    : { holdings: [], reportDate: null }
  const priorBySecurity = new Map(comparablePrevious.holdings.map(item => [
    `${item.marketPrefix}.${item.stockCode}`,
    item.holdingRatio
  ]))
  const hasPrevious = Boolean(comparablePrevious.reportDate)
  const holdings = parsed.holdings.map(item => {
    const key = `${item.marketPrefix}.${item.stockCode}`
    const existedPreviously = priorBySecurity.has(key)
    const quarterChange = hasPrevious
      ? Number((item.holdingRatio - (priorBySecurity.get(key) || 0)).toFixed(2))
      : null
    return {
      ...item,
      quarterChange,
      changeType: holdingChangeType(quarterChange, hasPrevious, existedPreviously)
    }
  })

  const current = {
    code,
    name: profile?.name || parsed.fundName || '',
    reportDate: parsed.reportDate,
    previousReportDate: comparablePrevious.reportDate,
    source,
    targetCode: linked?.targetCode || null,
    targetName: linked?.targetName || null,
    updatedAt: new Date().toISOString(),
    stale: false,
    holdings
  }
  const previousSnapshot = comparablePrevious.reportDate
    ? {
        code,
        name: current.name,
        reportDate: comparablePrevious.reportDate,
        previousReportDate: null,
        source,
        targetCode: current.targetCode,
        targetName: current.targetName,
        updatedAt: current.updatedAt,
        stale: false,
        holdings: comparablePrevious.holdings.map(item => ({
          ...item,
          fundCode: code,
          changeType: 'unknown',
          quarterChange: null
        }))
      }
    : null

  return { current, previous: previousSnapshot }
}

export async function getFundHoldings(code, { includeQuotes = false } = {}) {
  const stored = await getStoredFundHoldings(code, { includeQuotes })
  if (stored?.holdings?.length) return stored
  if (!codeIsValid(code)) throw new Error('基金代码必须是6位数字')
  const cacheKey = `fund:holdings:v2:${code}`
  let result = getCache(cacheKey)
  holdingsFileCache = loadPersistentCache(HOLDINGS_CACHE_FILE, holdingsFileCache)
  const persisted = getPersistentEntry(holdingsFileCache, code)

  if (!result && persisted?.previousReportDate !== undefined && Date.now() - Date.parse(persisted.cachedAt) < 24 * 60 * 60 * 1000) {
    result = { ...persisted, cache: 'disk', stale: false }
    setCache(cacheKey, result, 24 * 60 * 60 * 1000)
  }

  if (!result) {
    try {
      let parsed = await fetchF10Holdings(code)
      let linked = null
      if (parsed.holdings.length === 0) linked = await resolveLinkedEtfHoldings(code, getFundProfile(code)?.name || '').catch(() => null)
      if (!linked && LINKED_ETF_FALLBACKS[code]) {
        const targetCode = LINKED_ETF_FALLBACKS[code]
        const target = await fetchF10Holdings(targetCode)
        linked = target.holdings.length ? { ...target, targetCode, targetName: target.fundName || '' } : null
      }
      if (linked) parsed = linked
      parsed = await resolveSnapshotMarkets(parsed)
      if (parsed.holdings.length === 0) throw new Error('持仓数据为空')
      const previousRaw = previousQuarter(parsed.reportDate)
        ? await fetchF10Holdings(linked?.targetCode || code, previousQuarter(parsed.reportDate).year, previousQuarter(parsed.reportDate).month).catch(() => ({ holdings: [], reportDate: null }))
        : { holdings: [], reportDate: null }
      const previous = await resolveSnapshotMarkets(previousRaw)
      const comparablePrevious = previous.reportDate && previous.reportDate !== parsed.reportDate
        ? previous
        : { holdings: [], reportDate: null }
      const priorBySecurity = new Map(comparablePrevious.holdings.map(item => [`${item.marketPrefix}.${item.stockCode}`, item.holdingRatio]))
      const holdings = parsed.holdings.map(item => ({
        ...item,
        quarterChange: priorBySecurity.has(`${item.marketPrefix}.${item.stockCode}`)
          ? Number((item.holdingRatio - priorBySecurity.get(`${item.marketPrefix}.${item.stockCode}`)).toFixed(2))
          : null
      }))
      result = {
        code,
        name: getFundProfile(code)?.name || parsed.fundName || '',
        reportDate: parsed.reportDate,
        previousReportDate: comparablePrevious.reportDate,
        source: linked ? 'eastmoney_f10_linked_etf' : 'eastmoney_f10',
        targetCode: linked?.targetCode || null,
        targetName: linked?.targetName || null,
        updatedAt: new Date().toISOString(),
        stale: false,
        holdings
      }
      updatePersistentCache(HOLDINGS_CACHE_FILE, holdingsFileCache, code, result)
      setCache(cacheKey, result, 24 * 60 * 60 * 1000)
    } catch (error) {
      if (persisted?.holdings?.length) result = { ...persisted, cache: 'stale_disk', stale: true, error: error.message }
      else return { code, name: getFundProfile(code)?.name || '', source: null, stale: false, holdings: [], error: error.message }
    }
  }

  if (!includeQuotes || result.holdings.length === 0) return result
  const secids = result.holdings.map(item => `${item.marketPrefix}.${item.stockCode}`)
  const quotes = await fetchStockQuotes(secids)
  return {
    ...result,
    holdings: result.holdings.map(item => ({
      ...item,
      dayChange: quotes[item.stockCode]?.changePercent ?? null,
      price: quotes[item.stockCode]?.price ?? null,
      sector: quotes[item.stockCode]?.sector ?? (item.marketPrefix === '116' ? '港股' : /^10[56]$/.test(item.marketPrefix || '') ? '美股' : '海外股票')
    }))
  }
}

/**
 * Calculates an intraday QDII estimate from disclosed holdings only. Missing
 * holdings remain unpriced instead of being normalized into a made-up return.
 */
export function createQdiiHoldingsEstimate(code, profile, holdings, now = new Date()) {
  const baseNav = numberOrNull(profile?.snapshot?.nav ?? profile?.snapshot?.previousNav)
  if (!baseNav || !Array.isArray(holdings)) return null

  let coveredWeight = 0
  let weightedChange = 0
  let quotedCount = 0
  for (const holding of holdings) {
    const weight = numberOrNull(holding.holdingRatio)
    const change = numberOrNull(holding.dayChange)
    if (weight === null || weight <= 0 || change === null) continue
    coveredWeight += weight
    weightedChange += weight * change / 100
    quotedCount++
  }
  if (quotedCount < 2 || coveredWeight < 20) return null

  const market = getBeijingMarketState(now)
  const estimateMarket = getFundEstimateMarketState(profile || {}, now)
  return {
    fundcode: code,
    name: profile?.name || '',
    dwjz: baseNav.toFixed(4),
    gsz: (baseNav * (1 + weightedChange / 100)).toFixed(4),
    gszzl: weightedChange.toFixed(2),
    gztime: `${market.date} ${String(Math.floor(market.minutes / 60)).padStart(2, '0')}:${String(market.minutes % 60).padStart(2, '0')}`,
    source: 'holdings_weighted',
    realtime: true,
    stale: false,
    frozen: false,
    market: estimateMarket.market,
    marketDate: estimateMarket.date || market.date,
    fundType: profile?.type || '',
    coverage: {
      quotedCount,
      disclosedWeight: Number(coveredWeight.toFixed(2))
    }
  }
}

async function getQdiiHoldingsEstimate(code, profile, now = new Date()) {
  const holdings = await getFundHoldings(code, { includeQuotes: true })
  return createQdiiHoldingsEstimate(code, profile, holdings.holdings, now)
}

export function parseSinaEstimatePayload(payload, code) {
  const data = payload?.result?.data
  const points = data?.networth
  if (!Array.isArray(points) || points.length === 0) return null
  const point = [...points].reverse().find(item =>
    numberOrNull(item.pre_nav) !== null || numberOrNull(item.pre_nav2) !== null
  )
  if (!point) return null
  const makeSource = (name, navKey, rateKey) => {
    const nav = numberOrNull(point[navKey])
    const decimalRate = numberOrNull(point[rateKey])
    if (nav === null || decimalRate === null) return null
    return {
      fundcode: code,
      gsz: nav.toFixed(4),
      gszzl: (decimalRate * 100).toFixed(2),
      minTime: point.min_time || '',
      baseDate: point.pre_date || '',
      source: name
    }
  }
  return {
    actualNav: numberOrNull(data.worth),
    actualNavDate: String(data.worth_date || '').replace(/^(\d{4})(\d{2})(\d{2})$/, '$1-$2-$3'),
    sina_ds2: makeSource('sina_ds2', 'pre_nav', 'growthrate'),
    sina_ds3: makeSource('sina_ds3', 'pre_nav2', 'growthrate2')
  }
}

export async function getSinaEstimateSources(code, now = new Date()) {
  if (!codeIsValid(code)) throw new Error('基金代码必须是6位数字')
  const cacheKey = `fund:sina-estimate:${code}`
  const cached = getCache(cacheKey)
  if (cached) return cached
  const response = await fetchUpstream(`https://stock.finance.sina.com.cn/fundInfo/api/openapi.php/FdFundService.getEstimateNetworthPic?symbol=${code}`, {
    headers: { ...DEFAULT_HEADERS, 'Referer': 'https://finance.sina.com.cn/' },
    timeoutMs: 6_000,
    retries: 1,
    dedupeKey: cacheKey
  })
  const parsed = parseSinaEstimatePayload(await response.json(), code)
  if (!parsed) throw new Error('新浪估值数据为空')
  const profile = getFundProfile(code)
  const market = getFundEstimateMarketState(profile || {}, now)
  const active = isEstimateSessionActive(market)
  const result = {
    code,
    name: profile?.name || '',
    realtime: active,
    stale: !active,
    ...parsed
  }
  setCache(cacheKey, result, active ? 20 * 1000 : 10 * 60 * 1000)
  return result
}

function decorateEstimate(code, estimate) {
  if (!estimate) return null
  const profile = getFundProfile(code)
  const isActual = estimate.source === 'market_snapshot' && !estimate.pending && numberOrNull(estimate.gszzl) !== null
  const method = isActual
    ? { valuationType: 'actual_nav', confidence: 1, confidenceNote: '采用批量缓存的最新已公布实际净值' }
    : classifyFund(profile || {})
  return {
    ...estimate,
    name: estimate.name || profile?.name || '',
    fundType: estimate.fundType || profile?.type || '',
    valuationType: method.valuationType,
    valuationMethod: isActual ? 'latest_actual_nav' : estimate.source,
    confidence: estimate.source === 'fundgz' ? Math.max(method.confidence, 0.9) : method.confidence,
    confidenceNote: method.confidenceNote
  }
}

export async function getReliableFundEstimates(codes, now = new Date()) {
  const uniqueCodes = [...new Set(codes.filter(codeIsValid))]
  const primary = await fetchFundEstimates(uniqueCodes, now)
  const market = getBeijingMarketState(now)
  const results = {}

  await Promise.all(uniqueCodes.map(async code => {
    let estimate = decorateEstimate(code, primary[code])
    const profile = getFundProfile(code)
    const estimateMarket = getFundEstimateMarketState(profile || {}, now)
    const snapshotNeedsEstimate = estimate?.source === 'market_snapshot' && (
      estimate.pending || numberOrNull(estimate.gszzl) === null
    )
    if (estimateMarket.isOpen && snapshotNeedsEstimate && profile?.valuationType === 'hybrid_qdii') {
      try {
        const holdingsEstimate = await getQdiiHoldingsEstimate(code, profile, now)
        if (holdingsEstimate) {
          estimate = decorateEstimate(code, holdingsEstimate)
          estimate.confidence = Math.min(estimate.confidence || 0.7, 0.7)
          estimate.confidenceNote = `前十大持仓实时加权，已覆盖 ${holdingsEstimate.coverage.disclosedWeight}% 披露权重`
        }
      } catch {
        // Keep the explicit snapshot fallback when disclosed holdings cannot be quoted.
      }
    }
    if (estimate?.source === 'market_snapshot' && snapshotNeedsEstimate && !profile?.snapshot?.isMoneyMarket && (
      isEstimateSessionActive(estimateMarket) || profile?.valuationType === 'hybrid_qdii'
    )) {
      try {
        const sina = await getSinaEstimateSources(code, now)
        const fallback = [sina.sina_ds2, sina.sina_ds3]
          .find(item => item && (
            profile?.valuationType === 'hybrid_qdii'
              ? isEstimateEligibleForMarket(item, estimateMarket)
              : isSameMarketDate(item.baseDate, market.date)
          ))
        if (fallback) {
          estimate = decorateEstimate(code, {
            fundcode: code,
            name: profile?.name || '',
            dwjz: Number(profile?.snapshot?.previousNav || profile?.snapshot?.nav || sina.actualNav || 0).toFixed(4),
            gsz: fallback.gsz,
            gszzl: fallback.gszzl,
            gztime: `${fallback.baseDate} ${fallback.minTime}`.trim(),
            source: fallback.source,
            realtime: Boolean(estimateMarket.isOpen),
            stale: false,
            frozen: !estimateMarket.isOpen,
            market: estimateMarket.market,
            marketDate: fallback.baseDate,
            fundType: profile?.type || ''
          })
          estimate.confidence = Math.min(estimate.confidence || 0.75, 0.75)
          estimate.confidenceNote = '天天基金实时源不可用，已降级到新浪估值'
        }
      } catch {
        // 保留最新实际净值作为最终降级。
      }
    }
    if (estimate?.source === 'market_snapshot' && snapshotNeedsEstimate && profile?.valuationType === 'hybrid_qdii') {
      const persisted = getPersistedFundEstimate(code, estimateMarket)
      if (persisted) estimate = decorateEstimate(code, persisted)
    }
    if (estimate && estimate.source !== 'market_snapshot') persistFundEstimate(code, estimate, estimateMarket)
    if (estimate) results[code] = estimate
  }))

  return results
}

export async function getFundEstimateSources(code, now = new Date()) {
  const primary = await fetchFundEstimates([code], now)
  const profile = getFundProfile(code)
  const sources = {}
  if (primary[code]) sources[primary[code].source || 'fundgz'] = decorateEstimate(code, primary[code])
  if (!profile?.snapshot?.isMoneyMarket) {
    try {
      const sina = await getSinaEstimateSources(code, now)
      const market = getFundEstimateMarketState(profile || {}, now)
      for (const key of ['sina_ds2', 'sina_ds3']) {
        const item = sina[key]
        if (!item) continue
        const eligible = profile?.valuationType === 'hybrid_qdii'
          ? isEstimateEligibleForMarket(item, market)
          : isSameMarketDate(item.baseDate, market.date)
        sources[key] = {
          fundcode: code,
          name: profile?.name || '',
          dwjz: Number(profile?.snapshot?.previousNav || profile?.snapshot?.nav || sina.actualNav || 0).toFixed(4),
          gsz: item.gsz,
          gszzl: item.gszzl,
          gztime: `${item.baseDate} ${item.minTime}`.trim(),
          source: key,
          realtime: Boolean(market.isOpen && eligible),
          stale: !eligible,
          frozen: Boolean(eligible && !market.isOpen),
          market: market.market,
          marketDate: item.baseDate,
          confidence: 0.75,
          valuationType: profile?.valuationType,
          valuationMethod: key
        }
      }
    } catch {
      // Diagnostics remain useful with the sources that are available.
    }
  }
  const market = getFundEstimateMarketState(profile || {}, now)
  if (profile?.valuationType === 'hybrid_qdii' && market.isOpen) {
    try {
      const holdingsEstimate = await getQdiiHoldingsEstimate(code, profile, now)
      if (holdingsEstimate) sources.holdings_weighted = decorateEstimate(code, holdingsEstimate)
    } catch {
      // Diagnostics remain useful with the sources that are available.
    }
  }
  const persisted = profile?.valuationType === 'hybrid_qdii' ? getPersistedFundEstimate(code, market) : null
  if (persisted && !sources[persisted.source]) sources[persisted.source] = decorateEstimate(code, persisted)
  const hasPublishedSnapshot = sources.market_snapshot && !sources.market_snapshot.pending &&
    numberOrNull(sources.market_snapshot.gszzl) !== null
  const preferredOrder = hasPublishedSnapshot
    ? ['market_snapshot', 'fundgz', 'holdings_weighted', 'sina_ds2', 'sina_ds3']
    : market.isOpen
      ? ['fundgz', 'holdings_weighted', 'sina_ds2', 'sina_ds3', 'market_snapshot']
      : ['sina_ds2', 'sina_ds3', 'holdings_weighted', 'fundgz', 'market_snapshot']
  const recommended = preferredOrder.find(source => sources[source] && !sources[source].stale && numberOrNull(sources[source].gszzl) !== null)
    || preferredOrder.find(source => sources[source])
    || Object.keys(sources)[0]
    || null
  return { code, profile, recommended, sources }
}
