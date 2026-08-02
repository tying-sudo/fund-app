import assert from 'node:assert/strict'
import test from 'node:test'

import { isJdYesterdaySummaryCurrent, selectYesterdayReturnPoint } from './holdingCalculator.ts'

test('expires a stale JD yesterday summary at the Beijing day boundary', () => {
  assert.equal(isJdYesterdaySummaryCurrent({ syncedOn: '2026-07-31', profitDate: '2026-07-31' }, '2026-08-01'), true)
  assert.equal(isJdYesterdaySummaryCurrent({ syncedOn: '2026-07-31', profitDate: '2026-07-30' }, '2026-08-01'), false)
  assert.equal(isJdYesterdaySummaryCurrent({ syncedOn: '2026-07-31' }, '2026-08-01'), false)
  assert.equal(isJdYesterdaySummaryCurrent({ syncedOn: '2026-08-01' }, '2026-08-01'), true)
})

test('uses the latest published return as yesterday after midnight', () => {
  const latest = { date: '2026-07-31', nav: 1.2, changeRate: 2.5 }
  const previous = { date: '2026-07-30', nav: 1.17, changeRate: -1.1 }
  assert.equal(selectYesterdayReturnPoint(latest, previous, '2026-08-01'), latest)
  assert.equal(selectYesterdayReturnPoint({ ...latest, date: '2026-08-01' }, previous, '2026-08-01'), previous)
})
