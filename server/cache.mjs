/**
 * 基金数据缓存层
 * [WHY] 减少对东方财富 API 的重复请求，提升响应速度
 * [WHAT] 内存缓存 + 定时刷新 + 全市场基金列表抓取
 * [HOW] 支持 TTL 过期、手动刷新、批量预热
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs'
import { join, dirname } from 'path'
import { fileURLToPath } from 'url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const CACHE_DIR = join(__dirname, 'data')

// 确保 data 目录存在
if (!existsSync(CACHE_DIR)) {
  mkdirSync(CACHE_DIR, { recursive: true })
}

// ========== 内存缓存 ==========
const memoryCache = new Map()

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
  return { total: memoryCache.size, valid, expired }
}

// ========== 持久化缓存（JSON 文件）==========

/**
 * 保存数据到本地 JSON 文件
 */
export function saveToFile(filename, data) {
  const filePath = join(CACHE_DIR, filename)
  writeFileSync(filePath, JSON.stringify(data), 'utf-8')
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

export async function fetchStockQuotes(secids) {
  if (!secids || secids.length === 0) return {}

  const results = {}

  // [HOW] 分离 A股（0/1 前缀）和港股（116 前缀）
  const aStockIds = secids.filter(s => !s.startsWith('116.'))
  const hkStockIds = secids.filter(s => s.startsWith('116.'))

  // [HOW] A股批量请求
  if (aStockIds.length > 0) {
    const secidsStr = aStockIds.join(',')
    const url = `https://push2.eastmoney.com/api/qt/ulist.np/get?fltt=2&secids=${secidsStr}&fields=f2,f3,f4,f12,f14&_=${Date.now()}`
    try {
      const response = await fetch(url, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
          'Referer': 'https://quote.eastmoney.com/'
        }
      })
      if (response.ok) {
        const data = await response.json()
        if (data.data && data.data.diff) {
          for (const item of data.data.diff) {
            if (item.f12 !== undefined) {
              // [NOTE] fltt=2 时 f3 是百分比数值（如 3.25 表示 3.25%），无需除以100
              results[item.f12] = {
                name: item.f14 || '',
                price: item.f2 || 0,
                change: item.f4 || 0,
                changePercent: item.f3 || 0
              }
            }
          }
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

/**
 * 抓取基金实时估值（批量）
 * [WHAT] 从 fundgz.1234567.com.cn 获取基金实时估值
 * @param {string[]} codes 基金代码数组
 */
export async function fetchFundEstimates(codes) {
  const results = {}

  // 分批请求，每批 20 只
  const batchSize = 20
  for (let i = 0; i < codes.length; i += batchSize) {
    const batch = codes.slice(i, i + batchSize)
    const promises = batch.map(async code => {
      const cacheKey = `estimate:${code}`
      const cached = getCache(cacheKey)
      if (cached) {
        results[code] = cached
        return
      }

      try {
        const url = `http://fundgz.1234567.com.cn/js/${code}.js`
        const response = await fetch(url, {
          headers: {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
            'Referer': 'http://fund.eastmoney.com/'
          }
        })
        const text = await response.text()
        const match = text.match(/jsonpgz\((.*)\)/)
        if (match) {
          const data = JSON.parse(match[1])
          setCache(cacheKey, data, 30 * 1000) // 30秒缓存
          results[code] = data
        }
      } catch {
        // 单只失败不影响其他
      }
    })

    await Promise.all(promises)
  }

  return results
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
    const url = `http://fund.eastmoney.com/data/rankhandler.aspx?op=ph&dt=kf&ft=${ft}&rs=&gs=0&sc=${sc}&st=${st}&pi=${pi}&pn=${pn}&dx=1&v=${Date.now()}`
    const response = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        'Referer': 'http://fund.eastmoney.com/data/fundranking.html'
      }
    })
    const text = await response.text()

    // 解析 var rankData = {datas:[...], ...}
    const datasMatch = text.match(/datas:\[(.*?)\]/s)
    if (!datasMatch) return null

    const datas = datasMatch[1].split('"').filter(s => s.trim())
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
    })

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
export async function fetchMarketIndices() {
  const cacheKey = 'market:indices'
  const cached = getCache(cacheKey)
  if (cached) return cached

  try {
    // 上证指数、深证成指、创业板指、科创50、沪深300、中证500
    const url = 'http://push2.eastmoney.com/api/qt/ulist.np/get?fltt=2&secids=1.000001,0.399001,0.399006,1.000688,1.000300,1.000905&fields=f2,f3,f4,f6,f12,f14'
    const response = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        'Referer': 'https://quote.eastmoney.com/'
      }
    })
    const data = await response.json()

    if (data?.data?.diff) {
      const indices = data.data.diff.map(item => ({
        code: item.f12,
        name: item.f14,
        price: item.f2,
        change: item.f4,
        changePercent: item.f3,
        volume: item.f6
      }))

      setCache(cacheKey, indices, 30 * 1000) // 30秒缓存
      return indices
    }

    return null
  } catch (error) {
    console.error(`[Cache] 获取大盘指数失败: ${error.message}`)
    return null
  }
}

/**
 * 抓取基金排行（通过 push2 API，适合 ETF/LOF 场内基金）
 */
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

    // 2. 加载大盘指数
    await fetchMarketIndices()
    console.log('[Cache] 大盘指数已加载')

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
export async function fetchSectorRank(limit = 20) {
  const cacheKey = `sector:rank:${limit}`
  const cached = getCache(cacheKey)
  if (cached) {
    console.log(`[Cache] 行业板块: 使用缓存 (${limit}条)`)
    return cached
  }

  // [FIX] 改用 HTTPS 并增加超时和重试
  const url = 'https://push2.eastmoney.com/api/qt/clist/get?pn=1&pz=' + limit + '&po=1&np=1&fltt=2&invt=2&fid=f3&fs=m:90+t:2&fields=f2,f3,f4,f12,f14'
  const maxRetries = 3
  const timeout = 8000

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      console.log(`[Cache] 行业板块: 请求中 (第${attempt}/${maxRetries}次)...`)
      
      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(), timeout)
      
      const response = await fetch(url, {
        signal: controller.signal,
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
          'Referer': 'https://quote.eastmoney.com/',
          'Accept': 'application/json'
        }
      })
      clearTimeout(timer)

      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`)
      }

      const data = await response.json()

      if (!data?.data?.diff || data.data.diff.length === 0) {
        console.warn('[Cache] 行业板块: 返回数据为空', JSON.stringify(data).slice(0, 200))
        return []
      }

      const sectors = data.data.diff.map(item => ({
        code: item.f12 || '',
        name: item.f14 || '',
        dayReturn: parseFloat(item.f3) || 0
      }))

      setCache(cacheKey, sectors, 60 * 1000)
      console.log(`[Cache] 行业板块: 成功获取 ${sectors.length} 条`)
      return sectors
      
    } catch (error) {
      const errMsg = error.message || String(error)
      console.warn(`[Cache] 行业板块: 第${attempt}次失败 - ${errMsg}`)
      
      if (attempt === maxRetries) {
        console.error(`[Cache] 行业板块: 全部 ${maxRetries} 次请求失败`)
        return []
      }
      
      // 等待后重试
      await new Promise(r => setTimeout(r, 500 * attempt))
    }
  }
  return []
}
