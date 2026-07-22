/**
 * 基金数据缓存层
 * [WHY] 减少对东方财富 API 的重复请求，提升响应速度
 * [WHAT] 内存缓存 + 定时刷新 + 全市场基金列表抓取
 * [HOW] 支持 TTL 过期、手动刷新、批量预热
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync, renameSync } from 'fs'
import { join, dirname } from 'path'
import { fileURLToPath } from 'url'
import { setDefaultResultOrder } from 'node:dns'
import { getStoredSectorQuotes, storeSectorQuotes } from './market-database.mjs'

// Eastmoney's historical quote host is intermittently unreachable over IPv6
// in the deployment network, while its IPv4 endpoint is stable.
setDefaultResultOrder('ipv4first')

const __dirname = dirname(fileURLToPath(import.meta.url))
const CACHE_DIR = process.env.FUND_CACHE_DIR || join(__dirname, 'data')

const BEIJING_TIME_ZONE = 'Asia/Shanghai'
const FUND_SNAPSHOT_FILE = 'fund-snapshots.json'
const SECTOR_UNIVERSE_FILE = 'sector-universe.json'
const SECTOR_UNIVERSE_CACHE_KEY = 'sector:universe'
const SECTOR_UNIVERSE_TTL_MS = 6 * 60 * 60 * 1000
function readLocalEnvironmentValue(name) {
  for (const file of ['.env.local', '.env.production.local']) {
    try {
      const source = readFileSync(join(dirname(__dirname), file), 'utf8')
      const match = source.match(new RegExp(`^${name}=(.*)$`, 'm'))
      if (match?.[1]) return match[1].trim().replace(/^['"]|['"]$/g, '')
    } catch {
      // Environment files are optional in deployed containers.
    }
  }
  return ''
}
const SUPABASE_REST_URL = (process.env.SUPABASE_URL || 'https://www.tyingfund.com/supabase').replace(/\/$/, '')
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY || process.env.VITE_SUPABASE_ANON_KEY || readLocalEnvironmentValue('VITE_SUPABASE_ANON_KEY')
const UPSTREAM_TIMEOUT_MS = 8_000
const UPSTREAM_MAX_CONCURRENCY = 6
const CIRCUIT_FAILURE_THRESHOLD = 4
const CIRCUIT_COOLDOWN_MS = 60_000
const upstreamInflight = new Map()
const upstreamCircuits = new Map()
let activeUpstreamRequests = 0
const upstreamQueue = []
let fundSnapshotRefreshPromise = null
let fundSnapshotIndex = null
let fundSnapshotMetadata = null
let sectorUniverseRefreshPromise = null
const sectorSnapshotRefreshPromises = new Map()

// 确保 data 目录存在
if (!existsSync(CACHE_DIR)) {
  mkdirSync(CACHE_DIR, { recursive: true })
}

// ========== 内存缓存 ==========
const memoryCache = new Map()

function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms))
}

function runWithUpstreamLimit(task) {
  return new Promise((resolve, reject) => {
    const execute = async () => {
      activeUpstreamRequests++
      try {
        resolve(await task())
      } catch (error) {
        reject(error)
      } finally {
        activeUpstreamRequests--
        upstreamQueue.shift()?.()
      }
    }

    if (activeUpstreamRequests < UPSTREAM_MAX_CONCURRENCY) execute()
    else upstreamQueue.push(execute)
  })
}

function circuitFor(hostname) {
  if (!upstreamCircuits.has(hostname)) {
    upstreamCircuits.set(hostname, { failures: 0, openUntil: 0, lastError: null })
  }
  return upstreamCircuits.get(hostname)
}

function markUpstreamSuccess(hostname) {
  const circuit = circuitFor(hostname)
  circuit.failures = 0
  circuit.openUntil = 0
  circuit.lastError = null
}

function markUpstreamFailure(hostname, error) {
  const circuit = circuitFor(hostname)
  circuit.failures++
  circuit.lastError = error.message || String(error)
  if (circuit.failures >= CIRCUIT_FAILURE_THRESHOLD) {
    circuit.openUntil = Date.now() + CIRCUIT_COOLDOWN_MS
  }
}

export async function fetchUpstream(url, options = {}) {
  const {
    timeoutMs = UPSTREAM_TIMEOUT_MS,
    retries = 2,
    dedupeKey = `${options.method || 'GET'}:${url}`,
    ...fetchOptions
  } = options

  if (upstreamInflight.has(dedupeKey)) return upstreamInflight.get(dedupeKey)

  const request = runWithUpstreamLimit(async () => {
    const hostname = new URL(url).hostname
    const circuit = circuitFor(hostname)
    if (circuit.openUntil > Date.now()) {
      throw new Error(`上游 ${hostname} 暂时熔断`)
    }

    let lastError
    for (let attempt = 0; attempt <= retries; attempt++) {
      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(), timeoutMs)
      try {
        const response = await fetch(url, { ...fetchOptions, signal: controller.signal })
        if (!response.ok) {
          const error = new Error(`HTTP ${response.status}`)
          error.status = response.status
          const retryAfter = response.headers.get('retry-after')
          if (retryAfter) {
            const seconds = Number(retryAfter)
            error.retryAfterMs = Number.isFinite(seconds)
              ? seconds * 1000
              : Math.max(0, Date.parse(retryAfter) - Date.now())
          }
          throw error
        }
        markUpstreamSuccess(hostname)
        return response
      } catch (error) {
        lastError = error
        const retryable = error.name === 'AbortError' || !error.status || error.status === 429 || error.status >= 500
        if (!retryable || attempt === retries) break
        const retryAfterMs = Number(error.retryAfterMs) || 0
        const backoffMs = Math.max(retryAfterMs, 350 * (2 ** attempt) + Math.floor(Math.random() * 200))
        await delay(backoffMs)
      } finally {
        clearTimeout(timer)
      }
    }

    if (!lastError?.status || lastError.status === 429 || lastError.status >= 500) {
      markUpstreamFailure(hostname, lastError)
    }
    throw lastError
  })

  upstreamInflight.set(dedupeKey, request)
  try {
    return await request
  } finally {
    upstreamInflight.delete(dedupeKey)
  }
}

export function getBeijingMarketState(now = new Date()) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-US', {
    timeZone: BEIJING_TIME_ZONE,
    weekday: 'short', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hourCycle: 'h23'
  }).formatToParts(now).filter(part => part.type !== 'literal').map(part => [part.type, part.value]))
  const weekday = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(parts.weekday)
  const minutes = Number(parts.hour) * 60 + Number(parts.minute)
  const weekdaySession = weekday >= 1 && weekday <= 5
  const morningOpen = minutes >= 9 * 60 + 30 && minutes < 11 * 60 + 30
  const afternoonOpen = minutes >= 13 * 60 && minutes < 15 * 60
  // The lunch recess has no new ticks, but the last same-day estimate remains
  // the active intraday value and must not be replaced by yesterday's NAV.
  const isEstimateSession = weekdaySession && minutes >= 9 * 60 + 30 && minutes < 15 * 60
  return {
    date: `${parts.year}-${parts.month}-${parts.day}`,
    weekday,
    minutes,
    isWeekday: weekdaySession,
    isOpen: weekdaySession && (morningOpen || afternoonOpen),
    isLunchBreak: weekdaySession && minutes >= 11 * 60 + 30 && minutes < 13 * 60,
    isEstimateSession,
    isAfterClose: minutes >= 15 * 60
  }
}

function getZonedMarketClock(timeZone, now = new Date()) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-US', {
    timeZone,
    weekday: 'short', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hourCycle: 'h23'
  }).formatToParts(now).filter(part => part.type !== 'literal').map(part => [part.type, part.value]))
  const weekday = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(parts.weekday)
  return { date: `${parts.year}-${parts.month}-${parts.day}`, weekday, minutes: Number(parts.hour) * 60 + Number(parts.minute) }
}

export function getHongKongMarketState(now = new Date()) {
  const market = getZonedMarketClock('Asia/Hong_Kong', now)
  const weekday = market.weekday >= 1 && market.weekday <= 5
  const morning = market.minutes >= 9 * 60 + 30 && market.minutes < 12 * 60
  const afternoon = market.minutes >= 13 * 60 && market.minutes < 16 * 60
  return { ...market, isWeekday: weekday, isOpen: weekday && (morning || afternoon), isAfterClose: weekday && market.minutes >= 16 * 60 }
}

export function getUsMarketState(now = new Date()) {
  const market = getZonedMarketClock('America/New_York', now)
  const weekday = market.weekday >= 1 && market.weekday <= 5
  const regular = market.minutes >= 9 * 60 + 30 && market.minutes < 16 * 60
  return { ...market, isWeekday: weekday, isOpen: weekday && regular, isAfterClose: weekday && market.minutes >= 16 * 60 }
}

const HONG_KONG_FUND_PATTERN = /恒生|恒指|港股|香港|H股|国企/
const US_FUND_PATTERN = /美股|美国|纳斯达克|标普|道琼斯|罗素|全球科技|全球互联网/
const OVERSEAS_FUND_PATTERN = /QDII|海外|全球/

export function getFundEstimateMarketState(fund = {}, now = new Date()) {
  const identity = `${fund.name || ''} ${fund.type || ''}`.toUpperCase()
  const hongKong = getHongKongMarketState(now)
  const us = getUsMarketState(now)

  // A Hong Kong marker is more specific than QDII. Do not keep a Hang Seng
  // fund in a live-estimate state merely because the US market is open.
  if (HONG_KONG_FUND_PATTERN.test(identity)) return { market: 'hk', ...hongKong, hongKong, us }
  if (US_FUND_PATTERN.test(identity)) return { market: 'us', ...us, hongKong, us }
  if (!OVERSEAS_FUND_PATTERN.test(identity)) return { market: 'cn', ...getBeijingMarketState(now) }
  return {
    market: 'overseas',
    isOpen: hongKong.isOpen || us.isOpen,
    isWeekday: hongKong.isWeekday || us.isWeekday,
    hongKong,
    us
  }
}

export function shouldFetchFundgzEstimateForFund(fund = {}, now = new Date()) {
  const state = getFundEstimateMarketState(fund, now)
  if (state.market === 'overseas' || state.market === 'hk' || state.market === 'us') return state.isOpen
  return shouldFetchFundgzEstimate(state)
}

/**
 * fundgz keeps publishing the final same-day estimate briefly after 15:00.
 * Continue reading it through the settlement window so a previous trading-day
 * snapshot never replaces the day's final intraday valuation.
 */
export function shouldFetchFundgzEstimate(market = getBeijingMarketState()) {
  return market.isEstimateSession || (
    market.isWeekday &&
    market.isAfterClose &&
    market.minutes < 20 * 60
  )
}

export function isSnapshotFreshEnoughForTrading(snapshotDate, now = new Date()) {
  if (!snapshotDate) return false
  const market = getBeijingMarketState(now)
  const snapshot = new Date(`${snapshotDate}T00:00:00+08:00`)
  const today = new Date(`${market.date}T00:00:00+08:00`)
  const gap = Math.round((today - snapshot) / 86_400_000)
  const maxGap = market.weekday === 1 ? 3 : 1
  return gap >= 0 && gap <= maxGap
}

/**
 * 设置缓存
 * @param {string} key 缓存键
 * @param {*} value 缓存值
 * @param {number} ttlMs 过期时间（毫秒），默认 5 分钟
 */
