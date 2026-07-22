/**
 * tyingfund.com 后端代理服务器
 * [WHY] 前端基金APP需要通过代理访问东方财富API，避免CORS和跨域问题
 * [WHAT] Express 服务器 + API反向代理 + 数据缓存 + 定时抓取
 * [HOW] 部署在 tyingfund.com，Nginx 反向代理到此服务
 */

import express from 'express'
import { createProxyMiddleware } from 'http-proxy-middleware'
import cron from 'node-cron'
import {
  fetchFullFundList,
  getFundList,
  fetchFundRank,
  fetchMarketIndices,
  fetchOTCFundRank,
  fetchSectorRank,
  fetchSectorDetail,
  warmupCache,
  getCacheStats,
  clearCache,
  fetchStockQuotes,
  getFundSnapshot,
  getFundSnapshotMetadata,
  refreshFullMarketSnapshots,
  getBeijingMarketState
} from './cache.mjs'
import {
  getFundEstimateSources,
  getFundHistory,
  getFundHoldings,
  getFundProfile,
  getReliableFundEstimates
} from './fund-data-service.mjs'
import { getFundIntradayCurve, getFundPerformance } from './fund-chart-service.mjs'
import { getAppRelease } from './app-release.mjs'
import { HOLDING_OCR_PROMPT, parseHoldingOcrResponse } from './holding-ocr.mjs'
import { GRID_TRADE_OCR_PROMPT, parseGridTradeOcrResponse } from './grid-trade-ocr.mjs'
import { getMarketDataStatus, refreshAllFundSectorExposure } from './market-database.mjs'
import {
  isMarketHoldingsSyncRunning,
  refreshMarketSecurityQuotes,
  startMarketHoldingsSync
} from './market-holdings-sync.mjs'

const app = express()
const PORT = process.env.PORT || 3000
const zhipuApiKey = String(process.env.ZHIPU_API_KEY || '').trim()
const MAX_OCR_IMAGE_BYTES = 8 * 1024 * 1024

// ========== CORS 中间件 ==========
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*')
  res.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
  res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization, Referer, User-Agent')

  if (req.method === 'OPTIONS') {
    return res.sendStatus(204)
  }
  next()
})

// JSON 解析
app.use(express.json({ limit: '12mb' }))

// ========== 自有 API 路由 ==========

/**
 * GET /api/fund-list - 获取全市场基金列表
 * Query: ?q=关键词（搜索名称/代码）
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
 * Query: ?codes=000001,110011,004253
 */
/**
 * GET /api/stock-quotes - 批量获取股票行情（A股+港股）
 * Query: ?secids=1.600519,0.000001,116.00700
 * [WHY] 前端统一走后端，避免东方财富反爬和CORS问题
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
    const data = await getReliableFundEstimates(codeList)
    res.json({
      data,
      market: getBeijingMarketState(),
      snapshots: getFundSnapshotMetadata()
    })
  } catch (error) {
    res.status(500).json({ error: error.message })
  }
})

/** Unified fund profile and WealthAgent-style valuation classification. */
app.get('/api/funds/:code', (req, res) => {
  const { code } = req.params
  if (!/^\d{6}$/.test(code)) return res.status(400).json({ error: '基金代码必须是6位数字' })
  const data = getFundProfile(code)
  if (!data) return res.status(404).json({ error: `未找到基金: ${code}` })
  res.json({ data })
})

app.get('/api/funds/:code/nav-history', async (req, res) => {
  const { code } = req.params
  if (!/^\d{6}$/.test(code)) return res.status(400).json({ error: '基金代码必须是6位数字' })
  try {
    res.json({ data: await getFundHistory(code, req.query.limit) })
  } catch (error) {
    res.status(502).json({ error: error.message })
  }
})

app.get('/api/funds/:code/performance', async (req, res) => {
  const { code } = req.params
  const range = String(req.query.range || 'y')
  if (!/^\d{6}$/.test(code)) return res.status(400).json({ error: '基金代码必须是6位数字' })
  try {
    res.json({ data: await getFundPerformance(code, range) })
  } catch (error) {
    res.status(502).json({ error: error.message })
  }
})

