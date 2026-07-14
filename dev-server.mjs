/**
 * 本地开发环境后端服务器
 * [WHY] 在本地开发时提供和生产环境相同的API接口
 * [WHAT] 提供 /api/* 路由，使用已有的缓存和代理功能
 * [HOW] 复用后端服务器的 cache.mjs 模块
 */

import express from 'express'
import cors from 'cors'
import cron from 'node-cron'
import {
  fetchFullFundList,
  getFundList,
  fetchFundEstimates,
  fetchFundRank,
  fetchMarketIndices,
  fetchOTCFundRank,
  fetchSectorRank,
  warmupCache,
  getCacheStats,
  clearCache,
  fetchStockQuotes
} from './server/cache.mjs'

const app = express()
const PORT = 3001 // 使用不同端口避免冲突

// CORS 中间件
app.use(cors())
app.use(express.json())

// ========== 自有 API 路由 ==========

/**
 * GET /api/fund-list - 获取全市场基金列表
 */
app.get('/api/fund-list', (req, res) => {
  const list = getFundList()
  if (!list) {
    return res.status(503).json({ error: '基金列表尚未加载，请稍后重试' })
  }

  const { q, type, page = 1, pageSize = 50 } = req.query

  let result = list

  // 按关键词搜索
  if (q) {
    const keyword = q.toLowerCase()
    result = result.filter(f =>
      f.code.includes(keyword) ||
      f.name.toLowerCase().includes(keyword) ||
      f.pinyin.toLowerCase().includes(keyword) ||
      f.fullPinyin.toLowerCase().includes(keyword)
    )
  }

  // 按类型筛选
  if (type) {
    result = result.filter(f => f.type.includes(type))
  }

  // 分页
  const total = result.length
  const start = (parseInt(page) - 1) * parseInt(pageSize)
  const paged = result.slice(start, start + parseInt(pageSize))

  res.json({
    total,
    page: parseInt(page),
    pageSize: parseInt(pageSize),
    data: paged
  })
})

/**
 * GET /api/fund-estimates - 批量获取基金实时估值
 */
app.get('/api/fund-estimates', async (req, res) => {
  const { codes } = req.query
  if (!codes) {
    return res.status(400).json({ error: '缺少 codes 参数' })
  }

  const codeList = codes.split(',').map(c => c.trim()).filter(Boolean)
  if (codeList.length > 100) {
    return res.status(400).json({ error: '单次最多查询100只基金' })
  }

  try {
    const data = await fetchFundEstimates(codeList)
    res.json({ data })
  } catch (error) {
    res.status(500).json({ error: error.message })
  }
})

/**
 * GET /api/stock-quotes - 批量获取股票行情
 */
app.get('/api/stock-quotes', async (req, res) => {
  const { secids } = req.query
  if (!secids) {
    return res.status(400).json({ error: '缺少 secids 参数' })
  }

  const secidList = secids.split(',').map(s => s.trim()).filter(Boolean)
  if (secidList.length > 50) {
    return res.status(400).json({ error: '单次最多查询50只股票' })
  }

  try {
    const data = await fetchStockQuotes(secidList)
    res.json({ success: true, data })
  } catch (error) {
    res.status(500).json({ error: error.message })
  }
})

/**
 * GET /api/fund-rank - 基金排行
 */
app.get('/api/fund-rank', async (req, res) => {
  try {
    const data = await fetchFundRank(req.query)
    if (!data) {
      return res.status(502).json({ error: '获取排行数据失败' })
    }
    res.json(data)
  } catch (error) {
    res.status(500).json({ error: error.message })
  }
})

/**
 * GET /api/market-indices - 大盘指数
 * [WHY] push2.eastmoney.com 在本机服务端不可达（502），改用腾讯 qt.gtimg.cn（服务端可达）。
 */
app.get('/api/market-indices', async (req, res) => {
  // 东方财富 secid -> 腾讯代码
  const map = [
    ['1.000001', 'sh000001'],
    ['0.399001', 'sz399001'],
    ['0.399006', 'sz399006'],
    ['1.000688', 'sh000688'],
    ['1.000300', 'sh000300'],
    ['1.000905', 'sh000905'],
  ]
  const q = map.map(m => m[1]).join(',')
  try {
    const response = await fetch(`https://qt.gtimg.cn/q=${q}`, {
      headers: { 'User-Agent': 'Mozilla/5.0', 'Referer': 'https://gu.qq.com/' },
    })
    const text = await response.text()
    const indices = []
    const re = /v_(\w+)="([^"]*)"/g
    let m
    while ((m = re.exec(text))) {
      const raw = m[2].split('~')
      const name = raw[1] || ''
      const price = parseFloat(raw[3]) || 0
      const prevClose = parseFloat(raw[4]) || 0
      const change = price - prevClose
      const changePercent = prevClose ? (change / prevClose) * 100 : 0
      indices.push({ code: m[1], name, price, change, changePercent, volume: 0 })
    }
    res.json({ data: indices })
  } catch (error) {
    res.status(500).json({ error: error.message })
  }
})