export function setCache(key, value, ttlMs = 5 * 60 * 1000) {
  memoryCache.set(key, {
    data: value,
    expires: Date.now() + ttlMs,
    createdAt: Date.now()
  })
}

/**
 * 获取缓存
 * @param {string} key 缓存键
 * @returns {*} 缓存值，过期或不存在返回 null
 */
export function getCache(key) {
  const entry = memoryCache.get(key)
  if (!entry) return null
  if (Date.now() > entry.expires) {
    memoryCache.delete(key)
    return null
  }
  return entry.data
}

/**
 * 检查缓存是否存在且未过期
 */
export function hasCache(key) {
  const entry = memoryCache.get(key)
  if (!entry) return false
  if (Date.now() > entry.expires) {
    memoryCache.delete(key)
    return false
  }
  return true
}

/**
 * 清除所有缓存
 */
export function clearCache() {
  memoryCache.clear()
}

/**
 * 获取缓存统计信息
 */
export function getCacheStats() {
  let valid = 0, expired = 0
  const now = Date.now()
  for (const [key, entry] of memoryCache) {
    if (now > entry.expires) expired++
    else valid++
  }
  return {
    total: memoryCache.size,
    valid,
    expired,
    upstream: {
      active: activeUpstreamRequests,
      queued: upstreamQueue.length,
      inflight: upstreamInflight.size,
      circuits: Object.fromEntries([...upstreamCircuits].map(([host, state]) => [host, {
        failures: state.failures,
        open: state.openUntil > now,
        openUntil: state.openUntil ? new Date(state.openUntil).toISOString() : null,
        lastError: state.lastError
      }]))
    },
    fundSnapshots: fundSnapshotMetadata
  }
}

// ========== 持久化缓存（JSON 文件）==========

/**
 * 保存数据到本地 JSON 文件
 */
export function saveToFile(filename, data) {
  const filePath = join(CACHE_DIR, filename)
  const tempPath = `${filePath}.${process.pid}.tmp`
  writeFileSync(tempPath, JSON.stringify(data), 'utf-8')
  renameSync(tempPath, filePath)
  return filePath
}

/**
 * 从本地 JSON 文件读取数据
 */
export function loadFromFile(filename) {
  const filePath = join(CACHE_DIR, filename)
  if (!existsSync(filePath)) return null
  try {
    return JSON.parse(readFileSync(filePath, 'utf-8'))
  } catch {
    return null
  }
}

async function fetchEastmoneyStockQuotes(secids) {
  if (!secids || secids.length === 0) return {}

  const results = {}

  // [HOW] 分离 A股（0/1 前缀）和港股（116 前缀）
  const aStockIds = secids
  const hkStockIds = []

  // [HOW] A股批量请求
  if (aStockIds.length > 0) {
    const secidsStr = aStockIds.join(',')
    try {
      const path = `/api/qt/ulist.np/get?fltt=2&secids=${secidsStr}&fields=f2,f3,f4,f12,f14,f100&_=${Date.now()}`
      let data = null
      let lastError = null
      for (const host of ['push2delay.eastmoney.com', 'push2.eastmoney.com']) {
        try {
          const response = await fetchUpstream(`https://${host}${path}`, {
            headers: {
              'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
              'Referer': 'https://quote.eastmoney.com/'
            },
            retries: 0,
            timeoutMs: 6_000,
            dedupeKey: `stock-quotes:eastmoney:${host}:${secidsStr}`
          })
          const candidate = await response.json()
          if (!Array.isArray(candidate?.data?.diff)) throw new Error(`${host} 返回了无效证券行情`)
          data = candidate
          break
        } catch (error) {
          lastError = error
        }
      }
      if (!data) throw lastError || new Error('东方财富证券行情不可用')

      for (const item of data.data.diff) {
        if (item.f12 === undefined) continue
        // [NOTE] fltt=2 时 f3 是百分比数值（如 3.25 表示 3.25%），无需除以100
        results[item.f12] = {
          name: item.f14 || '',
          price: item.f2 || 0,
          change: item.f4 || 0,
          changePercent: item.f3 ?? null,
          sector: item.f100 || null,
          source: 'eastmoney',
          sectorSource: 'eastmoney'
        }
      }
    } catch (e) {
      console.error('[Stock Quotes] A股批量获取失败:', e.message)
    }
  }

  // [HOW] 港股逐个请求（批量接口不支持港股）
  for (const secid of hkStockIds) {
    const code = secid.replace('116.', '')
    const url = `https://push2.eastmoney.com/api/qt/stock/get?secid=116.${code}&fields=f170,f43,f14&_=${Date.now()}`
    try {
      const response = await fetch(url, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
          'Referer': 'https://quote.eastmoney.com/'
        }
      })
      if (response.ok) {
        const data = await response.json()
        if (data.data && data.data.f170 !== undefined) {
          // [NOTE] 港股 f170 是乘以100的整数（382 表示 3.82%），需要除以100
          results[code] = {
            name: data.data.f14 || '',
            price: data.data.f43 || 0,
            change: 0,
            changePercent: data.data.f170 / 100
          }
        }
      }
    } catch (e) {
      console.error(`[Stock Quotes] 港股 ${code} 获取失败:`, e.message)
    }
  }

  return results
}

/**
 * 抓取全市场基金列表（从 fund.eastmoney.com）
 * [WHAT] 获取所有基金的代码、名称、类型等基础信息
 * [HOW] 请求 fundcode_search.js，解析 JS 变量为 JSON
 */
