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
  fetchFundEstimates,
  fetchFundRank,
  fetchMarketIndices,
  fetchOTCFundRank,
  fetchSectorRank,
  warmupCache,
  getCacheStats,
  clearCache,
  fetchStockQuotes
} from './cache.mjs'

const app = express()
const PORT = process.env.PORT || 3000

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
app.use(express.json())

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
    const data = await fetchFundEstimates(codeList)
    res.json({ data })
  } catch (error) {
    res.status(500).json({ error: error.message })
  }
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

// 每天凌晨 2:00 刷新基金列表
cron.schedule('0 2 * * *', async () => {
  console.log('[Cron] 定时刷新基金列表...')
  try {
    await fetchFullFundList()
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

// ========== 启动 ==========

async function start() {
  console.log('========================================')
  console.log('  tyingfund.com 基金代理服务器')
  console.log(`  端口: ${PORT}`)
  console.log(`  时间: ${new Date().toLocaleString('zh-CN')}`)
  console.log('========================================')

  // 预热缓存
  await warmupCache()

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
