import assert from 'node:assert/strict'
import test from 'node:test'
import {
  getGridJdPendingRefreshEntries,
  getNextJdTradingDay13At,
  mergeGridJdPendingRefreshEntries,
  reconcileGridJdPendingRefreshEntries
} from './gridJdPendingRefresh.ts'
import type { GridJdImportPayload } from './gridJdImport.ts'

test('schedules JD rechecks by the 15:00 cutoff and weekday sessions', () => {
  assert.equal(
    getNextJdTradingDay13At('2026-08-07', '2026-08-07 14:59:59'),
    Date.parse('2026-08-10T13:00:00+08:00')
  )
  assert.equal(
    getNextJdTradingDay13At('2026-08-07', '2026-08-07 15:01:00'),
    Date.parse('2026-08-11T13:00:00+08:00')
  )
  assert.equal(
    getNextJdTradingDay13At('2026-08-04', '14:42:49'),
    Date.parse('2026-08-05T13:00:00+08:00')
  )
  assert.equal(
    getNextJdTradingDay13At('2026-08-04', '15:00:00'),
    Date.parse('2026-08-06T13:00:00+08:00')
  )
})

test('keeps only selected pending inbound orders in the refresh queue', () => {
  const payload = {
    full_current_holding_codes: ['000001', '000002'],
    current_holding_codes: ['000001', '000002'],
    replace_transaction_codes: [],
    resolve_current_cycles_on_server: true,
    current_holdings: [],
    adjustments: [
      { id: 'pending-buy', code: '000001', type: 'add', tradeDate: '2026-08-04', tradeTime: '2026-08-04 14:42:49', statusCode: 'PAY_SUCC' },
      { id: 'confirmed-buy', code: '000001', type: 'add', tradeDate: '2026-08-03', statusCode: 'COMPLETE' },
      { id: 'pending-sell', code: '000002', type: 'reduce', tradeDate: '2026-08-04', statusCode: 'REDEEM' }
    ]
  } satisfies GridJdImportPayload

  assert.deepEqual(getGridJdPendingRefreshEntries(payload, ['000001']), [{
    id: 'pending-buy',
    code: '000001',
    tradeDate: '2026-08-04',
    eligibleAt: Date.parse('2026-08-05T13:00:00+08:00')
  }])
})

test('retains the previous retry time when a pending order is rediscovered', () => {
  const previous = [{ id: 'one', code: '000001', tradeDate: '2026-08-04', eligibleAt: 1, lastAttemptAt: 9 }]
  const incoming = [{ id: 'one', code: '000001', tradeDate: '2026-08-04', eligibleAt: 2 }]
  assert.deepEqual(mergeGridJdPendingRefreshEntries(previous, incoming), [{
    id: 'one', code: '000001', tradeDate: '2026-08-04', eligibleAt: 2, lastAttemptAt: 9
  }])
})

test('reconciles each due order without clearing a newer pending buy from a verified fund', () => {
  const queue = [
    { id: 'confirmed', code: '000001', tradeDate: '2026-08-04', eligibleAt: 1 },
    { id: 'still-pending', code: '000001', tradeDate: '2026-08-04', eligibleAt: 1 },
    { id: 'refunded', code: '000002', tradeDate: '2026-08-04', eligibleAt: 1 },
    { id: 'missing', code: '000003', tradeDate: '2026-08-04', eligibleAt: 1 }
  ]
  const latest = [
    { id: 'confirmed', code: '000001', type: 'add' as const, tradeDate: '2026-08-04', statusCode: 'COMPLETE' },
    { id: 'still-pending', code: '000001', type: 'add' as const, tradeDate: '2026-08-04', statusCode: 'PAY_SUCC' },
    { id: 'refunded', code: '000002', type: 'add' as const, tradeDate: '2026-08-04', statusCode: 'REFUND_SUCC' }
  ]

  assert.deepEqual(
    reconcileGridJdPendingRefreshEntries(queue, queue, latest, ['000001']),
    [queue[1], queue[3]]
  )
  assert.deepEqual(
    reconcileGridJdPendingRefreshEntries(queue, queue, latest, []),
    [queue[0], queue[1], queue[3]]
  )
})
