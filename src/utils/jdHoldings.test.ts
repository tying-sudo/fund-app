import assert from 'node:assert/strict'
import test from 'node:test'

import {
  filterJdCurrentPositionCycle,
  hasReachedJdConfirmationWindow,
  normalizeJdCookie,
  normalizeJdImportResult,
  selectVerifiedJdCurrentTimeline,
  summarizeJdAccount
} from './jdHoldings.ts'
import { getSettlementNavStartDate } from './tradingDate.ts'

test('accepts one Cookie header value and rejects header injection', () => {
  assert.equal(normalizeJdCookie('Cookie: pt_key=abc; pt_pin=user'), 'pt_key=abc; pt_pin=user')
  assert.equal(normalizeJdCookie('pt_key=abc\r\nX-Injected: true'), null)
  assert.equal(normalizeJdCookie('not-a-cookie'), null)
})

test('normalizes current JD holdings and 30-day adjustment records', () => {
  const result = normalizeJdImportResult({
    items: [
      { code: '000001', name: '华夏成长混合', amount: '1200.00', yesterdayIncome: '-12.34', profitDate: '2026-07-23', profit: '200.00', shares: '900.00' },
      { code: '000002', name: '已清仓基金', amount: '0.00', shares: '0.00' },
      { code: 'invalid', name: '忽略' }
    ],
    adjustments: [
      { id: 'buy-1', code: '000001', type: 'add', tradeDate: '2026-07-23', shares: '100', status: '支付成功' },
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
  assert.equal(result.adjustments.length, 2)
  assert.deepEqual(result.adjustments.find((item) => item.id === 'convert-1'), {
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
    status: '订单完成'
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
  const current = [{ code: '000001', name: 'Current', shares: '15' }]
  const adjustments = filterJdCurrentPositionCycle(current, [
    { id: 'old-buy', code: '000001', type: 'add', tradeDate: '2026-01-02', shares: '100' },
    { id: 'old-exit', code: '000001', type: 'reduce', tradeDate: '2026-02-03', shares: '100' },
    { id: 'current-buy', code: '000001', type: 'add', tradeDate: '2026-03-04', shares: '20' },
    { id: 'current-sell', code: '000001', type: 'reduce', tradeDate: '2026-04-05', shares: '5' },
    { id: 'transfer-in', code: '000002', type: 'convert', tradeDate: '2026-04-06', shares: '8', targetCode: '000001', targetShares: '7' }
  ])

  assert.deepEqual(adjustments.map((item) => item.id), ['current-buy', 'current-sell', 'transfer-in'])
})

test('rejects a grid timeline when a current-cycle transaction lacks shares', () => {
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