export async function fetchFullFundList() {
  console.log('[Cache] 开始抓取全市场基金列表...')

  const url = 'http://fund.eastmoney.com/js/fundcode_search.js'

  try {
    const response = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Referer': 'http://fund.eastmoney.com/'
      }
    })

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}: ${response.statusText}`)
    }

    let text = await response.text()

    // 去掉 JS 变量声明，提取 JSON 数组
    // 原始格式：var r = [["000001","HXCZHH","华夏成长混合","混合型-偏股","HUAXIACHENGZHANGHUNHE"],...]
    text = text.replace(/^var\s+r\s*=\s*/, '').replace(/;?\s*$/, '')

    const rawList = JSON.parse(text)

    // 转换为结构化对象数组
    const fundList = rawList.map(item => ({
      code: item[0],        // 基金代码
      pinyin: item[1],      // 拼音简称
      name: item[2],        // 基金名称
      type: item[3],        // 基金类型
      fullPinyin: item[4]   // 拼音全称
    }))

    console.log(`[Cache] 成功获取 ${fundList.length} 只基金`)

    // 持久化到文件
    const filePath = saveToFile('fund-list.json', fundList)
    console.log(`[Cache] 已保存到: ${filePath}`)

    // 同时写入内存缓存（24小时过期）
    setCache('fund-list', fundList, 24 * 60 * 60 * 1000)

    return fundList

  } catch (error) {
    console.error(`[Cache] 抓取基金列表失败: ${error.message}`)

    // 尝试从文件缓存读取
    const cached = loadFromFile('fund-list.json')
    if (cached) {
      console.log(`[Cache] 使用文件缓存: ${cached.length} 只基金`)
      setCache('fund-list', cached, 24 * 60 * 60 * 1000)
      return cached
    }

    throw error
  }
}

/**
 * 获取全市场基金列表（优先缓存）
 */
export function getFundList() {
  // 1. 内存缓存
  const memCached = getCache('fund-list')
  if (memCached) return memCached

  // 2. 文件缓存
  const fileCached = loadFromFile('fund-list.json')
  if (fileCached) {
    setCache('fund-list', fileCached, 24 * 60 * 60 * 1000)
    return fileCached
  }

  return null
}

function normalizeSectorUniverse(rows) {
  return (Array.isArray(rows) ? rows : []).map(row => ({
    // Database rows and the persisted recovery snapshot use different field
    // names; accepting both keeps the curated universe available offline.
    code: String(row.sector_id || row.code || ''),
    name: String(row.sector_name || row.name || ''),
    type: (row.sector_type || row.type) === 'concept' ? 'concept' : 'industry',
    changePercent: Number(row.change_pct ?? row.changePercent) || 0,
    netInflow: Number(row.net_inflow ?? row.netInflow) || 0,
    updatedAt: row.update_at || row.updatedAt || null
  })).filter(row => row.code && row.name && (row.type === 'industry' || row.type === 'concept'))
}

async function fetchSectorUniverse() {
  const cached = getCache(SECTOR_UNIVERSE_CACHE_KEY)
  if (cached) return cached
  if (sectorUniverseRefreshPromise) return sectorUniverseRefreshPromise

  const fallback = normalizeSectorUniverse(loadFromFile(SECTOR_UNIVERSE_FILE))
  sectorUniverseRefreshPromise = (async () => {
    if (!SUPABASE_ANON_KEY) {
      setCache(SECTOR_UNIVERSE_CACHE_KEY, fallback, 5 * 60 * 1000)
      return fallback
    }

    try {
      const response = await fetchUpstream(
        `${SUPABASE_REST_URL}/rest/v1/fund_topic?select=sector_id,sector_name,sector_type,change_pct,net_inflow,update_at&sector_type=in.(industry,concept)&order=sector_type,sector_name`,
        {
          headers: {
            apikey: SUPABASE_ANON_KEY,
            Authorization: `Bearer ${SUPABASE_ANON_KEY}`,
            Accept: 'application/json'
          },
          retries: 1,
          timeoutMs: 8_000,
          dedupeKey: 'sector:universe:remote'
        }
      )
      const universe = normalizeSectorUniverse(await response.json())
      if (!universe.length) throw new Error('板块映射表为空')
      saveToFile(SECTOR_UNIVERSE_FILE, universe)
      setCache(SECTOR_UNIVERSE_CACHE_KEY, universe, SECTOR_UNIVERSE_TTL_MS)
      console.log(`[Cache] 精选板块映射已同步: 行业 ${universe.filter(row => row.type === 'industry').length} 条，概念 ${universe.filter(row => row.type === 'concept').length} 条`)
      return universe
    } catch (error) {
      console.error(`[Cache] 精选板块映射同步失败，使用本地快照: ${error.message}`)
      setCache(SECTOR_UNIVERSE_CACHE_KEY, fallback, fallback.length ? 30 * 60 * 1000 : 60 * 1000)
      return fallback
    }
  })()

  try {
    return await sectorUniverseRefreshPromise
  } finally {
    sectorUniverseRefreshPromise = null
  }
}

function mergeSectorUniverse(universe, liveSectors, type) {
  const topics = universe.filter(row => row.type === type)
  const classification = type === 'concept' ? 'eastmoney_concept' : 'shenwan_l3'
  if (!topics.length) return liveSectors.map(row => ({ ...row, classification }))
  if (!liveSectors.length) {
    return topics.map(topic => ({
      code: topic.code,
      name: topic.name,
      dayReturn: topic.changePercent,
      netInflow: topic.netInflow,
      type,
      classification,
      updatedAt: topic.updatedAt,
      source: 'mapping_snapshot'
    }))
  }

  // Eastmoney has reused board identifiers over time. A saved code is only
  // trustworthy when its current display name is still the same; otherwise
  // resolve by name and tolerate the newer industry-grade suffix (II / III).
  const normalizedName = name => String(name || '').replace(/\s+/g, '').replace(/[\u2160-\u216b]+$/, '')
  const liveByCode = new Map(liveSectors.map(row => [row.code, row]))
  const liveByName = new Map(liveSectors.map(row => [normalizedName(row.name), row]))
  const mappedLiveCodes = new Set()
  const enrichedTopics = topics.flatMap(topic => {
    const byCode = liveByCode.get(topic.code)
    const live = byCode && normalizedName(byCode.name) === normalizedName(topic.name)
      ? byCode
      : liveByName.get(normalizedName(topic.name))
    if (!live?.code) return []
    mappedLiveCodes.add(live.code)
    return [{
      code: live?.code || topic.code,
      name: topic.name,
      dayReturn: live ? live.dayReturn : topic.changePercent,
      netInflow: live ? live.netInflow : topic.netInflow,
      type,
      classification,
      updatedAt: live?.updatedAt || topic.updatedAt,
      source: 'eastmoney'
    }]
  })
  // The stored mapping is useful for fund associations, but must not restrict
  // the board list. Keep the complete Shenwan L3 / Eastmoney concept feed.
  const liveOnly = liveSectors
    .filter(row => !mappedLiveCodes.has(row.code))
    .map(row => ({ ...row, type, classification }))
  return [...enrichedTopics, ...liveOnly]
}

function extractArrayLiteral(source, propertyName) {
  const propertyIndex = source.indexOf(`${propertyName}:[`)
  if (propertyIndex < 0) throw new Error(`批量快照缺少 ${propertyName}`)
  const start = source.indexOf('[', propertyIndex)
  let depth = 0
  let inString = false
  let escaped = false

  for (let index = start; index < source.length; index++) {
    const char = source[index]
    if (inString) {
      if (escaped) escaped = false
      else if (char === '\\') escaped = true
      else if (char === '"') inString = false
      continue
    }
    if (char === '"') inString = true
    else if (char === '[') depth++
    else if (char === ']') {
      depth--
      if (depth === 0) return source.slice(start, index + 1)
    }
  }
  throw new Error(`批量快照 ${propertyName} 未闭合`)
}

export function parseEastmoneySnapshot(source, kind) {
  const rows = JSON.parse(extractArrayLiteral(source, 'datas'))
  const showdayMatch = source.match(/showday:\s*(\[[^\]]*\])/)
  const showdays = showdayMatch ? JSON.parse(showdayMatch[1]) : []
  const recordMatch = source.match(/record:\s*"?(\d+)/)

  if (kind === 'all') {
    const market = getBeijingMarketState()
    return {
      recordCount: Number(recordMatch?.[1] || rows.length),
      latestDate: showdays[0] || null,
      previousDate: showdays[1] || null,
      funds: rows.map(row => {
        const type = row[2] || ''
        const isMoneyMarket = type.includes('货币')
        const shortDate = row[4] || ''
        let navDate = null
        if (/^\d{2}-\d{2}$/.test(shortDate)) {
          let year = Number(market.date.slice(0, 4))
          if (Number(shortDate.slice(0, 2)) > Number(market.date.slice(5, 7)) + 6) year--
          navDate = `${year}-${shortDate}`
        }
        return {
          code: row[0],
          name: row[1],
          type,
          nav: isMoneyMarket ? 1 : (Number(row[3]) || null),
          accumulatedNav: null,
          previousNav: isMoneyMarket ? 1 : null,
          change: 0,
          changePercent: null,
          navDate,
          previousNavDate: null,
          perTenThousandIncome: isMoneyMarket ? (Number(row[3]) || null) : null,
          sevenDayAnnualized: null,
          purchaseStatus: row[5] || '',
          redemptionStatus: row[6] || '',
          isMoneyMarket
        }
      })
    }
  }

  if (kind === 'regular') {
    return {
      recordCount: Number(recordMatch?.[1] || rows.length),
      latestDate: showdays[0] || null,
      previousDate: showdays[1] || null,
      funds: rows.map(row => {
        const nav = Number(row[3]) || null
        const change = row[7] === '' || row[7] === null || row[7] === undefined ? null : Number(row[7])
        const changePercent = row[8] === '' || row[8] === null || row[8] === undefined ? null : Number(row[8])
        return {
          code: row[0],
          name: row[1],
          type: null,
          nav,
          accumulatedNav: Number(row[4]) || null,
          previousNav: Number(row[5]) || null,
          change: nav !== null && Number.isFinite(change) ? change : null,
          changePercent: nav !== null && Number.isFinite(changePercent) ? changePercent : null,
          navDate: nav !== null ? (showdays[0] || null) : null,
          ...(nav === null ? { pendingNavDate: showdays[0] || null } : {}),
          previousNavDate: showdays[1] || null,
          purchaseStatus: row[9] || '',
          redemptionStatus: row[10] || '',
          isMoneyMarket: false
        }
      })
    }
  }

  const market = getBeijingMarketState()
  return {
    recordCount: Number(recordMatch?.[1] || rows.length),
    latestDate: showdays[0] || null,
    previousDate: showdays[1] || null,
    funds: rows.map(row => {
      const shortDate = row[3] || ''
      let navDate = null
      if (/^\d{2}-\d{2}$/.test(shortDate)) {
        let year = Number(market.date.slice(0, 4))
        if (Number(shortDate.slice(0, 2)) > Number(market.date.slice(5, 7)) + 6) year--
        navDate = `${year}-${shortDate}`
      }
      return {
        code: row[0],
        name: row[1],
        type: '货币型',
        nav: 1,
        accumulatedNav: null,
        previousNav: 1,
        change: 0,
        changePercent: null,
        navDate,
        previousNavDate: null,
        perTenThousandIncome: Number(row[2]) || null,
        sevenDayAnnualized: Number(String(row[4] || '').replace('%', '')) || null,
        purchaseStatus: row[9] || '',
        redemptionStatus: '',
        isMoneyMarket: true
      }
    })
  }
}

function hydrateFundSnapshotCache(payload) {
  if (!payload?.funds || typeof payload.funds !== 'object') return false
  fundSnapshotIndex = new Map(Object.entries(payload.funds))
  fundSnapshotMetadata = payload.metadata || null
  setCache('fund-snapshots', payload, 24 * 60 * 60 * 1000)
  return true
}

export function getFundSnapshot(code) {
  if (!fundSnapshotIndex) {
    const payload = loadFromFile(FUND_SNAPSHOT_FILE)
    if (payload) hydrateFundSnapshotCache(payload)
  }
  return fundSnapshotIndex?.get(code) || null
}

export function getFundSnapshotMetadata() {
  if (!fundSnapshotMetadata) getFundSnapshot('__load__')
  return fundSnapshotMetadata
}

export async function refreshFullMarketSnapshots({ force = false } = {}) {
  if (fundSnapshotRefreshPromise) return fundSnapshotRefreshPromise
  if (!force && fundSnapshotMetadata?.refreshedAt) {
    const age = Date.now() - Date.parse(fundSnapshotMetadata.refreshedAt)
    if (age < 10 * 60 * 1000) return { metadata: fundSnapshotMetadata, skipped: true }
  }

  fundSnapshotRefreshPromise = (async () => {
    const common = 'letter=&gsid=&text=&sort=zdf,desc&page=1,50000'
    const headers = {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
      'Referer': 'https://fund.eastmoney.com/'
    }
    const nonce = Date.now()
    const [allResponse, regularResponse, moneyResponse] = await Promise.all([
      fetchUpstream(`https://fund.eastmoney.com/Data/Fund_JJJZ_Data.aspx?t=8&lx=1&${common}&dt=${nonce}`, {
        headers, retries: 2, timeoutMs: 20_000, dedupeKey: 'snapshot:all'
      }),
      fetchUpstream(`https://fund.eastmoney.com/Data/Fund_JJJZ_Data.aspx?t=1&lx=1&${common}&dt=${nonce}`, {
        headers, retries: 2, timeoutMs: 20_000, dedupeKey: 'snapshot:regular'
      }),
      fetchUpstream(`https://fund.eastmoney.com/Data/Fund_JJJZ_Data.aspx?t=7&lx=1&${common}&dt=${nonce}`, {
        headers, retries: 2, timeoutMs: 15_000, dedupeKey: 'snapshot:money'
      })
    ])
    const [allText, regularText, moneyText] = await Promise.all([
      allResponse.text(), regularResponse.text(), moneyResponse.text()
    ])
    const all = parseEastmoneySnapshot(allText, 'all')
    const regular = parseEastmoneySnapshot(regularText, 'regular')
    const money = parseEastmoneySnapshot(moneyText, 'money')
    const fundList = getFundList() || []
    const typeByCode = new Map(fundList.map(fund => [fund.code, fund.type]))
    const funds = {}

    // 全品种目录打底，普通基金与货币基金专用数据随后覆盖更精确字段。
    for (const snapshot of [...all.funds, ...regular.funds, ...money.funds]) {
      const type = typeByCode.get(snapshot.code) || snapshot.type || ''
      funds[snapshot.code] = { ...snapshot, type }
    }

    const payload = {
      metadata: {
        refreshedAt: new Date().toISOString(),
        latestDate: regular.latestDate,
        previousDate: regular.previousDate,
        allCount: all.funds.length,
        regularCount: regular.funds.length,
        moneyCount: money.funds.length,
        totalCount: Object.keys(funds).length
      },
      funds
    }
    saveToFile(FUND_SNAPSHOT_FILE, payload)
    hydrateFundSnapshotCache(payload)
    console.log(`[Cache] 全市场快照已更新: ${payload.metadata.totalCount} 只，净值日 ${regular.latestDate || '未知'}`)
    return payload
  })()

  try {
    return await fundSnapshotRefreshPromise
  } catch (error) {
    console.error(`[Cache] 全市场快照更新失败，继续使用旧缓存: ${error.message}`)
    const stale = loadFromFile(FUND_SNAPSHOT_FILE)
    if (stale) {
      hydrateFundSnapshotCache(stale)
      return { ...stale, stale: true, error: error.message }
    }
    throw error
  } finally {
    fundSnapshotRefreshPromise = null
  }
}

export function snapshotToEstimate(code, snapshot, listEntry, now = new Date()) {
  if (!snapshot) return null
  const nav = snapshot.nav || snapshot.previousNav
  if (!nav) return null
  const hasPublishedNav = Number(snapshot.nav) > 0
  const navDate = hasPublishedNav
    ? (snapshot.navDate || fundSnapshotMetadata?.latestDate || '')
    : (snapshot.previousNavDate || '')
  return {
    fundcode: code,
    name: snapshot.name || listEntry?.name || '',
    dwjz: Number(snapshot.previousNav || nav).toFixed(4),
    gsz: Number(nav).toFixed(4),
    gszzl: !hasPublishedNav || snapshot.changePercent === null || snapshot.changePercent === undefined
      ? '--'
      : Number(snapshot.changePercent).toFixed(2),
    gztime: navDate ? `${navDate} 15:00` : '',
    source: 'market_snapshot',
    realtime: false,
    // A Friday snapshot is usable for historical fallback on Monday, but it
    // must never be presented as Monday's post-close result.
    stale: navDate !== getBeijingMarketState(now).date,
    pending: !hasPublishedNav,
    fundType: snapshot.type || listEntry?.type || '',
    isMoneyMarket: Boolean(snapshot.isMoneyMarket),
    perTenThousandIncome: snapshot.perTenThousandIncome ?? null,
    sevenDayAnnualized: snapshot.sevenDayAnnualized ?? null
  }
}

/**
 * 抓取基金实时估值（批量）
 * [WHAT] 从 fundgz.1234567.com.cn 获取基金实时估值
 * @param {string[]} codes 基金代码数组
 */
