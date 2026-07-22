import test from 'node:test'
import assert from 'node:assert/strict'

import {
  classifyFund,
  createQdiiHoldingsEstimate,
  getEligibleEstimateMarketDate,
  isEstimateEligibleForMarket,
  isEstimateSessionActive,
  parseFundHistoryPayload,
  parseFundHoldingsHtml,
  parseFundHoldingPeriodsHtml,
  parseSinaEstimatePayload,
  selectVerifiedOverseasMarket
} from './fund-data-service.mjs'
import { getFundEstimateMarketState } from './cache.mjs'

test('keeps mainland fallback estimates active until 20:00 after the close', () => {
  const fund = { name: '测试混合基金', type: '混合型-偏股' }
  const afterClose = getFundEstimateMarketState(fund, new Date('2026-07-20T07:00:00Z'))
  const afterWindow = getFundEstimateMarketState(fund, new Date('2026-07-20T12:01:00Z'))

  assert.equal(isEstimateSessionActive(afterClose), true)
  assert.equal(isEstimateSessionActive(afterWindow), false)
})

test('retains a Hong Kong close only until the next session opens', () => {
  const fund = { name: '\u6052\u751f QDII', type: 'QDII' }
  const close = getFundEstimateMarketState(fund, new Date('2026-07-21T08:04:00Z'))
  const nextPreOpen = getFundEstimateMarketState(fund, new Date('2026-07-22T01:00:00Z'))
  const nextOpen = getFundEstimateMarketState(fund, new Date('2026-07-22T01:30:00Z'))
  const estimate = { marketDate: '2026-07-21', gszzl: '-0.53' }

  assert.equal(getEligibleEstimateMarketDate(close), '2026-07-21')
  assert.equal(getEligibleEstimateMarketDate(nextPreOpen), '2026-07-21')
  assert.equal(isEstimateEligibleForMarket(estimate, close), true)
  assert.equal(isEstimateEligibleForMarket(estimate, nextPreOpen), true)
  assert.equal(isEstimateEligibleForMarket(estimate, nextOpen), false)
})

test('uses the New York trading date for global QDII cache eligibility', () => {
  const fund = { name: '\u5168\u7403\u79d1\u6280 QDII', type: 'QDII' }
  const preOpen = getFundEstimateMarketState(fund, new Date('2026-07-21T12:30:00Z'))
  const open = getFundEstimateMarketState(fund, new Date('2026-07-21T13:30:00Z'))
  const afterClose = getFundEstimateMarketState(fund, new Date('2026-07-21T20:05:00Z'))

  assert.equal(getEligibleEstimateMarketDate(preOpen), '2026-07-20')
  assert.equal(getEligibleEstimateMarketDate(open), '2026-07-21')
  assert.equal(getEligibleEstimateMarketDate(afterClose), '2026-07-21')
  assert.equal(isEstimateEligibleForMarket({ marketDate: '2026-07-20' }, preOpen), true)
  assert.equal(isEstimateEligibleForMarket({ marketDate: '2026-07-20' }, open), false)
  assert.equal(isEstimateEligibleForMarket({ marketDate: '2026-07-21' }, afterClose), true)
})

test('classifies WealthAgent valuation strategies by fund type', () => {
  assert.equal(classifyFund({ name: '沪深300ETF', type: '指数型' }).valuationType, 'real_time_price')
  assert.equal(classifyFund({ name: '沪深300ETF联接A', type: '指数型' }).valuationType, 'index_based')
  assert.equal(classifyFund({ name: '全球精选QDII', type: 'QDII' }).valuationType, 'hybrid_qdii')
  assert.equal(classifyFund({ name: '稳健二级债', type: '债券型' }).valuationType, 'hybrid_bond')
  assert.equal(classifyFund({ name: '现金宝货币A', type: '货币型' }).valuationType, 'not_supported')
})

test('normalizes Eastmoney NAV history', () => {
  const items = parseFundHistoryPayload({ Data: { LSJZList: [{
    FSRQ: '2026/07/17', DWJZ: '1.2345', LJJZ: '2.3456', JZZZL: '-1.23',
    SGZT: '开放申购', SHZT: '开放赎回', NAVTYPE: '1'
  }] } }, '000001')
  assert.deepEqual(items[0], {
    code: '000001', date: '2026-07-17', nav: 1.2345, accumulatedNav: 2.3456,
    changePercent: -1.23, purchaseStatus: '开放申购', redemptionStatus: '开放赎回',
    dividend: null, navType: '1'
  })
})