app.get('/api/funds/:code/intraday', async (req, res) => {
  const { code } = req.params
  if (!/^\d{6}$/.test(code)) return res.status(400).json({ error: '基金代码必须是6位数字' })
  try {
    res.set('Cache-Control', 'no-store, max-age=0')
    res.json({ data: await getFundIntradayCurve(code) })
  } catch (error) {
    res.status(502).json({ error: error.message })
  }
})

app.get('/api/funds/:code/holdings', async (req, res) => {
  const { code } = req.params
  if (!/^\d{6}$/.test(code)) return res.status(400).json({ error: '基金代码必须是6位数字' })
  try {
    res.json({ data: await getFundHoldings(code, { includeQuotes: req.query.quotes === '1' }) })
  } catch (error) {
    res.status(502).json({ error: error.message })
  }
})

app.get('/api/market-holdings/status', async (req, res) => {
  try {
    res.set('Cache-Control', 'no-store, max-age=0')
    res.json({
      data: await getMarketDataStatus(),
      runtime: { holdingsSyncRunning: isMarketHoldingsSyncRunning() }
    })
  } catch (error) {
    res.status(503).json({ error: error.message })
  }
})

app.get('/api/fund-estimate-sources', async (req, res) => {
  const code = String(req.query.code || '').trim()
  if (!/^\d{6}$/.test(code)) return res.status(400).json({ error: '基金代码必须是6位数字' })
  try {
    res.json({ data: await getFundEstimateSources(code) })
  } catch (error) {
    res.status(502).json({ error: error.message })
  }
})

app.get('/api/app/version', (req, res) => {
  const forwardedProtocol = String(req.get('x-forwarded-proto') || '').split(',')[0].trim()
  const host = req.get('host')
  // Cloudflare Tunnel reaches Nginx over HTTP, but the public download must stay HTTPS.
  const protocol = /(^|\.)tyingfund\.com(?::\d+)?$/i.test(host) ? 'https' : (forwardedProtocol || req.protocol)
  const origin = `${protocol}://${host}`
  const data = getAppRelease(origin)
  res.set('Cache-Control', 'no-store, max-age=0')
  res.json({ success: true, data })
})

app.post('/api/ocr/holding-import', async (req, res) => {
  if (!zhipuApiKey) return res.status(503).json({ error: 'AI image recognition is not configured' })

  const file = typeof req.body?.file === 'string' ? req.body.file : ''
  const match = file.match(/^data:image\/(png|jpe?g|webp);base64,([A-Za-z0-9+/=]+)$/i)
  if (!match) return res.status(400).json({ error: 'A PNG, JPEG, or WebP image is required' })

  const imageBytes = Buffer.byteLength(match[2], 'base64')
  if (imageBytes === 0 || imageBytes > MAX_OCR_IMAGE_BYTES) {
    return res.status(413).json({ error: 'Image must be smaller than 8 MB' })
  }

  try {
    const upstream = await fetch('https://open.bigmodel.cn/api/paas/v4/layout_parsing', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${zhipuApiKey}`
      },
      body: JSON.stringify({ model: 'glm-ocr', file, prompt: HOLDING_OCR_PROMPT })
    })
    const result = await upstream.json().catch(() => null)
    if (!upstream.ok) {
      return res.status(502).json({ error: `AI recognition service failed (${upstream.status})` })
    }
    const fundList = getFundList()
    if (!fundList) return res.status(503).json({ error: 'Fund list is not ready' })
    res.json({ items: parseHoldingOcrResponse(result, fundList) })
  } catch (error) {
    res.status(502).json({ error: 'AI recognition service is unavailable' })
  }
})

app.post('/api/ocr/grid-trades', async (req, res) => {
  if (!zhipuApiKey) return res.status(503).json({ error: 'AI image recognition is not configured' })

  const file = typeof req.body?.file === 'string' ? req.body.file : ''
  const match = file.match(/^data:image\/(png|jpe?g|webp);base64,([A-Za-z0-9+/=]+)$/i)
  if (!match) return res.status(400).json({ error: 'A PNG, JPEG, or WebP image is required' })

  const imageBytes = Buffer.byteLength(match[2], 'base64')
  if (imageBytes === 0 || imageBytes > MAX_OCR_IMAGE_BYTES) {
    return res.status(413).json({ error: 'Image must be smaller than 8 MB' })
  }

  try {
    const upstream = await fetch('https://open.bigmodel.cn/api/paas/v4/layout_parsing', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${zhipuApiKey}`
      },
      body: JSON.stringify({ model: 'glm-ocr', file, prompt: GRID_TRADE_OCR_PROMPT })
    })
    const result = await upstream.json().catch(() => null)
    if (!upstream.ok) {
      return res.status(502).json({ error: `AI recognition service failed (${upstream.status})` })
    }
    res.json(parseGridTradeOcrResponse(result, getFundList() || []))
  } catch {
    res.status(502).json({ error: 'AI recognition service is unavailable' })
  }
})