/**
 * GET /api/otc-fund-rank - 场内ETF排行（push2 API）
 */
app.get('/api/otc-fund-rank', async (req, res) => {
  try {
    const page = parseInt(req.query.page) || 1
    const pn = parseInt(req.query.pn) || 20
    const order = parseInt(req.query.order) || 1
    const data = await fetchOTCFundRank({ page, pageSize: pn, order })
    if (!data) {
      return res.status(502).json({ error: '获取ETF排行失败' })
    }
    res.json(data)
  } catch (error) {
    res.status(500).json({ error: error.message })
  }
})

/**
 * GET /api/sector - 行业板块
 */
app.get('/api/sector', async (req, res) => {
  try {
    const limit = parseInt(req.query.limit) || 20
    const data = await fetchSectorRank(limit)
    res.json({ data })
  } catch (error) {
    res.status(500).json({ error: error.message })
  }
})

/**
 * GET /api/cache-stats - 缓存统计
 */
app.get('/api/cache-stats', (req, res) => {
  res.json(getCacheStats())
})

/**
 * POST /api/cache-refresh - 手动刷新缓存
 */
app.post('/api/cache-refresh', async (req, res) => {
  try {
    clearCache()
    await warmupCache()
    res.json({ success: true, stats: getCacheStats() })
  } catch (error) {
    res.status(500).json({ error: error.message })
  }
})

/**
 * GET /api/health - 健康检查
 */
app.get('/api/health', (req, res) => {
  res.json({
    status: 'ok',
    uptime: process.uptime(),
    cache: getCacheStats(),
    timestamp: new Date().toISOString()
  })
})

// ========== 定时任务 ==========

// 每天凌晨 2:00 刷新基金列表
cron.schedule('0 2 * * *', async () => {
  console.log('[Cron] 定时刷新基金列表...')
  try {
    await fetchFullFundList()
    console.log('[Cron] 基金列表刷新成功')
  } catch (error) {
    console.error(`[Cron] 刷新失败: ${error.message}`)
  }
})

// 交易日 9:00-15:00 每 5 分钟刷新大盘指数
cron.schedule('*/5 9-15 * * 1-5', async () => {
  try {
    await fetchMarketIndices()
  } catch {
    // 静默失败
  }
})

/**
 * GET /fundgz/:code.js - 基金实时估值（代理 fundgz.1234567.com.cn）
 * [WHY] 浏览器直连 fundgz 在本机超时，但 Node 服务端可直连，故在此代理。
 */
app.get('/fundgz/:code.js', async (req, res) => {
  const code = req.params.code
  try {
    const url = `http://fundgz.1234567.com.cn/js/${code}.js`
    const response = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        'Referer': 'http://fund.eastmoney.com/'
      }
    })
    const text = await response.text()
    res.type('application/javascript').send(text)
  } catch (error) {
    res.status(502).send('// fundgz proxy error: ' + error.message)
  }
})

// ========== 通用东财抓取助手（镜像 ApiCatalog 的 primary/backup 兜底） ==========

async function emFetch(url, { timeout = 8000, referer = 'https://fund.eastmoney.com/', headers = {} } = {}) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeout)
  try {
    return await fetch(url, {
      signal: controller.signal,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Linux; Android 13) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Mobile Safari/537.36',
        'Referer': referer,
        'Accept': 'application/json, text/plain, */*',
        ...headers,
      },
    })
  } finally {
    clearTimeout(timer)
  }
}

// 剥离 JSONP 包裹：jsonpgz(...) / jsonp(...) / (...)
function stripJsonp(text) {
  let t = (text || '').trim()
  const m = t.match(/^(?:jsonp|jsonpgz|jQuery\d+)?\s*\(([\s\S]*)\)\s*;?\s*$/)
  if (m) t = m[1]
  return t
}

// 简易内存缓存（详情/历史等带 TTL）
const quickCache = new Map()
function memo(key, ttlMs, fn) {
  const hit = quickCache.get(key)
  if (hit && hit.exp > Date.now()) return hit.val
  const p = fn()
  quickCache.set(key, { val: p, exp: Date.now() + ttlMs })
  return p
}

