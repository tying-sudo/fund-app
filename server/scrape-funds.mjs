/**
 * 全市场基金数据独立抓取脚本
 * [WHY] 可独立运行，不依赖服务器启动
 * [WHAT] 抓取全市场基金列表 + 各类型排行数据，保存到 data/ 目录
 * [HOW] node server/scrape-funds.mjs
 */

import { writeFileSync, existsSync, mkdirSync } from 'fs'
import { join, dirname } from 'path'
import { fileURLToPath } from 'url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const DATA_DIR = join(__dirname, 'data')

if (!existsSync(DATA_DIR)) {
  mkdirSync(DATA_DIR, { recursive: true })
}

function saveJSON(filename, data) {
  const path = join(DATA_DIR, filename)
  writeFileSync(path, JSON.stringify(data, null, 2), 'utf-8')
  console.log(`  ✅ 已保存: ${filename} (${(Buffer.byteLength(JSON.stringify(data)) / 1024).toFixed(1)} KB)`)
  return path
}

// ========== 1. 全市场基金列表 ==========
async function scrapeFundList() {
  console.log('\n📋 抓取全市场基金列表...')

  const url = 'http://fund.eastmoney.com/js/fundcode_search.js'
  const response = await fetch(url, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
      'Referer': 'http://fund.eastmoney.com/'
    }
  })

  let text = await response.text()
  text = text.replace(/^var\s+r\s*=\s*/, '').replace(/;?\s*$/, '')
  const rawList = JSON.parse(text)

  const fundList = rawList.map(item => ({
    code: item[0],
    pinyin: item[1],
    name: item[2],
    type: item[3],
    fullPinyin: item[4]
  }))

  saveJSON('fund-list.json', fundList)

  // 按类型分组统计
  const typeCount = {}
  fundList.forEach(f => {
    typeCount[f.type] = (typeCount[f.type] || 0) + 1
  })

  console.log(`  📊 共 ${fundList.length} 只基金`)
  Object.entries(typeCount)
    .sort((a, b) => b[1] - a[1])
    .forEach(([type, count]) => {
      console.log(`     ${type}: ${count} 只`)
    })

  return fundList
}

// ========== 2. 各类型基金排行 ==========
async function scrapeFundRank(ft, label) {
  console.log(`\n📈 抓取 ${label} 排行...`)

  const allRecords = []
  const pageSize = 100
  let page = 1
  let total = 0

  while (true) {
    const url = `http://fund.eastmoney.com/data/rankhandler.aspx?op=ph&dt=kf&ft=${ft}&rs=&gs=0&sc=1nzf&st=desc&pi=${page}&pn=${pageSize}&dx=1&v=${Date.now()}`
    const response = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        'Referer': 'http://fund.eastmoney.com/data/fundranking.html'
      }
    })
    const text = await response.text()

    const datasMatch = text.match(/datas:\[(.*?)\]/s)
    if (!datasMatch) break

    const items = datasMatch[1].split('"').filter(s => s.trim())
    if (items.length === 0) break

    const records = items.map(item => {
      const f = item.split(',')
      return {
        code: f[0],
        name: f[1],
        date: f[4],
        nav: f[5],
        accumNav: f[6],
        dailyReturn: f[7],
        weekReturn: f[8],
        monthReturn: f[9],
        threeMonthReturn: f[10],
        sixMonthReturn: f[11],
        yearReturn: f[12],
        twoYearReturn: f[13],
        threeYearReturn: f[14],
        ytdReturn: f[15],
        sinceInception: f[16]
      }
    })

    allRecords.push(...records)

    const totalMatch = text.match(/allRecords:(\d+)/)
    total = totalMatch ? parseInt(totalMatch[1]) : 0

    console.log(`  📄 第 ${page} 页: ${records.length} 条 (累计 ${allRecords.length}/${total})`)

    if (allRecords.length >= total || items.length < pageSize) break
    page++

    // 避免请求过快
    await new Promise(r => setTimeout(r, 300))
  }

  saveJSON(`rank-${ft}.json`, { total, records: allRecords })
  return allRecords
}

// ========== 3. 大盘指数 ==========
async function scrapeMarketIndices() {
  console.log('\n🌍 抓取大盘指数...')

  const url = 'http://push2.eastmoney.com/api/qt/ulist.np/get?fltt=2&secids=1.000001,0.399001,0.399006,1.000688,1.000300,1.000905,0.399300&fields=f2,f3,f4,f5,f6,f7,f12,f14,f15,f16,f17,f18'
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
      changePercent: item.f3,
      change: item.f4,
      volume: item.f6,
      high: item.f15,
      low: item.f16,
      open: item.f17,
      prevClose: item.f18
    }))

    saveJSON('market-indices.json', indices)
    indices.forEach(idx => {
      const arrow = idx.changePercent >= 0 ? '🔴' : '🟢'
      console.log(`  ${arrow} ${idx.name}: ${idx.price} (${idx.changePercent >= 0 ? '+' : ''}${idx.changePercent}%)`)
    })
    return indices
  }

  return null
}

// ========== 主流程 ==========
async function main() {
  console.log('╔══════════════════════════════════════╗')
  console.log('║   全市场基金数据抓取工具             ║')
  console.log(`║   ${new Date().toLocaleString('zh-CN').padEnd(28)}║`)
  console.log('╚══════════════════════════════════════╝')

  const startTime = Date.now()

  // 1. 基金列表
  await scrapeFundList()

  // 2. 各类型排行
  const types = [
    { ft: 'gp', label: '股票型基金' },
    { ft: 'hh', label: '混合型基金' },
    { ft: 'zq', label: '债券型基金' },
    { ft: 'zs', label: '指数型基金' },
    { ft: 'qdii', label: 'QDII基金' },
    { ft: 'fof', label: 'FOF基金' },
  ]

  for (const { ft, label } of types) {
    try {
      await scrapeFundRank(ft, label)
      await new Promise(r => setTimeout(r, 500))
    } catch (error) {
      console.error(`  ❌ ${label} 抓取失败: ${error.message}`)
    }
  }

  // 3. 大盘指数
  await scrapeMarketIndices()

  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1)
  console.log(`\n✅ 全部完成！耗时 ${elapsed}s`)
  console.log(`📁 数据保存在: ${DATA_DIR}`)
}

main().catch(err => {
  console.error('抓取失败:', err)
  process.exit(1)
})