/**
 * GET /api/fund-snapshots - 查询全市场批量净值快照
 * Query: ?codes=000001,000010
 */
app.get('/api/fund-snapshots', (req, res) => {
  const codeList = String(req.query.codes || '').split(',').map(code => code.trim()).filter(Boolean)
  if (codeList.length === 0) return res.status(400).json({ error: '缺少 codes 参数' })
  if (codeList.length > 500) return res.status(400).json({ error: '单次最多查询500只基金' })
  if (codeList.some(code => !/^\d{6}$/.test(code))) return res.status(400).json({ error: '基金代码必须是6位数字' })

  const data = Object.fromEntries(codeList.map(code => [code, getFundSnapshot(code)]).filter(([, value]) => value))
  res.json({ data, metadata: getFundSnapshotMetadata() })
})

/**
 * GET /api/fund-rank - 基金排行
 * Query: ?ft=gp&sc=1nzf&st=desc&pi=1&pn=50
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
 */
app.get('/api/market-indices', async (req, res) => {
  try {
    const data = await fetchMarketIndices()
    if (!data) {
      return res.status(502).json({ error: '获取指数数据失败' })
    }
    res.json({ data })
  } catch (error) {
    res.status(500).json({ error: error.message })
  }
})

/** Server-sent index updates keep all app tabs on one shared quote feed. */
app.get('/api/market-index-stream', (req, res) => {
  res.set({
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no'
  })
  res.flushHeaders()
  let sending = false
  const send = async () => {
    if (sending || res.writableEnded) return
    sending = true
    try {
      const indices = await fetchMarketIndices()
      res.write(`event: indices\ndata: ${JSON.stringify({ indices, updatedAt: new Date().toISOString() })}\n\n`)
    } catch (error) {
      res.write(`event: error\ndata: ${JSON.stringify({ message: error.message })}\n\n`)
    } finally {
      sending = false
    }
  }
  void send()
  const timer = setInterval(send, 1000)
  req.on('close', () => clearInterval(timer))
})

/**
 * GET /api/market-overview - 行情页初始快照
 * 将指数、行业板块和同一基金类型的排行汇总为一个稳定契约，
 * 让客户端不再自行拼接不同上游的字段与缓存策略。
 */
app.get('/api/market-overview', async (req, res) => {
  const allowedTypes = new Set(['gp', 'hh', 'zq', 'zs', 'qdii', 'fof'])
  const fundType = allowedTypes.has(String(req.query.ft || 'gp')) ? String(req.query.ft || 'gp') : 'gp'
  const rankSize = Math.min(Math.max(Number(req.query.rankSize) || 12, 1), 30)

  try {
    const [indices, sectors, ranking] = await Promise.all([
      fetchMarketIndices(),
      fetchSectorRank(12),
      fetchFundRank({ ft: fundType, sc: '1nzf', st: 'desc', pi: 1, pn: rankSize })
    ])
    res.set('Cache-Control', 'no-store, max-age=0')
    res.json({
      data: {
        indices,
        sectors,
        ranking: ranking || { records: [], total: 0, page: 1, pageSize: rankSize }
      },
      metadata: {
        market: getBeijingMarketState(),
        refreshedAt: new Date().toISOString(),
        mappings: {
          sectorTopics: 'public.fund_topic',
          indexSectors: 'public.fund_index_sector_mapping',
          fundSectors: 'public.fund_related'
        }
      }
    })
  } catch (error) {
    res.status(502).json({ error: error.message || '市场快照获取失败' })
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
    const limit = Math.min(Math.max(parseInt(req.query.limit) || 20, 1), 500)
    const type = req.query.type === 'concept' ? 'concept' : 'industry'
    const sort = req.query.sort === 'flow' ? 'flow' : 'change'
    const order = req.query.order === 'asc' ? 'asc' : 'desc'
    const data = await fetchSectorRank(limit, type, sort, order)
    res.set('Cache-Control', 'no-store, max-age=0')
    res.json({
      data,
      metadata: {
        type,
        sort,
        order,
        limit,
        source: 'eastmoney',
        total: data.length,
        refreshedAt: data[0]?.updatedAt || null
      }
    })
  } catch (error) {
    res.status(500).json({ error: error.message })
  }
})