// 基金详情（FundMNFInfo）
app.get('/api/fund-detail', async (req, res) => {
  const { code } = req.query
  if (!code) return res.status(400).json({ error: '缺少 code 参数' })
  const url = `https://fundmobapi.eastmoney.com/FundMNewApi/FundMNFInfo?FCODE=${code}&deviceid=fundtracker&plat=Android&product=EFund&version=6.6.6&_=${Date.now()}`
  try {
    const r = await emFetch(url)
    res.json(JSON.parse(stripJsonp(await r.text())))
  } catch (e) { res.status(502).json({ error: e.message }) }
})

// 基金净值历史（lsjz）
app.get('/api/fund-history', async (req, res) => {
  const { code, pageSize = 1000 } = req.query
  if (!code) return res.status(400).json({ error: '缺少 code 参数' })
  const url = `https://api.fund.eastmoney.com/f10/lsjz?fundCode=${code}&pageIndex=1&pageSize=${pageSize}&startDate=&endDate=&_=${Date.now()}`
  try {
    const r = await emFetch(url, { referer: `https://fundf10.eastmoney.com/jjjz_${code}.html` })
    const json = await r.json()
    res.json(json?.Data || json)
  } catch (e) { res.status(502).json({ error: e.message }) }
})

// 基金持仓（FundMNInverstPosition）
app.get('/api/fund-portfolio', async (req, res) => {
  const { code } = req.query
  if (!code) return res.status(400).json({ error: '缺少 code 参数' })
  const url = `https://fundmobapi.eastmoney.com/FundMNewApi/FundMNInverstPosition?FCODE=${code}&deviceid=fundtracker&plat=Android&product=EFund&version=6.6.6&_=${Date.now()}`
  try {
    const r = await emFetch(url)
    const json = JSON.parse(await r.text())
    res.json(json?.Datas || json)
  } catch (e) { res.status(502).json({ error: e.message }) }
})

// 基金资产配置（zcpz）
app.get('/api/fund-asset-alloc', async (req, res) => {
  const { code } = req.query
  if (!code) return res.status(400).json({ error: '缺少 code 参数' })
  const url = `https://fundf10.eastmoney.com/FundArchivesDatas.aspx?type=zcpz&code=${code}&rt=${Date.now()}`
  try {
    const r = await emFetch(url, { referer: `https://fundf10.eastmoney.com/zcpz_${code}.html` })
    const text = await r.text()
    const m = text.match(/\{[\s\S]*\}/)
    res.json(m ? JSON.parse(m[0]) : {})
  } catch (e) { res.status(502).json({ error: e.message }) }
})

// 财经新闻（多栏目，镜像 ApiCatalog.newsFeeds 的 column 映射）
const NEWS_COLUMNS = { yaowen: 345, toutiao: 344, hongguan: 346, shuju: 352, gushi: 347, zonghe: 350, chanye: 348, gongsi: 349, xiaofei: 355, guoji: 356, diyuan: 365, keji: 360, qiche: 358, yiyao: 369, huangjin: 361, jinshi: 362, yanbao: 370, ribao: 395, gonggao: 398, beixiang: 399 }
app.get('/api/news', async (req, res) => {
  const { column = 'yaowen', limit = 30 } = req.query
  const col = NEWS_COLUMNS[column] || 345
  const url = `https://np-listapi.eastmoney.com/comm/web/getNewsByColumns?client=web&biz=web_news_col&column=${col}&order=1&needInteractData=0&page_index=1&page_size=${limit}&req_trace=${Date.now()}&fields=code,showTime,title,mediaName,summary,url,uniqueUrl,Np_dst&types=1,20`
  try {
    const r = await emFetch(url, { referer: 'https://news.eastmoney.com/' })
    const json = await r.json()
    res.json(json?.data || json)
  } catch (e) { res.status(502).json({ error: e.message }) }
})

// 股票搜索（searchapi）
app.get('/api/stock-search', async (req, res) => {
  const { q } = req.query
  if (!q) return res.status(400).json({ error: '缺少 q 参数' })
  const url = `https://searchapi.eastmoney.com/api/suggest/get?input=${encodeURIComponent(q)}&type=14&token=D43BF722C8E33E40658A6E165FC5E932A&count=30`
  try {
    const r = await emFetch(url, { referer: 'https://quote.eastmoney.com/' })
    const json = JSON.parse(stripJsonp(await r.text()))
    const raw = json?.QuotationCodeTable?.Data || json?.Result?.Datalist || json?.Datalist || json?.data || []
    const list = (Array.isArray(raw) ? raw : []).map(it => ({
      code: it.Code || it.code,
      name: it.Name || it.name,
      secid: it.QuoteID || (it.MktNum !== undefined ? `${it.MktNum}.${it.Code}` : (it.secid || '')),
      market: it.SecurityTypeName || it.MktNum,
    }))
    res.json({ list })
  } catch (e) { res.status(502).json({ error: e.message }) }
})