function normalizeSinaDate(value) {
  const source = String(value || '').trim()
  const compact = source.match(/^(\d{4})(\d{2})(\d{2})$/)
  return compact ? `${compact[1]}-${compact[2]}-${compact[3]}` : source.replaceAll('/', '-')
}

export function parseSinaRealtimeEstimate(payload, code, fallback, listEntry, marketDate) {
  const points = payload?.result?.data?.networth
  if (!Array.isArray(points)) return null

  const point = [...points].reverse().find(item => {
    const nav = Number.parseFloat(String(item?.pre_nav ?? ''))
    return Number.isFinite(nav) && nav > 0 && normalizeSinaDate(item?.pre_date) === marketDate
  })
  if (!point) return null

  const nav = Number.parseFloat(String(point.pre_nav))
  const growthRate = Number.parseFloat(String(point.growthrate ?? ''))
  if (!Number.isFinite(nav) || !Number.isFinite(growthRate)) return null

  const estimateTime = String(point.min_time || '').trim()
  return {
    fundcode: code,
    name: fallback?.name || listEntry?.name || '',
    dwjz: fallback?.dwjz || Number(payload?.result?.data?.worth || nav).toFixed(4),
    gsz: nav.toFixed(4),
    gszzl: (growthRate * 100).toFixed(2),
    gztime: `${marketDate} ${estimateTime}`.trim(),
    source: 'sina_ds2',
    realtime: true,
    stale: false,
    fundType: fallback?.fundType || listEntry?.type || '',
    isMoneyMarket: false
  }
}

export async function fetchFundEstimates(codes, now = new Date()) {
  const results = {}

  const uniqueCodes = [...new Set(codes.filter(code => /^\d{6}$/.test(code)))]
  const fundList = getFundList() || []
  const fundByCode = new Map(fundList.map(fund => [fund.code, fund]))
  const market = getBeijingMarketState(now)
  const latestSnapshotDate = getFundSnapshotMetadata()?.latestDate
  const hasFreshSnapshot = isSnapshotFreshEnoughForTrading(latestSnapshotDate, now)

  await Promise.all(uniqueCodes.map(async code => {
    const cacheKey = `estimate:${code}`
    const cached = getCache(cacheKey)
    if (cached) {
      if (!cached.unavailable) results[code] = cached
      return
    }

    const listEntry = fundByCode.get(code)
    const estimateMarket = getFundEstimateMarketState(listEntry, now)
    const canUseRealtime = shouldFetchFundgzEstimateForFund(listEntry, now) && hasFreshSnapshot
    const snapshot = getFundSnapshot(code)
    const fallback = snapshotToEstimate(code, snapshot, listEntry, now)
    const isMoneyMarket = Boolean(snapshot?.isMoneyMarket || listEntry?.type?.includes('货币'))

    if (canUseRealtime && !isMoneyMarket) {
      try {
        const response = await fetchUpstream(`https://stock.finance.sina.com.cn/fundInfo/api/openapi.php/FdFundService.getEstimateNetworthPic?symbol=${code}`, {
          headers: {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
            'Referer': 'https://finance.sina.com.cn/'
          },
          retries: 1,
          timeoutMs: 6_000,
          dedupeKey: `estimate:${code}`
        })
        const parsed = parseSinaRealtimeEstimate(await response.json(), code, fallback, listEntry, market.date)
        if (!parsed) throw new Error('Current-day Sina estimate is unavailable')
        const match = [JSON.stringify(parsed), JSON.stringify(parsed)]
        if (!match) throw new Error('实时估值格式无效')
        const data = JSON.parse(match[1])
        const result = {
          ...data,
          name: data.name || fallback?.name || listEntry?.name || '',
          source: 'sina_ds2',
          realtime: true,
          stale: false,
          fundType: fallback?.fundType || listEntry?.type || '',
          isMoneyMarket: false
        }
        setCache(cacheKey, result, 20 * 1000)
        results[code] = result
        return
      } catch (error) {
        // A short negative cache prevents every client from retrying the same
        // unavailable symbol while the batch snapshot remains usable.
        if (!fallback) setCache(cacheKey, { unavailable: true }, 15 * 1000)
      }
    }

    if (fallback) {
      const snapshotIsCurrent = fallback.gztime.startsWith(market.date)
      const ttl = estimateMarket.isEstimateSession || estimateMarket.isOpen ? 60 * 1000 :
        market.isAfterClose && !snapshotIsCurrent ? 2 * 60 * 1000 : 30 * 60 * 1000
      setCache(cacheKey, fallback, ttl)
      results[code] = fallback
    }
  }))

  return results
}

export async function fetchStockQuotes(secids) {
  const results = await fetchEastmoneyStockQuotes(secids)
  const missingSecids = secids.filter(secid => !results[String(secid).split('.').slice(1).join('.')])
  if (missingSecids.length) {
    try {
      Object.assign(results, await fetchTencentStockQuotes(missingSecids))
    } catch (error) {
      console.error(`[Stock Quotes] Tencent fallback failed: ${error.message}`)
    }
  }
  await enrichOverseasQuoteProfiles(results, secids)
  return results
}

function tencentSymbolForSecid(secid) {
  const [prefix, ...symbolParts] = String(secid || '').split('.')
  const symbol = symbolParts.join('.')
  if (!symbol) return null
  if (prefix === '1') return `sh${symbol}`
  if (prefix === '0') return `sz${symbol}`
  if (prefix === '116') return `hk${symbol.padStart(5, '0')}`
  if (/^10[56]$/.test(prefix)) return `us${symbol}`
  if (prefix === 'kr') return `kr${symbol}`
  if (prefix === 'jp') return `jp${symbol}`
  return null
}

function overseasProfileCandidate(secid) {
  const [prefix, ...symbolParts] = String(secid || '').split('.')
  const symbol = symbolParts.join('.')
  if (!symbol) return null
  if (prefix === 'kr') return { market: 'kr', symbol }
  if (prefix === 'jp') return { market: 'jp', symbol }
  return null
}

function htmlText(value) {
  return String(value || '')
    .replace(/<[^>]*>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .trim()
}

export function parseNaverKoreanProfile(source, expectedSymbol) {
  const symbol = String(expectedSymbol || '').trim()
  if (!symbol || !String(source || '').includes(`code=${symbol}`)) return null
  const industry = htmlText(String(source).match(/업종명\s*:\s*<a[^>]*>([\s\S]*?)<\/a>/i)?.[1])
  const name = htmlText(String(source).match(new RegExp(`<a[^>]+code=${symbol}[^>]*>([\\s\\S]*?)<`, 'i'))?.[1])
  if (!industry) return null
  return {
    symbol,
    exchange: 'KRX',
    name,
    sector: null,
    industry: industry.includes('반도체') ? '半导体' : industry
  }
}

export function parseYahooJapanProfile(source, expectedSymbol) {
  const symbol = String(expectedSymbol || '').trim().toUpperCase()
  if (!symbol || !String(source || '').includes(`${symbol}.T`)) return null
  const industry = htmlText(String(source).match(/業種分類<\/th><td[^>]*>(?:<a[^>]*>)?([\s\S]*?)(?:<\/a>)?<\/td>/i)?.[1])
  const name = htmlText(String(source).match(/英文社名<\/th><td[^>]*>(?:<p>)?([\s\S]*?)(?:<\/p>)?<\/td>/i)?.[1])
  if (!industry) return null
  return {
    symbol: `${symbol}.T`,
    exchange: 'JPX',
    name,
    sector: null,
    industry: industry === '電気機器' ? '电子设备' : industry
  }
}

export async function fetchOverseasSecurityProfile(secid) {
  const candidate = overseasProfileCandidate(secid)
  if (!candidate) return null
  const cacheKey = `stock-profile:${candidate.market}:${candidate.symbol}`
  const cached = getCache(cacheKey)
  if (cached !== null) return cached
  try {
    const url = candidate.market === 'kr'
      ? `https://finance.naver.com/item/main.naver?code=${encodeURIComponent(candidate.symbol)}`
      : `https://finance.yahoo.co.jp/quote/${encodeURIComponent(candidate.symbol)}.T/profile`
    const response = await fetchUpstream(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        'Accept-Language': candidate.market === 'kr' ? 'ko-KR,ko;q=0.9,en;q=0.8' : 'ja-JP,ja;q=0.9,en;q=0.8'
      },
      retries: 1,
      timeoutMs: 8_000,
      dedupeKey: cacheKey
    })
    const source = await response.text()
    const profile = candidate.market === 'kr'
      ? parseNaverKoreanProfile(source, candidate.symbol)
      : parseYahooJapanProfile(source, candidate.symbol)
    setCache(cacheKey, profile, profile ? 7 * 24 * 60 * 60 * 1000 : 30 * 60 * 1000)
    return profile
  } catch (error) {
    console.warn(`[Stock Profile] ${candidate.market}.${candidate.symbol} unavailable: ${error.message}`)
    setCache(cacheKey, null, 5 * 60 * 1000)
    return null
  }
}

async function enrichOverseasQuoteProfiles(results, secids) {
  const requested = [...new Set(secids.map(value => String(value || '')))]
  await Promise.all(requested.map(async secid => {
    const [prefix, ...symbolParts] = secid.split('.')
    const symbol = symbolParts.join('.')
    if (!symbol || !['kr', 'jp'].includes(prefix)) return
    const profile = await fetchOverseasSecurityProfile(secid)
    if (!profile) return
    const current = results[symbol] || {}
    results[symbol] = {
      ...current,
      name: current.name || profile.name,
      sector: profile.industry || profile.sector || current.sector || null,
      source: current.source || (prefix === 'kr' ? 'tencent_kr' : 'tencent_jp'),
      sectorSource: prefix === 'kr' ? 'naver_finance' : 'yahoo_japan_finance'
    }
  }))
}

export function parseTencentStockQuotes(payload) {
  const text = typeof payload === 'string'
    ? payload
    : new TextDecoder('gb18030').decode(payload)
  const results = {}
  for (const [, , raw] of text.matchAll(/v_([^=]+)="([^"]*)"/g)) {
    const fields = raw.split('~')
    const code = String(fields[2] || '').trim().replace(/\.[A-Z]{1,4}$/i, '')
    const price = Number(fields[3])
    const previousClose = Number(fields[4])
    const providedChange = Number(fields[31])
    const providedPercent = Number(fields[32])
    if (!code || !Number.isFinite(price) || price <= 0) continue
    const change = Number.isFinite(providedChange)
      ? providedChange
      : Number.isFinite(previousClose) ? price - previousClose : null
    const changePercent = Number.isFinite(providedPercent)
      ? providedPercent
      : Number.isFinite(previousClose) && previousClose !== 0
        ? (price - previousClose) / previousClose * 100
        : null
    results[code] = {
      name: String(fields[1] || '').trim(),
      price,
      change,
      changePercent,
      sector: null,
      source: 'tencent'
    }
  }
  return results
}

export async function fetchTencentStockQuotes(secids) {
  const symbols = secids.map(tencentSymbolForSecid).filter(Boolean)
  if (!symbols.length) return {}
  const response = await fetchUpstream(`https://qt.gtimg.cn/q=${symbols.join(',')}`, {
    headers: {
      'User-Agent': 'Mozilla/5.0',
      'Referer': 'https://gu.qq.com/'
    },
    retries: 1,
    timeoutMs: 8_000,
    dedupeKey: `stock-quotes:tencent:${symbols.join(',')}`
  })
  return parseTencentStockQuotes(await response.arrayBuffer())
}