test('parses F10 holdings with market prefixes and report date', () => {
  const html = `<a title='测试基金' href='x'>测试基金</a>截止至：<font>2026-03-31</font>
    <table><tbody><tr><td>1</td><td><a href='//quote.eastmoney.com/unify/r/0.300308'>300308</a></td>
    <td class='tol'><a>中际旭创</a></td><td></td><td></td><td></td><td>4.31%</td><td>20.00</td><td>11,388.20</td></tr></tbody></table>`
  const parsed = parseFundHoldingsHtml(html, '000001')
  assert.equal(parsed.fundName, '测试基金')
  assert.equal(parsed.reportDate, '2026-03-31')
  assert.deepEqual(parsed.holdings[0], {
    fundCode: '000001', stockCode: '300308', stockName: '中际旭创', marketPrefix: '0',
    holdingRatio: 4.31, holdingShares: 20, holdingMarketValue: 11388.2, reportDate: '2026-03-31'
  })
})

test('reclassifies only Yahoo-verified overseas F10 holdings with a domestic name mismatch', () => {
  const korean = selectVerifiedOverseasMarket(
    { stockCode: '005930', stockName: '三星电子', marketPrefix: '0' },
    { name: '*ST 南华' },
    [{ marketPrefix: 'kr', symbol: '005930.KS', exchange: 'KSC', industry: 'Consumer Electronics' }]
  )
  const japanese = selectVerifiedOverseasMarket(
    { stockCode: '285A', stockName: 'KIOXIA', marketPrefix: '0' },
    null,
    [{ marketPrefix: 'jp', symbol: '285A.T', exchange: 'JPX', industry: 'Semiconductors' }]
  )
  const mainland = selectVerifiedOverseasMarket(
    { stockCode: '000660', stockName: '*ST 南华', marketPrefix: '0' },
    { name: '*ST 南华' },
    [{ marketPrefix: 'kr', symbol: '000660.KS', exchange: 'KSC', industry: 'Semiconductors' }]
  )

  assert.equal(korean.marketPrefix, 'kr')
  assert.equal(japanese.marketPrefix, 'jp')
  assert.equal(mainland.marketPrefix, '0')
})

test('keeps one highest-weight position when F10 repeats a security in one report', () => {
  const row = ratio => `<tr><td>1</td><td><a href="//quote.eastmoney.com/unify/r/1.601318">601318</a></td><td>Ping An</td><td></td><td></td><td></td><td>${ratio}%</td><td>20</td><td>100</td></tr>`
  const parsed = parseFundHoldingsHtml(`截止至：<font>2026-06-30</font><table>${row('3.90')}${row('1.75')}</table>`, '165517')

  assert.equal(parsed.holdings.length, 1)
  assert.equal(parsed.holdings[0].holdingRatio, 3.9)
})

test('parses multiple disclosure periods from one F10 response', () => {
  const table = ratio => `<table class="tzxq"><tr><td>1</td><td><a href="https://quote.eastmoney.com/unify/r/105.NVDA">NVDA</a></td><td>NVIDIA</td><td>1.00%</td><td>${ratio}%</td><td>20</td><td>100</td></tr></table>`
  const periods = parseFundHoldingPeriodsHtml(`2026-06-30${table('6.5')}2026-03-31${table('5.0')}`, '100055')
  assert.deepEqual(periods.map(period => period.reportDate), ['2026-06-30', '2026-03-31'])
  assert.equal(periods[0].holdings[0].marketPrefix, '105')
})

test('normalizes both Sina estimate variants', () => {
  const parsed = parseSinaEstimatePayload({ result: { data: {
    worth: '1.3190', worth_date: '20260717', networth: [{
      min_time: '15:00:00', pre_nav: '1.3182', growthrate: -0.0604419,
      pre_nav2: '1.3273', growthrate2: '-0.053956', pre_date: '2026-07-17'
    }]
  } } }, '000001')
  assert.equal(parsed.actualNavDate, '2026-07-17')
  assert.equal(parsed.sina_ds2.gsz, '1.3182')
  assert.equal(parsed.sina_ds2.gszzl, '-6.04')
  assert.equal(parsed.sina_ds3.gszzl, '-5.40')
})

test('creates a QDII estimate from disclosed real-time holdings without normalizing missing weight', () => {
  const estimate = createQdiiHoldingsEstimate('100055', {
    name: 'Test QDII', type: 'QDII', snapshot: { previousNav: 2 }
  }, [
    { holdingRatio: 10, dayChange: 2 },
    { holdingRatio: 15, dayChange: -1 },
    { holdingRatio: 8, dayChange: null }
  ], new Date('2026-07-20T14:00:00Z'))

  assert.equal(estimate.source, 'holdings_weighted')
  assert.equal(estimate.gszzl, '0.05')
  assert.equal(estimate.gsz, '2.0010')
  assert.deepEqual(estimate.coverage, { quotedCount: 2, disclosedWeight: 25 })
})

test('rejects a QDII holdings estimate with insufficient quoted coverage', () => {
  const estimate = createQdiiHoldingsEstimate('100055', {
    snapshot: { previousNav: 2 }
  }, [{ holdingRatio: 10, dayChange: 2 }])
  assert.equal(estimate, null)
})