// 股票日K（push2his 主，push2 备）
app.get('/api/stock-kline', async (req, res) => {
  const { secid } = req.query
  if (!secid) return res.status(400).json({ error: '缺少 secid 参数' })
  const d = new Date(); d.setFullYear(d.getFullYear() - 4)
  const beg = d.toISOString().slice(0, 10).replace(/-/g, '')
  const url = `https://push2his.eastmoney.com/api/qt/stock/kline/get?secid=${secid}&ut=fa5fd1943c7b386f172d6893dbfba10b&fields1=f1,f2,f3,f4,f5,f6&fields2=f51,f52,f53,f54,f55,f56,f57,f58,f59,f60,f61&klt=101&fqt=0&beg=${beg}&end=20500101&lmt=1200`
  try {
    const r = await emFetch(url, { referer: 'https://quote.eastmoney.com/' })
    const json = await r.json()
    res.json(json?.data || json)
  } catch (e) {
    try {
      const r2 = await emFetch(url.replace('push2his', 'push2'))
      res.json((await r2.json())?.data || {})
    } catch (e2) { res.status(502).json({ error: e2.message }) }
  }
})

// 股票分时（push2 主，push2his 备）
app.get('/api/stock-trend', async (req, res) => {
  const { secid } = req.query
  if (!secid) return res.status(400).json({ error: '缺少 secid 参数' })
  const url = `https://push2.eastmoney.com/api/qt/stock/trends2/get?secid=${secid}&fields1=f1,f2,f3,f4,f5,f6,f7,f8,f9,f10,f11,f12,f13&fields2=f51,f52,f53,f54,f55,f56,f57,f58&iscr=0&iscca=0&ndays=1`
  try {
    const r = await emFetch(url, { referer: 'https://quote.eastmoney.com/' })
    const json = await r.json()
    res.json(json?.data || json)
  } catch (e) {
    try {
      const r2 = await emFetch(url.replace('push2.eastmoney', 'push2his.eastmoney'))
      res.json((await r2.json())?.data || {})
    } catch (e2) { res.status(502).json({ error: e2.message }) }
  }
})

// 大盘涨跌家数（push2 主，push2his 备）
app.get('/api/breadth', async (req, res) => {
  const url = `https://push2.eastmoney.com/api/qt/ulist.np/get?secids=1.000001,0.399001,0.899050&fields=f12,f13,f14,f2,f3,f104,f105,f106`
  try {
    const r = await emFetch(url, { referer: 'https://quote.eastmoney.com/' })
    const json = await r.json()
    res.json(json?.data || json)
  } catch (e) {
    try {
      const r2 = await emFetch(url.replace('push2.eastmoney', 'push2his.eastmoney'))
      res.json((await r2.json())?.data || json || {})
    } catch (e2) { res.status(502).json({ error: e2.message }) }
  }
})

// 基金排行（沿用 cache.mjs 的 rankhandler，服务端稳定可达；支持 ft: gp/hh/zq/zs/qdii/fof/hb）
app.get('/api/rankings', async (req, res) => {
  try {
    const data = await fetchFundRank(req.query)
    if (!data) return res.status(502).json({ error: '获取排行失败' })
    res.json(data)
  } catch (e) { res.status(500).json({ error: e.message }) }
})

// ========== 启动 ==========

async function start() {
  console.log('========================================')
  console.log('  本地开发服务器')
  console.log(`  端口: ${PORT}`)
  console.log(`  时间: ${new Date().toLocaleString('zh-CN')}`)
  console.log('========================================')

  // 预热缓存
  await warmupCache()

  app.listen(PORT, () => {
    console.log(`\n✅ 服务器已启动: http://localhost:${PORT}`)
    console.log('\n可用 API:')
    console.log('  GET  /api/fund-list        全市场基金列表')
    console.log('  GET  /api/fund-estimates   批量实时估值')
    console.log('  GET  /api/stock-quotes      批量股票行情')
    console.log('  GET  /api/fund-rank        基金排行')
    console.log('  GET  /api/market-indices   大盘指数')
    console.log('  GET  /api/cache-stats      缓存统计')
    console.log('  POST /api/cache-refresh    刷新缓存')
    console.log('  GET  /api/health           健康检查')
    console.log('\n定时任务:')
    console.log('  02:00    - 刷新全市场基金列表')
    console.log('  09:00-15:00 - 每5分钟刷新大盘指数（交易日）')
    console.log('\n前端访问: http://localhost:5173')
  })
}

start().catch(err => {
  console.error('启动失败:', err)
  process.exit(1)
})