/**
 * 抓取基金排行数据
 * [WHAT] 从 fund.eastmoney.com/data/rankhandler.aspx 获取排行
 * @param {object} params 排行参数
 */
export async function fetchFundRank(params = {}) {
  const {
    ft = 'gp',       // gp=股票型, hh=混合型, zq=债券型, zs=指数型, qdii=QDII, fof=FOF
    sc = '1nzf',     // 排序字段
    st = 'desc',     // 排序方向
    pi = 1,          // 页码
    pn = 50,         // 每页数量
    cp = '',         // 自定义列
    ct = '',         // 持续期
    cd = '',         // 代码
    ms = '',         // 规模
    fr = '',         // 回报
    ft1 = '',        // 类型筛选
  } = params

  const cacheKey = `rank:${ft}:${sc}:${st}:${pi}:${pn}`
  const cached = getCache(cacheKey)
  if (cached) return cached

  try {
    const url = `https://fund.eastmoney.com/data/rankhandler.aspx?op=ph&dt=kf&ft=${ft}&rs=&gs=0&sc=${sc}&st=${st}&pi=${pi}&pn=${pn}&dx=1&v=${Date.now()}`
    const response = await fetchUpstream(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        'Referer': 'https://fund.eastmoney.com/data/fundranking.html'
      },
      retries: 1,
      timeoutMs: 8_000,
      dedupeKey: cacheKey
    })
    const text = await response.text()

    // 解析 var rankData = {datas:[...], ...}
    const datasMatch = text.match(/datas:\[(.*?)\]/s)
    if (!datasMatch) return null

    const datas = [...datasMatch[1].matchAll(/"([^\"]+)"/g)].map(match => match[1])
    const records = datas.map(item => {
      const fields = item.split(',')
      return {
        code: fields[0],         // 基金代码
        name: fields[1],         // 基金名称
        date: fields[3],         // 净值日期 (修正：原fields[4])
        unitNav: fields[4],      // 单位净值 (修正：原fields[5])
        accumNav: fields[5],     // 累计净值 (修正：原fields[6])
        dailyReturn: fields[7],  // 日增长率
        weekReturn: fields[8],   // 近1周
        monthReturn: fields[9],  // 近1月
        threeMonthReturn: fields[10], // 近3月
        sixMonthReturn: fields[11],   // 近6月
        yearReturn: fields[12],       // 近1年
        twoYearReturn: fields[13],    // 近2年
        threeYearReturn: fields[14],  // 近3年
        ytdReturn: fields[15],        // 今年来
        sinceInception: fields[16],   // 成立来
      }
    }).filter(record => /^\d{6}$/.test(record.code) && record.name)

    // 提取总数
    const totalMatch = text.match(/allRecords:(\d+)/)
    const total = totalMatch ? parseInt(totalMatch[1]) : records.length

    const result = { records, total, page: pi, pageSize: pn }

    // 缓存 10 分钟
    setCache(cacheKey, result, 10 * 60 * 1000)

    return result

  } catch (error) {
    console.error(`[Cache] 获取排行数据失败: ${error.message}`)
    return null
  }
}

/**
 * 抓取大盘指数数据
 * [WHAT] 从 push2.eastmoney.com 获取主要指数行情
 */
const MARKET_INDEX_NAMES = Object.freeze({
  '000001': '上证指数',
  '000016': '上证50',
  '000852': '中证1000',
  '000906': '中证800',
  '000922': '中证红利',
  '000932': '中证消费',
  '000933': '中证医药',
  '000991': '全指医药',
  '399001': '深证成指',
  '399005': '中小100',
  '399330': '深证100',
  '399006': '创业板指',
  '399303': '国证2000',
  '399673': '创业板50',
  '399808': '中证新能源',
  '399967': '中证军工',
  '399975': '证券公司',
  '399986': '中证银行',
  '399989': '中证医疗',
  '399997': '中证白酒',
  '931152': '创新药',
  '931632': '中证黄金股',
  '899050': '北证50',
  '000300': '沪深300',
  '000688': '科创50',
  '000905': '中证500',
  HSI: '恒生指数',
  HSCEI: '恒生国企',
  HSTECH: '恒生科技',
  HSIII: '恒生互联网科技业指数',
  DJI: '道琼斯',
  INX: '标普500',
  IXIC: '纳斯达克',
  NDX: '纳斯达克100',
  FTSE: '富时100',
  FCHI: '法国CAC40',
  GDAXI: '德国DAX',
  N225: '日经225',
  TPX: '东证指数',
  KS11: '韩国综合',
  KOSDAQ: '韩国创业板'
})

const MARKET_INDEX_CATALOG = Object.freeze([
  { code: '399001', market: 'cn', source: 'em', secid: '0.399001' },
  { code: '399005', market: 'cn', source: 'em', secid: '0.399005' },
  { code: '399006', market: 'cn', source: 'em', secid: '0.399006' },
  { code: '399303', market: 'cn', source: 'em', secid: '0.399303' },
  { code: '399673', market: 'cn', source: 'em', secid: '0.399673' },
  { code: '399808', market: 'cn', source: 'em', secid: '0.399808' },
  { code: '399967', market: 'cn', source: 'em', secid: '0.399967' },
  { code: '399975', market: 'cn', source: 'em', secid: '0.399975' },
  { code: '399986', market: 'cn', source: 'em', secid: '0.399986' },
  { code: '399989', market: 'cn', source: 'em', secid: '0.399989' },
  { code: '399997', market: 'cn', source: 'em', secid: '0.399997' },
  { code: '931152', market: 'cn', source: 'em', secid: '2.931152' },
  { code: '931632', market: 'cn', source: 'em', secid: '2.931632' },
  { code: '000001', market: 'cn', source: 'em', secid: '1.000001' },
  { code: '000016', market: 'cn', source: 'em', secid: '1.000016' },
  { code: '000300', market: 'cn', source: 'em', secid: '1.000300' },
  { code: '000905', market: 'cn', source: 'em', secid: '1.000905' },
  { code: '000852', market: 'cn', source: 'em', secid: '1.000852' },
  { code: '000688', market: 'cn', source: 'em', secid: '1.000688' },
  { code: '000932', market: 'cn', source: 'em', secid: '1.000932' },
  { code: '000933', market: 'cn', source: 'em', secid: '1.000933' },
  { code: '000922', market: 'cn', source: 'em', secid: '1.000922' },
  { code: '000906', market: 'cn', source: 'em', secid: '1.000906' },
  { code: '000991', market: 'cn', source: 'em', secid: '1.000991' },
  { code: '399330', market: 'cn', source: 'em', secid: '0.399330' },
  { code: '899050', market: 'cn', source: 'em', secid: '0.899050' },
  { code: 'HSI', market: 'hk', source: 'tencent', symbol: 'hkHSI' },
  { code: 'HSTECH', market: 'hk', source: 'tencent', symbol: 'hkHSTECH' },
  { code: 'HSIII', market: 'hk', source: 'sina', symbol: 'rt_hkHSIII' },
  { code: 'HSCEI', market: 'hk', source: 'tencent', symbol: 'hkHSCEI' },
  { code: 'DJI', market: 'us', source: 'tencent', symbol: 'usDJI' },
  { code: 'INX', market: 'us', source: 'tencent', symbol: 'usINX' },
  { code: 'IXIC', market: 'us', source: 'tencent', symbol: 'usIXIC' },
  { code: 'NDX', market: 'us', source: 'tencent', symbol: 'usNDX' },
  { code: 'FTSE', market: 'global', source: 'tencent', symbol: 'gzFTSE' },
  { code: 'FCHI', market: 'global', source: 'tencent', symbol: 'gzFCHI' },
  { code: 'GDAXI', market: 'global', source: 'tencent', symbol: 'gzGDAXI' },
  { code: 'N225', market: 'global', source: 'tencent', symbol: 'gzN225' },
  { code: 'TPX', market: 'global', source: 'tencent', symbol: 'gzTPX' },
  { code: 'KS11', market: 'global', source: 'tencent', symbol: 'gzKS11' },
  { code: 'KOSDAQ', market: 'global', source: 'tencent', symbol: 'gzKOSDAQ' }
])

function marketForIndex(code) {
  return MARKET_INDEX_CATALOG.find(item => item.code === String(code || ''))?.market || 'global'
}

function tencentSymbolForIndex(definition) {
  if (definition.source === 'tencent') return definition.symbol
  if (definition.market !== 'cn') return null
  if (definition.code.startsWith('399')) return `sz${definition.code}`
  if (definition.code.startsWith('899')) return `bj${definition.code}`
  return `sh${definition.code}`
}

export function normalizeMarketIndexName(code, name) {
  return MARKET_INDEX_NAMES[String(code || '')] || String(name || '').trim()
}

export async function fetchMarketIndices() {
  const cacheKey = 'market:indices'
  const cached = getCache(cacheKey)
  if (cached) return cached

  try {
    const mainland = MARKET_INDEX_CATALOG.filter(item => item.source === 'em')
    const tencentIndices = MARKET_INDEX_CATALOG
      .map(item => ({ ...item, tencentSymbol: tencentSymbolForIndex(item) }))
      .filter(item => item.tencentSymbol)
    const sina = MARKET_INDEX_CATALOG.filter(item => item.source === 'sina')
    const [mainlandResult, internationalResult, sinaResult] = await Promise.allSettled([
      fetchUpstream(`https://push2.eastmoney.com/api/qt/ulist.np/get?fltt=2&secids=${mainland.map(item => item.secid).join(',')}&fields=f2,f3,f4,f6,f12,f14`, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
          'Referer': 'https://quote.eastmoney.com/'
        },
        retries: 1,
        timeoutMs: 5_000,
        dedupeKey: 'market:indices:cn'
      }).then(response => response.json()),
      fetchUpstream(`https://qt.gtimg.cn/q=${tencentIndices.map(item => item.tencentSymbol).join(',')}`, {
        headers: { 'User-Agent': 'Mozilla/5.0' },
        retries: 1,
        timeoutMs: 5_000,
        dedupeKey: 'market:indices:international'
      }).then(response => response.arrayBuffer()),
      fetchUpstream(`https://hq.sinajs.cn/list=${sina.map(item => item.symbol).join(',')}`, {
        headers: {
          'User-Agent': 'Mozilla/5.0',
          'Referer': 'https://finance.sina.com.cn/'
        },
        retries: 1,
        timeoutMs: 5_000,
        dedupeKey: 'market:indices:sina'
      }).then(response => response.arrayBuffer())
    ])

    const byCode = new Map()
    if (mainlandResult.status === 'fulfilled' && Array.isArray(mainlandResult.value?.data?.diff)) {
      for (const item of mainlandResult.value.data.diff) {
        const code = String(item.f12 || '')
        if (!code) continue
        byCode.set(code, {
          code,
          name: normalizeMarketIndexName(code, item.f14),
          price: Number(item.f2),
          change: Number(item.f4),
          changePercent: Number(item.f3),
          volume: Number.isFinite(Number(item.f6)) ? Number(item.f6) : null,
          market: marketForIndex(code)
        })
      }
    }
    if (internationalResult.status === 'fulfilled') {
      const quotes = new Map(parseTencentIndexQuotes(internationalResult.value).map(quote => [quote.symbol, quote]))
      for (const definition of tencentIndices) {
        const quote = quotes.get(definition.tencentSymbol)
        if (!quote || byCode.has(definition.code)) continue
        byCode.set(definition.code, {
          code: definition.code,
          name: normalizeMarketIndexName(definition.code, quote.name),
          price: quote.price,
          change: quote.change,
          changePercent: quote.changePercent,
          volume: quote.volume,
          market: definition.market
        })
      }
    }
    if (sinaResult.status === 'fulfilled') {
      const quotes = new Map(parseSinaIndexQuotes(sinaResult.value).map(quote => [quote.symbol, quote]))
      for (const definition of sina) {
        const quote = quotes.get(definition.symbol)
        if (!quote) continue
        byCode.set(definition.code, {
          code: definition.code,
          name: normalizeMarketIndexName(definition.code, quote.name),
          price: quote.price,
          change: quote.change,
          changePercent: quote.changePercent,
          volume: quote.volume,
          market: definition.market
        })
      }
    }

    const indices = MARKET_INDEX_CATALOG.map(item => byCode.get(item.code)).filter(Boolean)
    if (indices.length) {
      saveToFile('market-indices.json', indices)
      setCache(cacheKey, indices, 2 * 1000) // shared quote cache for the SSE index stream
      return indices
    }

    throw new Error('指数响应不包含有效数据')
  } catch (error) {
    console.error(`[Cache] 获取大盘指数失败: ${error.message}`)
    const fallback = loadFromFile('market-indices.json')
    const indices = Array.isArray(fallback)
      ? fallback.map(index => ({ ...index, name: normalizeMarketIndexName(index?.code, index?.name), market: index?.market || marketForIndex(index?.code) }))
      : []
    setCache(cacheKey, indices, indices.length ? 5 * 60 * 1000 : 15 * 1000)
    return indices
  }
}