/**
 * GET /api/sector-detail - curated board relation + Eastmoney live details.
 * Query: code=BKxxxx&name=<optional>&type=industry|concept&period=1d|1m|3m|1y
 */
app.get('/api/sector-detail', async (req, res) => {
  try {
    const code = String(req.query.code || '')
    const name = String(req.query.name || '')
    if (!code && !name) return res.status(400).json({ error: '缺少板块代码或名称' })
    const data = await fetchSectorDetail({
      code,
      name,
      type: req.query.type === 'concept' ? 'concept' : 'industry',
      period: String(req.query.period || '1d')
    })
    res.set('Cache-Control', 'no-store, max-age=0')
    res.json({ data, metadata: { source: 'eastmoney + curated supabase mapping' } })
  } catch (error) {
    res.status(502).json({ error: error.message || '板块详情获取失败' })
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

// ========== 代理路由（透传到东方财富）==========

// /tiantian/* → fund.eastmoney.com
app.use('/tiantian', createProxyMiddleware({
  target: 'http://fund.eastmoney.com',
  changeOrigin: true,
  pathRewrite: { '^/tiantian': '' },
  onProxyReq(proxyReq) {
    proxyReq.setHeader('Referer', 'http://fund.eastmoney.com/')
  }
}))

// /eastmoney/* → api.fund.eastmoney.com
app.use('/eastmoney', createProxyMiddleware({
  target: 'https://api.fund.eastmoney.com',
  changeOrigin: true,
  pathRewrite: { '^/eastmoney': '' },
  onProxyReq(proxyReq) {
    proxyReq.setHeader('Referer', 'https://api.fund.eastmoney.com/')
  }
}))

// /push2/* → push2.eastmoney.com
app.use('/push2', createProxyMiddleware({
  target: 'https://push2.eastmoney.com',
  changeOrigin: true,
  pathRewrite: { '^/push2': '' },
  onProxyReq(proxyReq) {
    proxyReq.setHeader('Referer', 'https://quote.eastmoney.com/')
    proxyReq.setHeader('User-Agent', 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36')
  }
}))

// /fundmobapi/* → fundmobapi.eastmoney.com
app.use('/fundmobapi', createProxyMiddleware({
  target: 'https://fundmobapi.eastmoney.com',
  changeOrigin: true,
  pathRewrite: { '^/fundmobapi': '' },
  onProxyReq(proxyReq) {
    proxyReq.setHeader('Referer', 'https://fundmobapi.eastmoney.com/')
  }
}))

// /np/* → np-listapi.eastmoney.com
app.use('/np', createProxyMiddleware({
  target: 'http://np-listapi.eastmoney.com',
  changeOrigin: true,
  pathRewrite: { '^/np': '' },
  onProxyReq(proxyReq) {
    proxyReq.setHeader('Referer', 'http://fund.eastmoney.com/')
  }
}))

// /fundgz/* → fundgz.1234567.com.cn（实时估值）
app.use('/fundgz', createProxyMiddleware({
  target: 'http://fundgz.1234567.com.cn',
  changeOrigin: true,
  pathRewrite: { '^/fundgz': '' },
  onProxyReq(proxyReq) {
    proxyReq.setHeader('Referer', 'http://fund.eastmoney.com/')
  }
}))

// /fundf10/* → fundf10.eastmoney.com（基金档案）
app.use('/fundf10', createProxyMiddleware({
  target: 'http://fundf10.eastmoney.com',
  changeOrigin: true,
  pathRewrite: { '^/fundf10': '' },
  onProxyReq(proxyReq) {
    proxyReq.setHeader('Referer', 'http://fund.eastmoney.com/')
  }
}))

// ========== 定时任务 ==========

const cronOptions = { timezone: 'Asia/Shanghai' }

// 每天凌晨 2:00（北京时间）刷新基金列表
cron.schedule('0 2 * * *', async () => {
  console.log('[Cron] 定时刷新基金列表...')
  try {
    await fetchFullFundList()
  } catch (error) {
    console.error(`[Cron] 刷新失败: ${error.message}`)
  }
}, cronOptions)

// 上午、下午真实交易窗口每5分钟刷新大盘指数，午休不请求上游。
cron.schedule('*/5 9-11,13-14 * * 1-5', async () => {
  try {
    if (getBeijingMarketState().isOpen) {
      await Promise.all([
        fetchMarketIndices(),
        fetchSectorRank(500, 'industry'),
        fetchSectorRank(500, 'concept')
      ])
    }
  } catch {
    // 静默失败
  }
}, cronOptions)

// 全市场实际净值采用批量源。盘前加载一次，收盘后按基金公司披露节奏
// 分阶段更新；每轮只有三个上游请求，不逐只扫描基金。
const refreshSnapshotsFromCron = () => {
  refreshFullMarketSnapshots({ force: true }).catch(error => {
    console.error(`[Cron] 全市场快照刷新失败: ${error.message}`)
  })
}
cron.schedule('45 8 * * *', refreshSnapshotsFromCron, cronOptions)
cron.schedule('10 15,16,18,20,22 * * 1-5', refreshSnapshotsFromCron, cronOptions)
cron.schedule('30 0 * * *', refreshSnapshotsFromCron, cronOptions)

// Holdings disclosures are synchronized outside page requests. A successful
// fund is revisited weekly; empty funds are revisited monthly.
cron.schedule('30 1 * * *', () => {
  startMarketHoldingsSync().catch(error => {
    console.error(`[Market Sync] scheduled run failed: ${error.message}`)
  })
}, cronOptions)

// Rotate through the least recently updated held securities. This bounds
// provider traffic while keeping mainland, Hong Kong, and US quotes warm.
cron.schedule('* * * * *', () => {
  refreshMarketSecurityQuotes({ limit: 1000 }).catch(error => {
    console.error(`[Market Quotes] refresh failed: ${error.message}`)
  })
}, cronOptions)

cron.schedule('15 4 * * *', () => {
  refreshAllFundSectorExposure().catch(error => {
    console.error(`[Market Sectors] exposure refresh failed: ${error.message}`)
  })
}, cronOptions)

// ========== 启动 ==========

async function start() {
  console.log('========================================')
  console.log('  tyingfund.com 基金代理服务器')
  console.log(`  端口: ${PORT}`)
  console.log(`  时间: ${new Date().toLocaleString('zh-CN')}`)
  console.log('========================================')

  // 预热缓存
  await warmupCache()

  if (process.env.MARKET_HOLDINGS_AUTOSYNC !== 'false') {
    startMarketHoldingsSync().catch(error => {
      console.error(`[Market Sync] startup run failed: ${error.message}`)
    })
  }

  app.listen(PORT, () => {
    console.log(`\n✅ 服务器已启动: http://localhost:${PORT}`)
    console.log('\n代理路由:')
    console.log('  /tiantian/*    → fund.eastmoney.com')
    console.log('  /eastmoney/*   → api.fund.eastmoney.com')
    console.log('  /push2/*       → push2.eastmoney.com')
    console.log('  /fundmobapi/*  → fundmobapi.eastmoney.com')
    console.log('  /np/*          → np-listapi.eastmoney.com')
    console.log('  /fundgz/*      → fundgz.1234567.com.cn')
    console.log('  /fundf10/*     → fundf10.eastmoney.com')
    console.log('\n自有 API:')
    console.log('  GET  /api/fund-list        全市场基金列表')
    console.log('  GET  /api/fund-estimates   批量实时估值')
    console.log('  GET  /api/fund-estimate-sources 多源估值诊断')
    console.log('  GET  /api/app/version      移动端版本元数据')
    console.log('  GET  /api/fund-snapshots   全市场净值快照')
    console.log('  GET  /api/funds/:code      统一基金信息')
    console.log('  GET  /api/funds/:code/performance  数据库缓存的业绩对比')
    console.log('  GET  /api/funds/:code/intraday     实时分时估值曲线')
    console.log('  GET  /api/fund-rank        基金排行')
    console.log('  GET  /api/market-indices   大盘指数')
    console.log('  GET  /api/cache-stats      缓存统计')
    console.log('  POST /api/cache-refresh    刷新缓存')
    console.log('  GET  /api/health           健康检查')
  })
}

start().catch(err => {
  console.error('启动失败:', err)
  process.exit(1)
})
