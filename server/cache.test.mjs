import test from 'node:test'
import assert from 'node:assert/strict'

import {
  getBeijingMarketState,
  getFundEstimateMarketState,
  getHongKongMarketState,
  getUsMarketState,
  shouldFetchFundgzEstimate,
  findRelatedFundsFromConstituentHoldings,
  buildConstituentFundMatches,
  isSnapshotFreshEnoughForTrading,
  normalizeMarketIndexName,
  parseSinaIndexQuotes,
  parseEastmoneySnapshot,
  parseSinaRealtimeEstimate,
  snapshotToEstimate,
  parseTencentIndexQuote,
  parseTencentIndexQuotes,
  parseTencentStockQuotes,
  parseNaverKoreanProfile,
  parseYahooJapanProfile
} from './cache.mjs'

test('parses regular full-market snapshot rows', () => {
  const source = 'var db={datas:[["000001","测试混合A","CSHHA","1.2345","2.3456","1.2000","2.3000","0.0345","2.88","开放申购","开放赎回"]],record:"1",showday:["2026-07-17","2026-07-16"]}'
  const parsed = parseEastmoneySnapshot(source, 'regular')

  assert.equal(parsed.recordCount, 1)
  assert.equal(parsed.latestDate, '2026-07-17')
  assert.deepEqual(parsed.funds[0], {
    code: '000001',
    name: '测试混合A',
    type: null,
    nav: 1.2345,
    accumulatedNav: 2.3456,
    previousNav: 1.2,
    change: 0.0345,
    changePercent: 2.88,
    navDate: '2026-07-17',
    previousNavDate: '2026-07-16',
    purchaseStatus: '开放申购',
    redemptionStatus: '开放赎回',
    isMoneyMarket: false
  })
})

test('maps money-market income without treating it as unit NAV', () => {
  const source = 'var db={datas:[["000010","易方达天天理财货币B","0.3048","07-17","1.1140%","2013-03-04","71.98亿","月结","每月最后一个工作日","暂停申购"]],record:"1",showday:["2026-07-17","2026-07-16"]}'
  const parsed = parseEastmoneySnapshot(source, 'money')
  const fund = parsed.funds[0]

  assert.equal(fund.code, '000010')
  assert.equal(fund.nav, 1)
  assert.equal(fund.perTenThousandIncome, 0.3048)
  assert.equal(fund.sevenDayAnnualized, 1.114)
  assert.equal(fund.isMoneyMarket, true)
})

test('uses the all-fund directory to cover special products', () => {
  const source = 'var db={datas:[["970195","测试资管FOF C","FOF-进取型","1.2582","07-15","开放申购","开放赎回"]],record:"1",showday:["2026-07-17","2026-07-16"]}'
  const parsed = parseEastmoneySnapshot(source, 'all')

  assert.equal(parsed.funds[0].code, '970195')
  assert.equal(parsed.funds[0].type, 'FOF-进取型')
  assert.equal(parsed.funds[0].nav, 1.2582)
  assert.equal(parsed.funds[0].isMoneyMarket, false)
})

test('uses Beijing trading windows including lunch break', () => {
  assert.equal(getBeijingMarketState(new Date('2026-07-20T02:00:00Z')).isOpen, true)
  assert.equal(getBeijingMarketState(new Date('2026-07-20T04:00:00Z')).isLunchBreak, true)
  assert.equal(getBeijingMarketState(new Date('2026-07-20T06:00:00Z')).isOpen, true)
  assert.equal(getBeijingMarketState(new Date('2026-07-19T02:00:00Z')).isOpen, false)
})

test('keeps reading final same-day fund estimates after the close', () => {
  assert.equal(shouldFetchFundgzEstimate(getBeijingMarketState(new Date('2026-07-20T07:55:00Z'))), true)
  assert.equal(shouldFetchFundgzEstimate(getBeijingMarketState(new Date('2026-07-20T12:01:00Z'))), false)
  assert.equal(shouldFetchFundgzEstimate(getBeijingMarketState(new Date('2026-07-19T07:55:00Z'))), false)
})

test('keeps the same-day estimate active through the mainland lunch recess', () => {
  const lunch = getBeijingMarketState(new Date('2026-07-20T04:00:00Z'))
  assert.equal(lunch.isOpen, false)
  assert.equal(lunch.isLunchBreak, true)
  assert.equal(lunch.isEstimateSession, true)
  assert.equal(shouldFetchFundgzEstimate(lunch), true)
})

test('uses only current-day Sina estimates as the intraday primary source', () => {
  const payload = { result: { data: { worth: '1.3190', networth: [{
    pre_date: '20260721', min_time: '14:26:00', pre_nav: '1.4174', growthrate: '0.0853'
  }] } } }
  const estimate = parseSinaRealtimeEstimate(payload, '000001', {
    name: 'Test Fund', dwjz: '1.3190', fundType: 'Mixed'
  }, {}, '2026-07-21')

  assert.deepEqual(estimate, {
    fundcode: '000001', name: 'Test Fund', dwjz: '1.3190', gsz: '1.4174', gszzl: '8.53',
    gztime: '2026-07-21 14:26:00', source: 'sina_ds2', realtime: true, stale: false,
    fundType: 'Mixed', isMoneyMarket: false
  })
  assert.equal(parseSinaRealtimeEstimate(payload, '000001', null, {}, '2026-07-20'), null)
})