/**
 * 抓取基金排行（通过 push2 API，适合 ETF/LOF 场内基金）
 */
const HSTECH_CANONICAL_NAME = '恒生科技'

/** Decode Tencent's byte response explicitly because its charset header is unreliable. */
export function parseTencentIndexQuote(payload) {
  const text = typeof payload === 'string'
    ? payload
    : new TextDecoder('utf-8').decode(payload)
  const fields = text.match(/="([^"]*)"/)?.[1]?.split('~')
  if (!fields?.[1] || !fields[3] || !fields[31] || !fields[32]) return null

  const upstreamName = fields[1].replace(/指数$/, '').trim()
  const name = upstreamName.includes('�') || !/[\u3400-\u9fff]/.test(upstreamName)
    ? HSTECH_CANONICAL_NAME
    : upstreamName
  const price = Number(fields[3])
  const change = Number(fields[31])
  const changePercent = Number(fields[32])
  if (![price, change, changePercent].every(Number.isFinite)) return null

  return {
    name,
    price,
    change,
    changePercent,
    volume: Number.isFinite(Number(fields[6])) ? Number(fields[6]) : null
  }
}

/** Tencent uses a compact six-field layout for its global index feed. */
export function parseTencentIndexQuotes(payload) {
  const text = typeof payload === 'string'
    ? payload
    : new TextDecoder('utf-8').decode(payload)

  return [...text.matchAll(/v_([^=]+)="([^"]*)"/g)].map(([, symbol, raw]) => {
    const fields = raw.split('~')
    if (/^gz/.test(symbol)) {
      const price = Number(fields[3])
      const change = Number(fields[4])
      const changePercent = Number(fields[5])
      if (![price, change, changePercent].every(Number.isFinite)) return null
      return { symbol, name: fields[1]?.trim() || fields[0], price, change, changePercent, volume: null }
    }

    const price = Number(fields[3])
    const change = Number(fields[31])
    const changePercent = Number(fields[32])
    if (!fields[1] || ![price, change, changePercent].every(Number.isFinite)) return null
    return {
      symbol,
      name: fields[1].replace(/指数$/, '').trim(),
      price,
      change,
      changePercent,
      volume: Number.isFinite(Number(fields[6])) ? Number(fields[6]) : null
    }
  }).filter(Boolean)
}

/** Sina's Hong Kong index feed is GB18030 and uses current/change/percent at fields 6/7/8. */
export function parseSinaIndexQuotes(payload) {
  const text = typeof payload === 'string'
    ? payload
    : new TextDecoder('gb18030').decode(payload)

  return [...text.matchAll(/var hq_str_([^=]+)="([^"]*)"/g)].map(([, symbol, raw]) => {
    const fields = raw.split(',')
    if (!fields[1] || !fields[6] || !fields[7] || !fields[8]) return null
    const price = Number(fields[6])
    const change = Number(fields[7])
    const changePercent = Number(fields[8])
    if (![price, change, changePercent].every(Number.isFinite)) return null
    return {
      symbol,
      name: fields[1].trim(),
      price,
      change,
      changePercent,
      volume: Number.isFinite(Number(fields[11])) ? Number(fields[11]) : null
    }
  }).filter(Boolean)
}

export async function fetchOTCFundRank(params = {}) {
  const {
    pageSize = 50,
    order = 1,       // 1=升序, 0=降序
    page = 1
  } = params

  const cacheKey = `otc:rank:${page}:${pageSize}:${order}`
  const cached = getCache(cacheKey)
  if (cached) return cached

  try {
    const url = `http://push2.eastmoney.com/api/qt/clist/get?pn=${page}&pz=${pageSize}&po=${order}&np=1&fltt=2&invt=2&fid=f3&fs=b:MK0021,b:MK0022&fields=f2,f3,f4,f12,f14&_=${Date.now()}`
    const response = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        'Referer': 'https://quote.eastmoney.com/'
      }
    })
    const data = await response.json()

    if (data?.data?.diff) {
      const result = {
        records: data.data.diff,
        total: data.data.total
      }
      setCache(cacheKey, result, 2 * 60 * 1000) // 2分钟缓存
      return result
    }

    return null
  } catch (error) {
    console.error(`[Cache] 获取场内基金排行失败: ${error.message}`)
    return null
  }
}

// ========== 启动时预热 ==========

/**
 * 预热缓存：启动时加载常用数据
 */
export async function warmupCache() {
  console.log('[Cache] 开始预热缓存...')

  try {
    // 1. 加载基金列表
    const list = getFundList()
    if (!list) {
      await fetchFullFundList()
    } else {
      console.log(`[Cache] 基金列表已缓存: ${list.length} 只`)
    }

    // 2. 加载全市场最近净值快照。该批量源每轮仅需三个请求，
    // 避免对两万多只基金逐只预热造成上游限流。
    const persistedSnapshots = loadFromFile(FUND_SNAPSHOT_FILE)
    if (persistedSnapshots) hydrateFundSnapshotCache(persistedSnapshots)
    await refreshFullMarketSnapshots()

    // 3. 仅在真实交易窗口加载大盘指数。
    if (getBeijingMarketState().isOpen) {
      await fetchMarketIndices()
      console.log('[Cache] 大盘指数已加载')
    }

    console.log('[Cache] 预热完成 ✅')
  } catch (error) {
    console.error(`[Cache] 预热失败: ${error.message}`)
  }
}

/**
 * 抓取行业板块数据
 * [WHAT] 从 push2.eastmoney.com 获取行业板块涨跌
 * [FIX] 改用 HTTPS + 超时控制 + 重试机制 + 详细日志
 */
export async function fetchSectorRank(limit = 20, sectorType = 'industry', sortBy = 'change', sortOrder = 'desc', forceRefresh = false) {
  const type = sectorType === 'concept' ? 'concept' : 'industry'
  const sort = sortBy === 'flow' ? 'flow' : 'change'
  const order = sortOrder === 'asc' ? 'asc' : 'desc'
  const pageSize = Math.min(Math.max(Number(limit) || 20, 1), 500)
  const snapshotKey = `sector:snapshot:${type}`
  const fs = type === 'concept' ? 'm:90+t:3' : 'm:90+t:2'
  const dataFile = `sector-rank-${type}.json`
  let liveSectors = forceRefresh ? null : getCache(snapshotKey)

  if (!liveSectors && !forceRefresh) {
    const storedSectors = await getStoredSectorQuotes(type)
    if (storedSectors?.length) {
      liveSectors = storedSectors
      setCache(snapshotKey, liveSectors, getBeijingMarketState().isOpen ? 5 * 1000 : 60 * 1000)
      // Keep the first response fast after a proxy restart while the full
      // Eastmoney list is refreshed in the background.
      if (!sectorSnapshotRefreshPromises.has(type)) {
        const refresh = fetchSectorRank(500, type, 'change', 'desc', true)
          .catch(error => console.error(`[Cache] ${type} sector refresh failed: ${error.message}`))
          .finally(() => sectorSnapshotRefreshPromises.delete(type))
        sectorSnapshotRefreshPromises.set(type, refresh)
      }
    }
  }

  if (!liveSectors) {
    try {
      const hosts = ['push2delay.eastmoney.com', 'push2.eastmoney.com']
      const fetchPage = async page => {
        let lastError = null
        const path = `/api/qt/clist/get?pn=${page}&pz=100&po=1&np=1&fltt=2&invt=2&fid=f3&fs=${encodeURIComponent(fs)}&fields=f2,f3,f4,f12,f14,f62`
        for (const host of hosts) {
          try {
            const response = await fetchUpstream(`https://${host}${path}`, {
              headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
                'Referer': 'https://quote.eastmoney.com/',
                'Accept': 'application/json'
              },
              retries: 1,
              timeoutMs: 6_000,
              dedupeKey: `${snapshotKey}:${host}:${page}`
            })
            const candidate = await response.json()
            if (Array.isArray(candidate?.data?.diff)) return candidate
            lastError = new Error(`${host} 返回了无效板块数据`)
          } catch (error) {
            lastError = error
          }
        }
        throw lastError || new Error('所有东方财富板块数据源不可用')
      }

      const firstPage = await fetchPage(1)
      const total = Math.min(Number(firstPage?.data?.total) || firstPage.data.diff.length, 500)
      const pageCount = Math.max(1, Math.ceil(total / 100))
      const remainingPages = await Promise.all(
        Array.from({ length: pageCount - 1 }, (_, index) => fetchPage(index + 2))
      )
      const rows = [firstPage, ...remainingPages].flatMap(page => page.data.diff)
      liveSectors = rows.map(item => ({
        code: item.f12 || '',
        name: item.f14 || '',
        dayReturn: Number(item.f3) || 0,
        netInflow: Number(item.f62) || 0,
        type,
        classification: type === 'concept' ? 'eastmoney_concept' : 'shenwan_l3',
        updatedAt: new Date().toISOString(),
        source: 'eastmoney'
      })).filter(sector => sector.code && sector.name)
      if (liveSectors.length) saveToFile(dataFile, liveSectors)
      // During the continuous A-share session the page polls this snapshot
      // every few seconds. Keep one shared five-second snapshot so multiple
      // clients do not fan out into duplicate Eastmoney list requests.
      const sectorTtl = getBeijingMarketState().isOpen ? 5 * 1000 : 60 * 1000
      setCache(snapshotKey, liveSectors, liveSectors.length ? sectorTtl : 30 * 1000)
      if (liveSectors.length) {
        storeSectorQuotes(type, liveSectors).catch(error => {
          console.error(`[Cache] ${type} sector database cache write failed: ${error.message}`)
        })
      }
    } catch (error) {
      console.error(`[Cache] ${type}板块获取失败，使用最后有效快照: ${error.message}`)
      const fallback = loadFromFile(dataFile) || (type === 'industry' ? loadFromFile('sector-rank.json') : null)
      liveSectors = Array.isArray(fallback) ? fallback : []
      setCache(snapshotKey, liveSectors, liveSectors.length ? 5 * 60 * 1000 : 30 * 1000)
    }
  }

  // The persisted topic universe defines the product's curated sector set.
  // Live Eastmoney quotes enrich it with current return and fund-flow values.
  const sectors = mergeSectorUniverse(await fetchSectorUniverse(), liveSectors, type)
  const valueOf = sector => sort === 'flow' ? Number(sector.netInflow) || 0 : Number(sector.dayReturn) || 0
  const sorted = [...sectors].sort((left, right) => {
    const delta = valueOf(right) - valueOf(left)
    return order === 'desc' ? delta : -delta
  })
  console.log(`[Cache] ${type}板块: ${sorted.length} 条，${sort}/${order}`)
  return sorted.slice(0, pageSize)
}

