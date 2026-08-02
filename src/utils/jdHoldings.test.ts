import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

import {
  filterJdCurrentPositionCycle,
  getSafeJdClosedHoldingCodes,
  getPendingJdInboundCodes,
  getJdAdjustmentConfirmationAt,
  getJdAdjustmentTagLabel,
  hasReachedJdConfirmationWindow,
  isInactiveJdAdjustment,
  isValidJdTradeDate,
  jdImportErrorMessage,
  normalizeJdCookie,
  normalizeJdClosedHoldingItems,
  normalizeJdImportResult,
  selectVerifiedJdCurrentTimeline,
  shouldShowJdAdjustmentTag,
  summarizeJdAccount,
  toJdSyncProgressState
} from './jdHoldings.ts'
import { buildJdHoldingSnapshot, deriveJdHoldingImportBasis } from './holdingImport.ts'
import { getSettlementNavStartDate } from './tradingDate.ts'

test('Android capture follows JD ten-year pagination instead of a 30-day window', () => {
  const source = readFileSync(new URL('../../android/app/src/main/java/com/fundapp/realtime/JdHoldingsPlugin.java', import.meta.url), 'utf8')
  assert.match(source, /TRADE_HISTORY_YEARS\s*=\s*10/)
  assert.match(source, /ACCOUNT_TRADE_TIMEOUT_SECONDS\s*=\s*120/)
  assert.match(source, /ACCOUNT_TRADE_FIRST_PAGE_TIMEOUT_MILLIS\s*=\s*20_000/)
  assert.match(source, /ACCOUNT_TRADE_STALL_TIMEOUT_MILLIS\s*=\s*12_000/)
  assert.match(source, /tradeOrderVoList/)
  assert.match(source, /vm\.getTradeOrderData\(\)/)
  assert.match(source, /function progress\(page,rows,totalRows,allCount\)/)
  assert.match(source, /progress:true,page:page,rows:rows,totalRows:totalRows,allCount:allCount/)
  assert.match(source, /now-lastPageAt>/)
  assert.match(source, /reportProgress\(\s*"reading_trades",\s*"正在读取京东交易记录：第 "/)
  assert.match(source, /response\.optString\("reason", "京东交易记录分页读取失败"\)/)
  assert.match(source, /Executors\.newFixedThreadPool\(2\)/)
  assert.match(source, /holding\.put\("detailExtJson", extJson\)/)
  assert.match(source, /result\.put\("closedItems", closedItems\)/)
  assert.match(source, /hasExplicitZeroPosition\(amount, shares\)/)
  assert.match(source, /mergeAccountAndDetailTrades\(accountResult\.rows, detailResult\.rows\)/)
  assert.match(source, /new FundTradeRows\(\s*request\.code,\s*new JSONArray\(\),\s*lastError/)
  assert.match(source, /"shares", "targetShares", "status", "statusCode", "confirmTime"/)
  assert.doesNotMatch(source, /TRADE_HISTORY_DAYS/)
  assert.doesNotMatch(source, /近30天京东交易记录/)
})

test('accepts one Cookie header value and rejects header injection', () => {
  assert.equal(normalizeJdCookie('Cookie: pt_key=abc; pt_pin=user'), 'pt_key=abc; pt_pin=user')
  assert.equal(normalizeJdCookie('pt_key=abc\r\nX-Injected: true'), null)
  assert.equal(normalizeJdCookie('not-a-cookie'), null)
})

test('keeps explicit zero snapshots separate and protects pending inbound funds', () => {
  assert.deepEqual(normalizeJdClosedHoldingItems({
    closedItems: [
      { code: '000001', name: 'Closed', amount: '0.00', shares: '0.00' },
      { code: '000002', name: 'Still held', amount: '0.01', shares: '0.00' },
      { code: 'bad', amount: '0.00' }
    ]
  }), [{ code: '000001', name: 'Closed', amount: '0.00', shares: '0.00' }])

  const protectedCodes = getPendingJdInboundCodes([
    { id: 'buy', code: '000003', type: 'add', tradeDate: '2026-08-01', statusCode: 'PAY_SUCC' },
    { id: 'transfer', code: '000004', type: 'convert', targetCode: '000005', tradeDate: '2026-08-01', statusCode: 'PROCESS' },
    { id: 'sell', code: '000006', type: 'reduce', tradeDate: '2026-08-01', statusCode: 'REDEEM' }
  ])
  assert.deepEqual([...protectedCodes].sort(), ['000003', '000005'])
  assert.deepEqual(getSafeJdClosedHoldingCodes(
    [
      { code: '000001', amount: '0.00', shares: '0.00' },
      { code: '000002', amount: '0.00', shares: '0.00' },
      { code: '000005', amount: '0.00', shares: '0.00' }
    ],
    [{ code: '000002', name: 'Positive', amount: '100.00', shares: '10.00' }],
    [
      { id: 'pending-transfer', code: '000004', type: 'convert', targetCode: '000005', tradeDate: '2026-08-01', statusCode: 'PROCESS' }
    ],
    ['000001', '000002', '000005']
  ), ['000001'])
})

test('shares JD import progress and localized native errors across pages', () => {
  assert.deepEqual(toJdSyncProgressState({ stage: 'reading_holdings', message: '读取中', current: 1, total: 2 }), {
    message: '读取中', percentage: 34
  })
  assert.deepEqual(toJdSyncProgressState({ stage: 'completed', message: '完成' }), {
    message: '完成', percentage: 100
  })
  assert.equal(jdImportErrorMessage(new Error('java.lang.IllegalStateException: 京东 Cookie 已过期')), '京东 Cookie 已过期')
  assert.equal(jdImportErrorMessage(new Error('Unauthorized')), '京东 Cookie 已过期或无效，请更新后重试')
})

test('preserves decoded audit rows without certifying an incomplete current cycle', () => {
  const result = normalizeJdImportResult({
    items: [
      { code: '000001', name: '华夏成长混合', amount: '1200.00', yesterdayIncome: '-12.34', profitDate: '2026-07-23', profit: '200.00', shares: '900.00' },
      { code: '000002', name: '已清仓基金', amount: '0.00', shares: '0.00' },
      { code: 'invalid', name: '忽略' }
    ],
    adjustments: [
      { id: 'buy-1', code: '000001', type: 'add', tradeDate: '2026-07-23', shares: '100', status: '支付成功', statusCode: 'pay_succ', confirmTime: '2026-07-25 12:00:00' },
      { id: 'convert-1', code: '000001', type: 'convert', tradeDate: '2026-07-22', tradeTime: '2026-07-22 14:32:10', targetCode: '000002', targetShares: '80', status: '订单完成' },
      { id: 'bad', code: '000001', type: 'other', tradeDate: '2026-07-22' }
    ]
  })

  assert.deepEqual(result.items, [{
    code: '000001',
    name: '华夏成长混合',
    amount: '1200.00',
    yesterdayIncome: '-12.34',
    profit: '200.00',
    shares: '900.00',
    rate: undefined,
    costPrice: undefined,
    profitDate: '2026-07-23'
  }])
  assert.deepEqual(result.summary, {
    yesterdayProfit: -12.34,
    yesterdayBaseValue: 1212.34,
    profitDate: '2026-07-23'
  })
  assert.equal(result.adjustments.length, 0)
  assert.equal(result.timelineAdjustments.length, 2)
  assert.deepEqual(result.timelineAdjustments.find((item) => item.id === 'buy-1'), {
    id: 'buy-1',
    code: '000001',
    name: undefined,
    type: 'add',
    tradeDate: '2026-07-23',
    tradeTime: undefined,
    shares: '100',
    amount: undefined,
    targetCode: undefined,
    targetName: undefined,
    targetShares: undefined,
    status: '支付成功',
    statusCode: 'PAY_SUCC',
    confirmTime: '2026-07-25 12:00:00'
  })
  assert.deepEqual(result.timelineAdjustments.find((item) => item.id === 'convert-1'), {
    id: 'convert-1',
    code: '000001',
    name: undefined,
    type: 'convert',
    tradeDate: '2026-07-22',
    tradeTime: '2026-07-22 14:32:10',
    shares: undefined,
    amount: undefined,
    targetCode: '000002',
    targetName: undefined,
    targetShares: '80',
    status: '订单完成',
    statusCode: undefined,
    confirmTime: undefined
  })
  assert.deepEqual(result.verifiedTimelineCodes, [])
})

test('keeps a usable current-holding snapshot when the account trade page warns', () => {
  const result = normalizeJdImportResult({
    items: [{ code: '000001', name: '当前持仓', amount: '120.00', profit: '-8.00', shares: '100.00' }],
    adjustments: [],
    tradeWarning: '交易记录未完整读取，请稍后重新同步',
    tradeDiagnostic: '交易记录诊断：账号 1 页、原始 20 条、有效 12 条'
  })

  assert.equal(result.items.length, 1)
  assert.equal(result.adjustments.length, 0)
  assert.equal(result.tradeWarning, '交易记录未完整读取，请稍后重新同步')
  assert.equal(result.tradeDiagnostic, '交易记录诊断：账号 1 页、原始 20 条、有效 12 条')
})

test('uses JD market value and profit before an ambiguously labelled cost field', () => {
  assert.deepEqual(deriveJdHoldingImportBasis({
    amount: '200.00',
    profit: '20.00',
    shares: '100.00',
    costAmount: '2.00',
    costPrice: '2.00'
  }), {
    principal: 180,
    shares: 100,
    costPrice: 1.8
  })
})

test('keeps JD official current-position amounts separate from local intraday valuation', () => {
  assert.deepEqual(buildJdHoldingSnapshot({
    amount: '9009.87',
    profit: '-1453.77',
    rate: '-13.89%',
    shares: '3612.33',
    costAmount: '10463.6400',
    costPrice: '2.8966'
  }, 1_784_600_000_000), {
    source: 'jd',
    amount: 9009.87,
    profit: -1453.77,
    profitRate: -13.89,
    shares: 3612.33,
    costAmount: 10463.64,
    costPrice: 2.8966,
    syncedAt: 1_784_600_000_000
  })
})

test('keeps the JD yesterday-profit total separate and rejects partial totals', () => {
  assert.deepEqual(summarizeJdAccount([
    { code: '000001', name: '基金一', amount: '10517.66', yesterdayIncome: '-64.94' },
    { code: '000002', name: '基金二', amount: '8743.64', yesterdayIncome: '-326.00' },
    { code: '000003', name: '基金三', amount: '5064.13', yesterdayIncome: '-87.80' },
    { code: '000004', name: '基金四', amount: '3692.69', yesterdayIncome: '+35.04' },
    { code: '000005', name: '基金五', amount: '683.84', yesterdayIncome: '+2.87' }
  ]), {
    yesterdayProfit: -440.83,
    yesterdayBaseValue: 29142.79,
    profitDate: undefined
  })
  assert.equal(summarizeJdAccount([
    { code: '000001', name: '基金一', amount: '100.00', yesterdayIncome: '-1.00' },
    { code: '000002', name: '基金二', amount: '200.00' }
  ]), undefined)
})

test('keeps only the current position cycle after a confirmed full exit', () => {
  const current = [{ code: '000001', name: 'Current', shares: '22' }]
  const adjustments = filterJdCurrentPositionCycle(current, [
    { id: 'old-buy', code: '000001', type: 'add', tradeDate: '2026-01-02', shares: '100', statusCode: 'COMPLETE' },
    { id: 'old-exit', code: '000001', type: 'reduce', tradeDate: '2026-02-03', shares: '100', statusCode: 'REDEEM_SUCC' },
    { id: 'current-buy', code: '000001', type: 'add', tradeDate: '2026-03-04', shares: '20', statusCode: 'COMPLETE' },
    { id: 'current-sell', code: '000001', type: 'reduce', tradeDate: '2026-04-05', shares: '5', statusCode: 'REDEEM_SUCC' },
    { id: 'transfer-in', code: '000002', type: 'convert', tradeDate: '2026-04-06', shares: '8', targetCode: '000001', targetShares: '7', statusCode: 'COMPLETE' }
  ])

  assert.deepEqual(adjustments.map((item) => item.id), ['current-buy', 'current-sell', 'transfer-in'])
})

test('keeps pending rows in a verified cycle without reconciling them against current shares', () => {
  const selection = selectVerifiedJdCurrentTimeline(
    [{ code: '000001', name: 'Current', shares: '100' }],
    [
      { id: 'opening-buy', code: '000001', type: 'add', tradeDate: '2026-07-01', shares: '100', statusCode: 'COMPLETE' },
      { id: 'pending-sell', code: '000001', type: 'reduce', tradeDate: '2026-07-30', shares: '20', statusCode: 'REDEEM' }
    ]
  )

  assert.deepEqual([...selection.verifiedCodes], ['000001'])
  assert.deepEqual(selection.adjustments.map((item) => item.id), ['opening-buy', 'pending-sell'])
})

test('rejects an overshooting partial capture while accepting an exact current-cycle balance', () => {
  const current = [{ code: '000001', name: 'Current', shares: '40' }]
  const overshooting = selectVerifiedJdCurrentTimeline(current, [
    { id: 'captured-buy', code: '000001', type: 'add', tradeDate: '2026-07-01', shares: '100', statusCode: 'COMPLETE' }
  ])
  const reconciled = selectVerifiedJdCurrentTimeline(current, [
    { id: 'opening-buy', code: '000001', type: 'add', tradeDate: '2026-07-01', shares: '60', statusCode: 'COMPLETE' },
    { id: 'partial-sell', code: '000001', type: 'reduce', tradeDate: '2026-07-02', shares: '20', statusCode: 'REDEEM_SUCC' }
  ])

  assert.deepEqual([...overshooting.verifiedCodes], [])
  assert.deepEqual([...overshooting.incompleteCodes], ['000001'])
  assert.deepEqual(overshooting.adjustments, [])
  assert.deepEqual([...reconciled.verifiedCodes], ['000001'])
  assert.deepEqual(reconciled.adjustments.map((item) => item.id), ['opening-buy', 'partial-sell'])
})

test('keeps amount-only rows out of current-cycle replacement when they cannot be reconciled', () => {
  const selection = selectVerifiedJdCurrentTimeline(
    [{ code: '000001', name: 'Current', shares: '60' }],
    [
      { id: 'buy', code: '000001', type: 'add', tradeDate: '2026-07-01', shares: '100', amount: '100' },
      { id: 'sell-without-shares', code: '000001', type: 'reduce', tradeDate: '2026-07-02', amount: '40' }
    ]
  )

  assert.deepEqual(selection.adjustments, [])
  assert.deepEqual([...selection.verifiedCodes], [])
  assert.deepEqual([...selection.incompleteCodes], ['000001'])
  assert.deepEqual(filterJdCurrentPositionCycle(
    [{ code: '000001', name: 'Current', shares: '60' }],
    [
      { id: 'buy', code: '000001', type: 'add', tradeDate: '2026-07-01', shares: '100', amount: '100' },
      { id: 'sell-without-shares', code: '000001', type: 'reduce', tradeDate: '2026-07-02', amount: '40' }
    ]
  ).map((item) => item.id), [])
})

test('does not mix an incomplete fund history into another verified cycle', () => {
  const filtered = filterJdCurrentPositionCycle(
    [
      { code: '000001', name: 'Verified', shares: '10' },
      { code: '000002', name: 'Incomplete', shares: '20' }
    ],
    [
      { id: 'verified-buy', code: '000001', type: 'add', tradeDate: '2026-01-01', shares: '10', statusCode: 'COMPLETE' },
      { id: 'amount-only', code: '000002', type: 'add', tradeDate: '2026-01-02', amount: '20' }
    ]
  )

  assert.deepEqual(filtered.map((item) => item.id), ['verified-buy'])
  assert.deepEqual(filtered.find((item) => item.id === 'verified-buy')?.cycleCodes, ['000001'])
})

test('keeps inactive JD orders in audit input but excludes them from position reconstruction', () => {
  const current = [{ code: '000001', name: 'Current', shares: '100' }]
  const adjustments = [
    { id: 'buy', code: '000001', type: 'add' as const, tradeDate: '2026-07-28', shares: '100', statusCode: 'COMPLETE' },
    { id: 'cancelled-sell', code: '000001', type: 'reduce' as const, tradeDate: '2026-07-29', shares: '50', statusCode: 'CANCELED' },
    { id: 'refunded-buy', code: '000001', type: 'add' as const, tradeDate: '2026-07-29', shares: '50', statusCode: 'REFUND_SUCC' }
  ]

  assert.deepEqual(selectVerifiedJdCurrentTimeline(current, adjustments).adjustments.map((item) => item.id), ['buy'])
  assert.deepEqual(filterJdCurrentPositionCycle(current, adjustments).map((item) => item.id), ['buy'])
})

test('uses JD confirmation windows for tag visibility and grid eligibility', () => {
  const beforeClose = { id: 'before', code: '000001', type: 'add' as const, tradeDate: '2026-07-24', tradeTime: '2026-07-24 14:59:00', status: '支付成功' }
  const afterClose = { id: 'after', code: '000001', type: 'add' as const, tradeDate: '2026-07-24', tradeTime: '2026-07-24 15:01:00' }
  const completed = { ...beforeClose, status: '订单完成' }

  assert.equal(hasReachedJdConfirmationWindow(beforeClose, Date.parse('2026-07-25T11:59:00+08:00')), false)
  assert.equal(hasReachedJdConfirmationWindow(beforeClose, Date.parse('2026-07-25T12:00:00+08:00')), true)
  assert.equal(hasReachedJdConfirmationWindow(afterClose, Date.parse('2026-07-25T14:59:00+08:00')), false)
  assert.equal(hasReachedJdConfirmationWindow(afterClose, Date.parse('2026-07-25T15:00:00+08:00')), true)
  assert.equal(hasReachedJdConfirmationWindow(completed, Date.parse('2026-07-24T09:00:00+08:00')), true)
  assert.equal(getSettlementNavStartDate('2026-07-24', 'before'), '2026-07-25')
  assert.equal(getSettlementNavStartDate('2026-07-24', 'after'), '2026-07-26')
})

test('uses real JD status codes and confirmation time for holding tags', () => {
  const waitingBuy = {
    id: 'buy',
    code: '000001',
    type: 'add' as const,
    tradeDate: '2026-07-29',
    tradeTime: '2026-07-29 10:30:00',
    status: '支付成功',
    statusCode: 'PAY_SUCC',
    confirmTime: '2026-07-31 12:00:00'
  }
  const waitingSell = { ...waitingBuy, id: 'sell', type: 'reduce' as const, status: '转出中', statusCode: 'REDEEM' }
  const waitingConversion = {
    ...waitingBuy,
    id: 'convert',
    type: 'convert' as const,
    status: '处理中',
    statusCode: 'PROCESS',
    targetCode: '000002'
  }
  const beforeConfirmation = Date.parse('2026-07-31T11:59:59+08:00')
  const atConfirmation = Date.parse('2026-07-31T12:00:00+08:00')

  assert.equal(getJdAdjustmentConfirmationAt(waitingBuy), atConfirmation)
  assert.equal(getJdAdjustmentConfirmationAt({
    ...waitingSell,
    confirmTime: '预计2026-08-05到账'
  }), Date.parse('2026-08-05T15:00:00+08:00'))
  assert.equal(shouldShowJdAdjustmentTag(waitingBuy, beforeConfirmation), true)
  assert.equal(shouldShowJdAdjustmentTag(waitingSell, beforeConfirmation), true)
  assert.equal(shouldShowJdAdjustmentTag(waitingConversion, beforeConfirmation), true)
  assert.equal(shouldShowJdAdjustmentTag(waitingBuy, atConfirmation), false)
  assert.equal(getJdAdjustmentTagLabel(waitingBuy, '000001'), '调仓·买入')
  assert.equal(getJdAdjustmentTagLabel(waitingSell, '000001'), '调仓·卖出')
  assert.equal(getJdAdjustmentTagLabel(waitingConversion, '000001'), '调仓·转换')
  assert.equal(getJdAdjustmentTagLabel(waitingConversion, '000002'), '调仓·转换')
  assert.equal(getJdAdjustmentTagLabel(waitingConversion, '000003'), null)
})

test('hides completed, cancelled, refunded and failed JD orders while retaining their audit state', () => {
  const base = {
    id: 'order',
    code: '000001',
    type: 'add' as const,
    tradeDate: '2026-07-29',
    tradeTime: '2026-07-29 10:30:00',
    confirmTime: '2026-07-31 12:00:00'
  }
  const completed = { ...base, status: '订单完成', statusCode: 'COMPLETE' }
  const redeemed = { ...base, type: 'reduce' as const, status: '转出完成', statusCode: 'REDEEM_SUCC' }
  const cancelled = { ...base, status: '已取消', statusCode: 'CANCELED' }
  const refunded = { ...base, status: '退款成功', statusCode: 'REFUND_SUCC' }
  const failed = { ...base, status: '交易失败', statusCode: 'FAILED' }
  const beforeConfirmation = Date.parse('2026-07-30T12:00:00+08:00')

  assert.equal(shouldShowJdAdjustmentTag(completed, beforeConfirmation), false)
  assert.equal(shouldShowJdAdjustmentTag(redeemed, beforeConfirmation), false)
  assert.equal(hasReachedJdConfirmationWindow(completed, beforeConfirmation), true)
  assert.equal(hasReachedJdConfirmationWindow(redeemed, beforeConfirmation), true)
  for (const inactive of [cancelled, refunded, failed]) {
    assert.equal(isInactiveJdAdjustment(inactive), true)
    assert.equal(shouldShowJdAdjustmentTag(inactive, beforeConfirmation), false)
    assert.equal(hasReachedJdConfirmationWindow(inactive, Date.parse('2026-08-01T12:00:00+08:00')), false)
  }
})

test('does not treat malformed JD transaction dates as confirmed', () => {
  const malformed = { id: 'malformed', code: '000001', type: 'add' as const, tradeDate: '07-03', status: '订单完成' }
  const impossible = { ...malformed, id: 'impossible', tradeDate: '2026-02-31' }

  assert.equal(isValidJdTradeDate(malformed.tradeDate), false)
  assert.equal(isValidJdTradeDate(impossible.tradeDate), false)
  assert.equal(hasReachedJdConfirmationWindow(malformed), false)
  assert.equal(hasReachedJdConfirmationWindow(impossible), false)
})

test('keeps an opening purchase older than thirty days in the current cycle', () => {
  const result = normalizeJdImportResult({
    items: [{ code: '000001', name: 'Long held', shares: '60' }],
    adjustments: [
      { id: 'opening', code: '000001', type: 'add', tradeDate: '2024-01-02', shares: '100', statusCode: 'COMPLETE' },
      { id: 'partial-sell', code: '000001', type: 'reduce', tradeDate: '2026-07-26', shares: '40', statusCode: 'REDEEM_SUCC' }
    ]
  })

  assert.deepEqual(result.timelineAdjustments.map((item) => item.id), ['opening', 'partial-sell'])
  assert.deepEqual(result.verifiedTimelineCodes, ['000001'])
})