test('does not turn an unpublished NAV row into a synthetic zero estimate', () => {
  const source = 'var db={datas:[["100055","Global QDII","GQ","","","5.3418","","","","Open","Open"]],record:"1",showday:["2026-07-21","2026-07-20"]}'
  const snapshot = parseEastmoneySnapshot(source, 'regular').funds[0]
  const estimate = snapshotToEstimate('100055', snapshot, { name: 'Global QDII', type: 'QDII' }, new Date('2026-07-21T12:00:00Z'))

  assert.equal(snapshot.nav, null)
  assert.equal(snapshot.navDate, null)
  assert.equal(snapshot.previousNavDate, '2026-07-20')
  assert.equal(snapshot.changePercent, null)
  assert.equal(estimate.gsz, '5.3418')
  assert.equal(estimate.gszzl, '--')
  assert.equal(estimate.gztime, '2026-07-20 15:00')
  assert.equal(estimate.pending, true)
})

test('uses Hong Kong 16:00 close and New York regular sessions for overseas QDII estimates', () => {
  assert.equal(getHongKongMarketState(new Date('2026-07-20T07:59:00Z')).isOpen, true)
  assert.equal(getHongKongMarketState(new Date('2026-07-20T08:00:00Z')).isOpen, false)
  assert.equal(getHongKongMarketState(new Date('2026-07-20T08:00:00Z')).isAfterClose, true)
  assert.equal(getUsMarketState(new Date('2026-07-20T13:30:00Z')).isOpen, true)
  assert.equal(getFundEstimateMarketState({ name: '全球科技(QDII)', type: 'QDII' }, new Date('2026-07-20T13:30:00Z')).isOpen, true)
  assert.equal(getFundEstimateMarketState({ name: '全球科技(QDII)', type: 'QDII' }, new Date('2026-07-20T12:30:00Z')).isOpen, false)
  const hangSengDuringUsSession = getFundEstimateMarketState({ name: '华泰紫金恒生互联网科技业指数型发起基金(QDII)C', type: 'QDII' }, new Date('2026-07-20T13:30:00Z'))
  assert.equal(hangSengDuringUsSession.market, 'hk')
  assert.equal(hangSengDuringUsSession.isOpen, false)
})

test('rejects stale snapshots on likely holidays but accepts Monday Friday gap', () => {
  assert.equal(isSnapshotFreshEnoughForTrading('2026-07-17', new Date('2026-07-20T02:00:00Z')), true)
  assert.equal(isSnapshotFreshEnoughForTrading('2026-07-17', new Date('2026-07-21T02:00:00Z')), false)
  assert.equal(isSnapshotFreshEnoughForTrading('2026-07-20', new Date('2026-07-21T02:00:00Z')), true)
})

test('decodes Tencent index data as UTF-8 and preserves the Hang Seng Tech name', () => {
  const payload = new TextEncoder().encode('v_hkHSTECH="100~恒生科技指数~HSTECH~5210.62~0~0~1234~0~0~0~0~0~0~0~0~0~0~0~0~0~0~0~0~0~0~0~0~0~0~0~0~-34.82~-0.66"')
  assert.deepEqual(parseTencentIndexQuote(payload), {
    name: '恒生科技',
    price: 5210.62,
    change: -34.82,
    changePercent: -0.66,
    volume: 1234
  })
})

test('parses batched overseas and compact global Tencent index quotes', () => {
  const payload = new TextEncoder().encode([
    'v_usINX="200~S&P 500~.INX~6000.00~0~0~1234~0~0~0~0~0~0~0~0~0~0~0~0~0~0~0~0~0~0~0~0~0~0~0~0~12.50~0.21";',
    'v_gzFTSE="FTSE~FTSE 100~2026-07-20 12:00:00~8000.00~-10.00~-0.12~EU~";'
  ].join('\n'))
  assert.deepEqual(parseTencentIndexQuotes(payload), [
    { symbol: 'usINX', name: 'S&P 500', price: 6000, change: 12.5, changePercent: 0.21, volume: 1234 },
    { symbol: 'gzFTSE', name: 'FTSE 100', price: 8000, change: -10, changePercent: -0.12, volume: null }
  ])
})

test('parses the Sina Hang Seng Internet and Information Technology index quote', () => {
  const payload = 'var hq_str_rt_hkHSIII="HSIII,恒生互联网科技业指数,2342.1300,2344.8600,2372.0800,2320.0400,2337.3200,-7.5400,-0.3216,0.0000,0.0000,41160586.6500,0";'
  assert.deepEqual(parseSinaIndexQuotes(payload), [{
    symbol: 'rt_hkHSIII',
    name: '恒生互联网科技业指数',
    price: 2337.32,
    change: -7.54,
    changePercent: -0.3216,
    volume: 41160586.65
  }])
})

