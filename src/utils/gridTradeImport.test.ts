import test from 'node:test'
import assert from 'node:assert/strict'

import {
  calculateGridConversionTransferIn,
  resolveGridTradeConfirmationDate,
  resolveGridTradeDirection
} from './gridTradeImport.ts'

const navDates = ['2026-07-01', '2026-07-02', '2026-07-03', '2026-07-06']

test('uses same-day NAV before 15:00 and the next trading NAV from 15:00 onward', () => {
  assert.equal(resolveGridTradeConfirmationDate('2026-07-02', '14:59:59', navDates), '2026-07-02')
  assert.equal(resolveGridTradeConfirmationDate('2026-07-02', '15:00:00', navDates), '2026-07-03')
  assert.equal(resolveGridTradeConfirmationDate('2026-07-02', '18:30:00', navDates), '2026-07-03')
})

test('moves weekend and holiday orders to the next available NAV date', () => {
  assert.equal(resolveGridTradeConfirmationDate('2026-07-04', '10:00:00', navDates), '2026-07-06')
  assert.equal(resolveGridTradeConfirmationDate('2026-07-06', '15:00:00', navDates), '')
})

test('always treats transfer-in as buy and resolves conversion direction by arrow side', () => {
  assert.equal(resolveGridTradeDirection({ type: 'sell', operation: 'transfer_in' }, '024975'), 'buy')
  const conversion = {
    type: 'sell' as const,
    operation: 'conversion',
    source_fund_code: '017472',
    target_fund_code: '024975',
    source_fund_name: '国泰中证机床ETF发起联接C',
    target_fund_name: '华泰柏瑞上证科创板半导体材料设备主题ETF发起...'
  }
  assert.equal(resolveGridTradeDirection(conversion, '017472'), 'sell')
  assert.equal(resolveGridTradeDirection(conversion, '024975'), 'buy')
  assert.equal(resolveGridTradeDirection(conversion, '', '华泰柏瑞上证科创板半导体材料设备主题ETF发起式联接C'), 'buy')
})

test('converts source shares to a rounded amount before calculating target shares', () => {
  assert.deepEqual(calculateGridConversionTransferIn(482.28, 1.2347, 1.5678), {
    amount: 595.47,
    targetShares: 379.81
  })
  assert.equal(calculateGridConversionTransferIn(0, 1.2, 1.3), null)
})

test('matches the supplied 017472 to 024975 conversion sample', () => {
  const conversion = {
    type: 'sell' as const,
    operation: 'conversion',
    source_fund_code: '017472',
    target_fund_code: '024975'
  }
  assert.equal(resolveGridTradeDirection(conversion, '024975'), 'buy')
  assert.equal(resolveGridTradeConfirmationDate('2026-07-10', '14:39:15', ['2026-07-09', '2026-07-10', '2026-07-13']), '2026-07-10')
  assert.deepEqual(calculateGridConversionTransferIn(400, 2.4084, 3.0442), {
    amount: 963.36,
    targetShares: 316.46
  })
})