function normalizeBoardCode(value) {
  const code = String(value || '').trim().toUpperCase()
  return /^BK\d{4,}$/.test(code) ? code : ''
}

function eastmoneyHeaders() {
  return {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
    Referer: 'https://quote.eastmoney.com/',
    Accept: 'application/json'
  }
}

async function fetchBoardUpstream(path, dedupeKey, isUsable = () => true) {
  let lastError = null
  for (const host of ['push2delay.eastmoney.com', 'push2.eastmoney.com', 'push2his.eastmoney.com']) {
    try {
      const response = await fetchUpstream(`https://${host}${path}`, {
        headers: eastmoneyHeaders(),
        retries: 1,
        timeoutMs: 6_000,
        dedupeKey: `${dedupeKey}:${host}`
      })
      const payload = await response.json()
      if (isUsable(payload)) return payload
      lastError = new Error(`${host} returned an empty board series`)
    } catch (error) {
      lastError = error
    }
  }
  throw lastError || new Error('东方财富板块数据源不可用')
}

function asNumberOrNull(value, divisor = 1) {
  if (value === null || value === undefined || value === '') return null
  const number = Number(value)
  return Number.isFinite(number) ? number / divisor : null
}

function asDateString(value) {
  const date = String(value || '')
  return /^\d{8}$/.test(date) ? `${date.slice(0, 4)}-${date.slice(4, 6)}-${date.slice(6, 8)}` : ''
}

function buildBoardConstituents(rows) {
  return (Array.isArray(rows) ? rows : []).map(row => ({
    code: String(row.f12 || ''),
    name: String(row.f14 || ''),
    price: asNumberOrNull(row.f2),
    changePercent: asNumberOrNull(row.f3),
    turnover: asNumberOrNull(row.f8),
    volume: asNumberOrNull(row.f6),
    market: String(row.f13 || '')
  })).filter(row => row.code && row.name)
}

async function fetchBoardConstituents(boardCode) {
  const cacheKey = `sector:constituents:${boardCode}`
  const cached = getCache(cacheKey)
  if (cached) return cached
  const query = new URLSearchParams({
    pn: '1', pz: '100', po: '1', np: '1', fltt: '2', invt: '2', fid: 'f3',
    fs: `b:${boardCode}`,
    fields: 'f2,f3,f4,f5,f6,f8,f12,f13,f14,f15,f16,f17,f18'
  })
  const first = await fetchBoardUpstream(`/api/qt/clist/get?${query.toString()}`, `sector:constituents:${boardCode}:1`)
  const total = Math.min(Math.max(Number(first?.data?.total) || 0, 0), 500)
  const pages = Math.min(Math.ceil(total / 100), 5)
  const rest = pages > 1
    ? await Promise.all(Array.from({ length: pages - 1 }, (_, index) => {
      const pageQuery = new URLSearchParams(query)
      pageQuery.set('pn', String(index + 2))
      return fetchBoardUpstream(`/api/qt/clist/get?${pageQuery.toString()}`, `sector:constituents:${boardCode}:${index + 2}`)
    }))
    : []
  const rows = [first, ...rest].flatMap(page => page?.data?.diff || [])
  const constituents = buildBoardConstituents(rows)
  const result = { total: total || constituents.length, constituents }
  setCache(cacheKey, result, 60 * 1000)
  return result
}

function mapTrendPoints(payload, period) {
  if (period === '1d') {
    return (payload?.data?.trends || []).map(row => {
      const fields = String(row).split(',')
      return { time: fields[0] || '', value: asNumberOrNull(fields[2]), netInflow: null }
    }).filter(point => point.time && point.value !== null)
  }
  return (payload?.data?.klines || []).map(row => {
    const fields = String(row).split(',')
    return { time: fields[0] || '', value: asNumberOrNull(fields[2]), netInflow: null }
  }).filter(point => point.time && point.value !== null)
}

function mapFundFlowPoints(payload) {
  return (payload?.data?.klines || []).map(row => {
    const fields = String(row).split(',')
    return { time: fields[0] || '', netInflow: asNumberOrNull(fields[1]) }
  }).filter(point => point.time && point.netInflow !== null)
}

function mergeTrendFundFlow(trendPoints, fundFlowPoints) {
  const flowByTime = new Map(fundFlowPoints.map(point => [point.time, point.netInflow]))
  return trendPoints.map(point => ({
    ...point,
    netInflow: flowByTime.get(point.time) ?? null
  }))
}

async function fetchBoardFundFlow(boardCode, period) {
  const secid = `90.${boardCode}`
  const fields1 = 'f1,f2,f3,f7'
  const fields2 = 'f51,f52,f53,f54,f55,f56,f57,f58,f59,f60,f61,f62,f63,f64,f65'

  if (period === '1d') {
    const query = new URLSearchParams({ secid, fields1, fields2, klt: '1', lmt: '0' })
    const payload = await fetchBoardUpstream(
      `/api/qt/stock/fflow/kline/get?${query.toString()}`,
      `sector:flow:${boardCode}:1d`,
      candidate => Array.isArray(candidate?.data?.klines) && candidate.data.klines.length > 0
    )
    return mapFundFlowPoints(payload)
  }

  const limit = period === '1m' ? 24 : period === '3m' ? 72 : 250
  // Eastmoney retains roughly 120 daily fund-flow records even when its quote
  // endpoint supplies a full-year price series.
  const minimumAvailable = period === '1y' ? 90 : limit
  const query = new URLSearchParams({ secid, fields1, fields2, klt: '101', lmt: String(limit) })
  const payload = await fetchBoardUpstream(
    `/api/qt/stock/fflow/daykline/get?${query.toString()}`,
    `sector:flow:${boardCode}:${period}`,
    candidate => Array.isArray(candidate?.data?.klines) && candidate.data.klines.length >= minimumAvailable
  )
  return mapFundFlowPoints(payload)
}

async function fetchBoardTrend(boardCode, period) {
  const secid = `90.${boardCode}`
  const fundFlowPromise = fetchBoardFundFlow(boardCode, period).catch(error => {
    console.error(`[Cache] 板块资金流向获取失败: ${error.message}`)
    return []
  })

  if (period === '1d') {
    const query = new URLSearchParams({
      secid,
      fields1: 'f1,f2,f3,f4,f5,f6,f7,f8,f9,f10,f11,f12,f13',
      fields2: 'f51,f52,f53,f54,f55,f56,f57,f58',
      iscr: '0', iscca: '0', ndays: '1'
    })
    const [payload, fundFlowPoints] = await Promise.all([
      fetchBoardUpstream(
        `/api/qt/stock/trends2/get?${query.toString()}`,
        `sector:trend:${boardCode}:1d`,
        candidate => Array.isArray(candidate?.data?.trends) && candidate.data.trends.length > 0
      ),
      fundFlowPromise
    ])
    return mergeTrendFundFlow(mapTrendPoints(payload, period), fundFlowPoints)
  }

  const limit = period === '1m' ? 24 : period === '3m' ? 72 : 250
  const query = new URLSearchParams({
    secid,
    fields1: 'f1,f2,f3,f4,f5,f6',
    fields2: 'f51,f52,f53,f54,f55,f56,f57,f58,f59,f60,f61',
    klt: '101', fqt: '0', beg: '0', end: '20500101', lmt: String(limit)
  })
  const [payload, fundFlowPoints] = await Promise.all([
    fetchBoardUpstream(
      `/api/qt/stock/kline/get?${query.toString()}`,
      `sector:trend:${boardCode}:${period}`,
      candidate => Array.isArray(candidate?.data?.klines) && candidate.data.klines.length > 0
    ),
    fundFlowPromise
  ])
  return mergeTrendFundFlow(mapTrendPoints(payload, period).slice(-limit), fundFlowPoints)
}

function snapshotForCode(snapshotSource, code) {
  if (typeof snapshotSource === 'function') return snapshotSource(code)
  if (snapshotSource instanceof Map) return snapshotSource.get(code)
  return snapshotSource?.[code] || null
}

/**
 * Reverse-match board constituents against the small on-disk cache of fund
 * holdings. This is intentionally cache-only: a sector request must never
 * fan out into a full-market fund-holdings crawl.
 */
export function findRelatedFundsFromConstituentHoldings(
  constituents,
  persistedHoldings = loadFromFile('fund-holdings-cache.json'),
  fundList = getFundList(),
  snapshotSource = getFundSnapshot
) {
  const stockCodes = new Set((Array.isArray(constituents) ? constituents : [])
    .map(stock => String(stock?.code || stock?.stockCode || ''))
    .filter(code => /^\d{6}$/.test(code)))
  if (!stockCodes.size || !persistedHoldings?.entries) return []

  const listByCode = new Map((Array.isArray(fundList) ? fundList : [])
    .map(fund => [String(fund.code || ''), fund]))
  const matches = []
  for (const [key, entry] of Object.entries(persistedHoldings.entries)) {
    const data = entry?.data
    const code = String(data?.code || key || '')
    if (!/^\d{6}$/.test(code) || !Array.isArray(data?.holdings)) continue

    const matchedHoldings = data.holdings.filter(holding => stockCodes.has(String(holding?.stockCode || '')))
    if (!matchedHoldings.length) continue
    const matchedHoldingRatio = matchedHoldings.reduce((total, holding) => total + (asNumberOrNull(holding?.holdingRatio) || 0), 0)
    const snapshot = snapshotForCode(snapshotSource, code)
    const listed = listByCode.get(code)
    matches.push({
      code,
      name: String(snapshot?.name || listed?.name || data.name || code),
      unitNav: asNumberOrNull(snapshot?.nav ?? snapshot?.previousNav),
      dailyReturn: asNumberOrNull(snapshot?.changePercent),
      navDate: String(snapshot?.navDate || getFundSnapshotMetadata()?.latestDate || ''),
      relatedIndex: '',
      relatedSource: 'constituent_holdings',
      relatedMatchCount: matchedHoldings.length,
      relatedHoldingRatio: matchedHoldingRatio,
      reportDate: String(data.reportDate || '')
    })
  }

  return matches
    .sort((a, b) => b.relatedMatchCount - a.relatedMatchCount || b.relatedHoldingRatio - a.relatedHoldingRatio || a.code.localeCompare(b.code))
    .slice(0, 30)
}

function buildFundLookup(fundList) {
  return new Map((Array.isArray(fundList) ? fundList : [])
    .map(fund => [String(fund.code || ''), fund]))
}