test('parses Tencent mainland, Hong Kong, and US stock quote batches', () => {
  const row = (symbol, name, code, price, previous, change, percent) => {
    const fields = Array(33).fill('')
    fields[1] = name
    fields[2] = code
    fields[3] = String(price)
    fields[4] = String(previous)
    fields[31] = String(change)
    fields[32] = String(percent)
    return `v_${symbol}="${fields.join('~')}";`
  }
  const parsed = parseTencentStockQuotes([
    row('sh600519', 'Kweichow Moutai', '600519', 1500, 1490, 10, 0.67),
    row('hk00700', 'Tencent', '00700', 500, 490, 10, 2.04),
    row('usNVDA', 'NVIDIA', 'NVDA', 180, 175, 5, 2.86)
  ].join('\n'))
  assert.equal(parsed['600519'].changePercent, 0.67)
  assert.equal(parsed['00700'].price, 500)
  assert.equal(parsed.NVDA.change, 5)
})

test('parses verified Korean and Japanese equity industries from market-specific profile pages', () => {
  const korea = parseNaverKoreanProfile('<a href="/item/main.naver?code=005930">삼성전자</a> 업종명 : <a>반도체와반도체장비</a>', '005930')
  const japan = parseYahooJapanProfile('285A.T 業種分類</th><td><a>電気機器</a></td> 英文社名</th><td><p>Kioxia Holdings Corporation</p></td>', '285A')

  assert.equal(korea.exchange, 'KRX')
  assert.equal(korea.industry, '半导体')
  assert.equal(japan.exchange, 'JPX')
  assert.equal(japan.industry, '电子设备')
  assert.equal(parseNaverKoreanProfile('업종명 : <a>반도체</a>', '005930'), null)
})

test('normalizes saved index names by stable quote code', () => {
  assert.equal(normalizeMarketIndexName('HSTECH', '鎭掔敓绉戞妧'), '恒生科技')
  assert.equal(normalizeMarketIndexName('000001', 'broken'), '上证指数')
})

test('normalizes the Hang Seng Internet and Information Technology index name', () => {
  assert.equal(normalizeMarketIndexName('HSIII', 'broken'), '恒生互联网科技业指数')
})

test('falls back to cached fund holdings when sector mapping has no related funds', () => {
  const persistedHoldings = {
    entries: {
      '008888': {
        updatedAt: '2026-07-19T00:00:00.000Z',
        data: {
          code: '008888',
          name: '半导体联接C',
          reportDate: '2026-03-31',
          holdings: [
            { stockCode: '688041', holdingRatio: 3.1 },
            { stockCode: '688981', holdingRatio: 2.4 },
            { stockCode: '600000', holdingRatio: 1.2 }
          ]
        }
      },
      '001234': {
        updatedAt: '2026-07-19T00:00:00.000Z',
        data: {
          code: '001234',
          name: '单一持股基金',
          holdings: [{ stockCode: '688041', holdingRatio: 4.8 }]
        }
      }
    }
  }
  const funds = findRelatedFundsFromConstituentHoldings(
    [{ code: '688041' }, { code: '688981' }],
    persistedHoldings,
    [{ code: '008888', name: '半导体基金C' }, { code: '001234', name: '单一持股基金' }],
    new Map([['008888', { name: '半导体基金C', nav: 1.2345, changePercent: 1.2, navDate: '2026-07-18' }]])
  )

  assert.equal(funds.length, 2)
  assert.equal(funds[0].code, '008888')
  assert.equal(funds[0].relatedSource, 'constituent_holdings')
  assert.equal(funds[0].relatedMatchCount, 2)
  assert.equal(funds[0].relatedHoldingRatio, 5.5)
})

test('aggregates matching funds from constituent stock holder data', () => {
  const funds = buildConstituentFundMatches({
    '300750': [
      { ORG_TYPE_CODE: '1', HOLDER_CODE: '159915', HOLDER_NAME: '创业板ETF', REPORT_DATE: '2026-03-31', NETASSET_RATIO: 21.2 },
      { ORG_TYPE_CODE: '1', HOLDER_CODE: '159915', HOLDER_NAME: '创业板ETF', REPORT_DATE: '2025-12-31', NETASSET_RATIO: 20.1 },
      { ORG_TYPE_CODE: '7', HOLDER_CODE: '123456', HOLDER_NAME: '非基金', REPORT_DATE: '2026-03-31', NETASSET_RATIO: 99 }
    ],
    '300432': [
      { ORG_TYPE_CODE: '1', HOLDER_CODE: '159915', HOLDER_NAME: '创业板ETF', REPORT_DATE: '2026-03-31', NETASSET_RATIO: 1.8 },
      { ORG_TYPE_CODE: '1', HOLDER_CODE: '161725', HOLDER_NAME: '新能源基金', REPORT_DATE: '2026-03-31', NETASSET_RATIO: 6.4 }
    ]
  }, [], new Map())

  assert.equal(funds.length, 2)
  assert.equal(funds[0].code, '159915')
  assert.equal(funds[0].relatedMatchCount, 2)
  assert.equal(funds[0].relatedHoldingRatio, 23)
  assert.equal(funds[0].reportDate, '2026-03-31')
})
