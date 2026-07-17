import assert from 'node:assert/strict'
import {
  calculateSubscriptionShares,
  findSettlementNav,
  getBeijingDateString,
  getCalendarDayDifference,
  getSettlementNavStartDate
} from '../src/utils/tradingDate.ts'

const history = [
  { date: '2026-07-21', netValue: 1.024, totalValue: 0, changeRate: 0.3 },
  { date: '2026-07-20', netValue: 1.021, totalValue: 0, changeRate: 0.2 },
  { date: '2026-07-17', netValue: 1.01, totalValue: 0, changeRate: 0.1 }
]

assert.equal(getSettlementNavStartDate('2026-07-17', 'before'), '2026-07-17')
assert.equal(getSettlementNavStartDate('2026-07-17', 'after'), '2026-07-18')
assert.equal(findSettlementNav(history, '2026-07-18', '2026-07-17'), null)
assert.equal(findSettlementNav(history, '2026-07-18', '2026-07-20')?.date, '2026-07-20')
assert.equal(findSettlementNav(history, '2026-07-17', '2026-07-21')?.date, '2026-07-17')
assert.equal(calculateSubscriptionShares(10_000, 15, 1.2), 8_320.833333333334)
assert.equal(calculateSubscriptionShares(10_000, 10_000, 1.2), 0)
assert.equal(getCalendarDayDifference('2026-07-10', '2026-07-20'), 10)
assert.equal(getBeijingDateString(new Date('2026-07-15T16:30:00.000Z')), '2026-07-16')

console.log('Holding settlement checks passed.')