/** Aggregate the latest fund-holder rows for each constituent stock. */
export function buildConstituentFundMatches(holderRowsByStock, fundList = getFundList(), snapshotSource = getFundSnapshot) {
  const candidates = new Map()
  for (const [stockCode, rows] of Object.entries(holderRowsByStock || {})) {
    const fundRows = (Array.isArray(rows) ? rows : []).filter(row =>
      String(row?.ORG_TYPE_CODE || '') === '1' && /^\d{6}$/.test(String(row?.HOLDER_CODE || ''))
    )
    const latestReportDate = fundRows.reduce((latest, row) =>
      String(row?.REPORT_DATE || '') > latest ? String(row?.REPORT_DATE || '') : latest, '')
    const newestForFund = new Map()
    for (const row of fundRows) {
      if (latestReportDate && String(row?.REPORT_DATE || '') !== latestReportDate) continue
      const code = String(row?.HOLDER_CODE || '')
      const existing = newestForFund.get(code)
      if (!existing || String(row?.REPORT_DATE || '') > String(existing?.REPORT_DATE || '')) newestForFund.set(code, row)
    }
    for (const [code, row] of newestForFund) {
      const candidate = candidates.get(code) || {
        code,
        holderName: String(row?.HOLDER_NAME || ''),
        matchedStocks: new Set(),
        matchedHoldingRatio: 0,
        reportDate: ''
      }
      candidate.matchedStocks.add(stockCode)
      candidate.matchedHoldingRatio += asNumberOrNull(row?.NETASSET_RATIO) || 0
      candidate.reportDate = candidate.reportDate > String(row?.REPORT_DATE || '') ? candidate.reportDate : String(row?.REPORT_DATE || '')
      candidates.set(code, candidate)
    }
  }

  const listByCode = buildFundLookup(fundList)
  return [...candidates.values()].map(candidate => {
    const snapshot = snapshotForCode(snapshotSource, candidate.code)
    const listed = listByCode.get(candidate.code)
    return {
      code: candidate.code,
      name: String(snapshot?.name || listed?.name || candidate.holderName || candidate.code),
      unitNav: asNumberOrNull(snapshot?.nav ?? snapshot?.previousNav),
      dailyReturn: asNumberOrNull(snapshot?.changePercent),
      navDate: String(snapshot?.navDate || getFundSnapshotMetadata()?.latestDate || ''),
      relatedIndex: '',
      relatedSource: 'constituent_holdings',
      relatedMatchCount: candidate.matchedStocks.size,
      relatedHoldingRatio: candidate.matchedHoldingRatio,
      reportDate: candidate.reportDate.slice(0, 10)
    }
  }).sort((a, b) => b.relatedMatchCount - a.relatedMatchCount || b.relatedHoldingRatio - a.relatedHoldingRatio || a.code.localeCompare(b.code)).slice(0, 30)
}

async function fetchStockFundHolderRows(stockCode) {
  const cacheKey = `sector:stock-fund-holders:${stockCode}`
  const cached = getCache(cacheKey)
  if (cached) return cached
  const query = new URLSearchParams({
    sortColumns: 'HOLD_MARKET_CAP',
    sortTypes: '-1',
    pageSize: '500',
    pageNumber: '1',
    reportName: 'RPT_MAINDATA_MAIN_POSITIONDETAILS',
    columns: 'HOLDER_CODE,HOLDER_NAME,ORG_TYPE_CODE,REPORT_DATE,NETASSET_RATIO,HOLD_MARKET_CAP',
    filter: `(SECURITY_CODE="${stockCode}")(ORG_TYPE_CODE="1")`
  })
  const response = await fetchUpstream(`https://datacenter-web.eastmoney.com/api/data/v1/get?${query.toString()}`, {
    headers: { 'User-Agent': 'Mozilla/5.0', Referer: 'https://data.eastmoney.com/' },
    retries: 1,
    timeoutMs: 8_000,
    dedupeKey: cacheKey
  })
  const rows = (await response.json())?.result?.data
  const result = Array.isArray(rows) ? rows : []
  setCache(cacheKey, result, 6 * 60 * 60 * 1000)
  return result
}

async function fetchFundsFromConstituentStockHolders(constituents) {
  const stockCodes = [...new Set((Array.isArray(constituents) ? constituents : [])
    .map(stock => String(stock?.code || ''))
    .filter(code => /^\d{6}$/.test(code)))].slice(0, 12)
  if (!stockCodes.length) return []
  const rowsByStock = Object.fromEntries(await Promise.all(stockCodes.map(async stockCode => {
    try {
      return [stockCode, await fetchStockFundHolderRows(stockCode)]
    } catch (error) {
      console.warn(`[Cache] 成分股 ${stockCode} 关联基金查询失败: ${error.message}`)
      return [stockCode, []]
    }
  })))
  return buildConstituentFundMatches(rowsByStock)
}

async function fetchSectorRelatedFunds(sectorName) {
  if (!SUPABASE_ANON_KEY || !sectorName) return []
  const cacheKey = `sector:related-funds:${sectorName}`
  const cached = getCache(cacheKey)
  if (cached) return cached
  const headers = {
    apikey: SUPABASE_ANON_KEY,
    Authorization: `Bearer ${SUPABASE_ANON_KEY}`,
    Accept: 'application/json'
  }
  try {
    const mappingsResponse = await fetchUpstream(
      `${SUPABASE_REST_URL}/rest/v1/fund_index_sector_mapping?select=index_name&sector_name=eq.${encodeURIComponent(sectorName)}&limit=50`,
      { headers, retries: 1, timeoutMs: 6_000, dedupeKey: `sector:fund-mappings:${sectorName}` }
    )
    const indexNames = [...new Set((await mappingsResponse.json()).map(row => String(row.index_name || '').trim()).filter(Boolean))]
    if (!indexNames.length) return []
    const relatedFilter = `in.(${indexNames.map(name => `"${name.replace(/"/g, '\\"')}"`).join(',')})`
    const relatedResponse = await fetchUpstream(
      `${SUPABASE_REST_URL}/rest/v1/fund_related?select=fund_code,related_sector&related_sector=${encodeURIComponent(relatedFilter)}&limit=100`,
      { headers, retries: 1, timeoutMs: 6_000, dedupeKey: `sector:related-funds:${sectorName}` }
    )
    const fundCodes = [...new Set((await relatedResponse.json()).map(row => String(row.fund_code || '')).filter(code => /^\d{6}$/.test(code)))].slice(0, 30)
    const listByCode = new Map((getFundList() || []).map(fund => [fund.code, fund]))
    const funds = fundCodes.map(code => {
      const snapshot = getFundSnapshot(code)
      const entry = listByCode.get(code)
      return {
        code,
        name: String(snapshot?.name || entry?.name || code),
        unitNav: asNumberOrNull(snapshot?.nav ?? snapshot?.previousNav),
        dailyReturn: asNumberOrNull(snapshot?.changePercent),
        navDate: String(snapshot?.navDate || getFundSnapshotMetadata()?.latestDate || ''),
        relatedIndex: indexNames.find(indexName => indexName) || '',
        relatedSource: 'theme_mapping'
      }
    })
    setCache(cacheKey, funds, 10 * 60 * 1000)
    return funds
  } catch (error) {
    console.error(`[Cache] 板块关联基金查询失败: ${error.message}`)
    return []
  }
}

/**
 * Build one board detail from the curated Supabase mapping and real-time
 * Eastmoney quote data. Curated mapping controls fund relationships; the
 * quote and constituent data are never synthesized locally.
 */
export async function fetchSectorDetail({ code, name = '', type = 'industry', period = '1d' } = {}) {
  const requestedCode = normalizeBoardCode(code)
  const requestedName = String(name || '').trim()
  const sectorType = type === 'concept' ? 'concept' : 'industry'
  const selectedPeriod = ['1d', '1m', '3m', '1y'].includes(period) ? period : '1d'
  const universe = await fetchSectorUniverse()
  const mappedByCode = universe.find(row => row.type === sectorType && row.code === requestedCode) || null
  const mappedByName = requestedName
    ? universe.find(row => row.type === sectorType && row.name === requestedName) || null
    : null
  const mapped = mappedByCode || mappedByName
  // Live rank codes are authoritative. Curated mappings may retain an older
  // Eastmoney board code, but their name relation is still useful for funds.
  const boardCode = normalizeBoardCode(requestedCode || mapped?.code)
  const boardName = String(requestedName || mapped?.name || '')
  if (!boardCode || !boardName) throw new Error('缺少有效的板块代码或名称')

  const cacheKey = `sector:detail:${boardCode}:${selectedPeriod}`
  const cached = getCache(cacheKey)
  if (cached) return cached

  const quoteQuery = new URLSearchParams({
    secid: `90.${boardCode}`,
    fields: 'f43,f44,f45,f46,f47,f48,f57,f58,f60,f62,f104,f105,f106,f170'
  })
  const [quotePayload, trendResult, constituentResult, mappedRelatedFunds] = await Promise.all([
    fetchBoardUpstream(`/api/qt/stock/get?${quoteQuery.toString()}`, `sector:quote:${boardCode}`),
    fetchBoardTrend(boardCode, selectedPeriod).catch(error => {
      console.error(`[Cache] 板块走势获取失败: ${error.message}`)
      return []
    }),
    fetchBoardConstituents(boardCode).catch(error => {
      console.error(`[Cache] 板块成分股获取失败: ${error.message}`)
      return { total: 0, constituents: [] }
    }),
    mapped ? fetchSectorRelatedFunds(boardName) : Promise.resolve([])
  ])
  const quote = quotePayload?.data || {}
  const allConstituents = constituentResult.constituents
  const cachedConstituentFunds = mappedRelatedFunds.length
    ? []
    : findRelatedFundsFromConstituentHoldings(allConstituents)
  const relatedFunds = mappedRelatedFunds.length
    ? mappedRelatedFunds
    : cachedConstituentFunds.length
      ? cachedConstituentFunds
      : await fetchFundsFromConstituentStockHolders(allConstituents)
  const breadth = allConstituents.reduce((summary, stock) => {
    if ((stock.changePercent || 0) > 0) summary.up++
    else if ((stock.changePercent || 0) < 0) summary.down++
    else summary.flat++
    return summary
  }, { up: 0, down: 0, flat: 0 })
  const price = asNumberOrNull(quote.f43, 100)
  const previousClose = asNumberOrNull(quote.f60, 100)
  const dayReturn = asNumberOrNull(quote.f170, 100) ?? (price !== null && previousClose ? ((price - previousClose) / previousClose) * 100 : null)
  const trendDate = trendResult[0]?.time?.slice(0, 10) || ''
  const detail = {
    sector: {
      code: boardCode,
      name: boardName,
      type: sectorType,
      price,
      previousClose,
      changePercent: dayReturn,
      netInflow: asNumberOrNull(quote.f62),
      date: trendDate,
      mapped: Boolean(mapped),
      source: 'eastmoney'
    },
    breadth: { ...breadth, total: constituentResult.total || allConstituents.length },
    trend: { period: selectedPeriod, points: trendResult },
    constituents: allConstituents.slice(0, 30),
    relatedFunds,
    updatedAt: new Date().toISOString()
  }
  const detailTtl = getBeijingMarketState().isOpen && selectedPeriod === '1d' ? 5 * 1000 : 60 * 1000
  setCache(cacheKey, detail, detailTtl)
  return detail
}
