import assert from 'node:assert/strict'
import { createPinia, setActivePinia } from 'pinia'
import { createServer } from 'vite'

const RealDate = Date
const fixedNow = new RealDate('2026-08-10T13:00:00.000Z')
globalThis.Date = class extends RealDate {
  constructor(...args) {
    super(...(args.length ? args : [fixedNow]))
  }

  static now() {
    return fixedNow.getTime()
  }
}

const storage = new Map()
globalThis.localStorage = {
  getItem: key => storage.get(key) ?? null,
  setItem: (key, value) => storage.set(key, String(value)),
  removeItem: key => storage.delete(key)
}
globalThis.window = {
  location: { origin: 'http://localhost:5173', hostname: 'localhost' },
  setTimeout,
  clearTimeout,
  localStorage: globalThis.localStorage
}

const json = value => new Response(JSON.stringify(value), {
  status: 200,
  headers: { 'content-type': 'application/json' }
})
const snapshots = {
  '002112': { nav: 4.6419, previousNav: 4.7757, changePercent: -2.8, navDate: '2026-08-10' },
  '018524': { nav: 0.8766, previousNav: 0.866, changePercent: 1.22, navDate: '2026-08-10' }
}
const settlements = {
  '002112': { date: '2026-08-10', estimate_change: -3.7826, real_change: -2.8 },
  '018524': { date: '2026-08-10', estimate_change: 1.2923, real_change: 1.22 }
}

globalThis.fetch = async input => {
  const url = String(input)
  if (url.includes('/api/fund-estimates?')) {
    return json({
      data: {
        // No usable estimate: the completed settlement must rebuild all money fields.
        '002112': {
          fundcode: '002112',
          name: '德邦鑫星价值灵活配置混合C',
          dwjz: '4.7757',
          gsz: '--',
          gszzl: '--',
          gztime: '2026-08-10 15:00',
          source: 'sina'
        },
        // A same-day estimate must not block a same-day published HK NAV.
        '018524': {
          fundcode: '018524',
          name: '华泰紫金恒生互联网科技业指数型发起基金(QDII)C',
          dwjz: '0.8766',
          gsz: '0.8779',
          gszzl: '1.38',
          gztime: '2026-08-10 16:00',
          source: 'tiantian'
        }
      }
    })
  }

  const code = url.match(/(002112|018524)/)?.[1]
  if (!code) throw new Error(`Unexpected fetch: ${url}`)
  if (url.includes('/daily-returns')) {
    return json({
      data: {
        latest: {
          date: '2026-08-07',
          nav: code === '002112' ? 4.7757 : 0.866,
          changeRate: 0.1
        },
        current: null,
        previous: null,
        latestFresh: false
      }
    })
  }
  if (url.includes('/settlement')) return json(settlements[code])
  if (url.includes('/api/fund-estimate-sources')) {
    const snapshot = snapshots[code]
    return json({
      data: {
        profile: { snapshot },
        sources: {
          tiantian: {
            kind: 'estimate',
            gsz: code === '002112' ? '4.5912' : '0.8779',
            gszzl: code === '002112' ? '-3.86' : '1.38',
            gztime: '2026-08-10 16:00'
          },
          eastmoney: {
            kind: 'official_nav',
            gsz: String(snapshot.nav),
            gszzl: String(snapshot.changePercent),
            gztime: '2026-08-10 15:00'
          }
        }
      }
    })
  }
  throw new Error(`Unexpected fetch: ${url}`)
}

const server = await createServer({
  server: { middlewareMode: true },
  appType: 'custom',
  logLevel: 'silent'
})

try {
  const { useHoldingStore } = await server.ssrLoadModule('/src/stores/holding.ts')
  setActivePinia(createPinia())
  const store = useHoldingStore()
  store.holdings.push(
    {
      code: '002112',
      name: '德邦鑫星价值灵活配置混合C',
      shareClass: 'C',
      amount: 450,
      buyNetValue: 4.5,
      costPrice: 4.5,
      shares: 100,
      buyDate: '2026-07-01',
      holdingDays: 40,
      createdAt: 0,
      loading: true
    },
    {
      code: '018524',
      name: '华泰紫金恒生互联网科技业指数型发起基金(QDII)C',
      shareClass: 'C',
      amount: 800,
      buyNetValue: 0.8,
      costPrice: 0.8,
      shares: 1000,
      buyDate: '2026-07-01',
      holdingDays: 40,
      createdAt: 0,
      loading: true
    }
  )

  await store.refreshEstimates()
  const debang = store.holdings.find(item => item.code === '002112')
  const hangSeng = store.holdings.find(item => item.code === '018524')
  assert.ok(debang)
  assert.ok(hangSeng)
  assert.deepEqual({
    currentValue: debang.currentValue,
    marketValue: debang.marketValue,
    profit: debang.profit,
    todayProfit: debang.todayProfit,
    estimateChange: debang.estimateChange,
    realChange: debang.realChange,
    realChangeDate: debang.realChangeDate
  }, {
    currentValue: 4.6419,
    marketValue: 464.19,
    profit: 14.19,
    todayProfit: -13.37,
    estimateChange: '-3.7826',
    realChange: -2.8,
    realChangeDate: '2026-08-10'
  })
  assert.deepEqual({
    currentValue: hangSeng.currentValue,
    marketValue: hangSeng.marketValue,
    profit: hangSeng.profit,
    todayProfit: hangSeng.todayProfit,
    estimateChange: hangSeng.estimateChange,
    realChange: hangSeng.realChange,
    realChangeDate: hangSeng.realChangeDate
  }, {
    currentValue: 0.8766,
    marketValue: 876.6,
    profit: 76.6,
    todayProfit: 10.57,
    estimateChange: '1.2923',
    realChange: 1.22,
    realChangeDate: '2026-08-10'
  })
  console.log('Holding store settlement checks passed.')
} finally {
  await server.close()
  globalThis.Date = RealDate
}
