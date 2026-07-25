import test from 'node:test'
import assert from 'node:assert/strict'

import { resolveWatchlistDisplayValue, resolveWatchlistSnapshot } from './watchlistSnapshot.ts'

test('a newer official market snapshot replaces the previous cached return and value', () => {
  const result = resolveWatchlistSnapshot({
    estimate: {
      fundcode: '008888',
      name: 'sample',
      dwjz: '2.2540',
      gsz: '2.2232',
      gszzl: '-1.37',
      gztime: '2026-07-22 15:00',
      source: 'market_snapshot'
    },
    incomingChange: 11.04,
    incomingDate: '2026-07-21',
    cachedChange: 11.04,
    cachedDate: '2026-07-21'
  })

  assert.deepEqual(result, {
    realChange: -1.37,
    realChangeDate: '2026-07-22',
    officialValue: '2.2232',
    officialValueDate: '2026-07-22'
  })
  assert.equal(resolveWatchlistDisplayValue({
    estimateValue: '2.2232',
    lastValue: '2.2540',
    realChange: result.realChange,
    realChangeDate: result.realChangeDate,
    officialValue: result.officialValue,
    officialValueDate: result.officialValueDate,
    isCurrentReal: true
  }), '2.2232')
})

test('falls back to calculating from the previous NAV when no paired official value exists', () => {
  assert.equal(resolveWatchlistDisplayValue({
    estimateValue: '--',
    lastValue: '1.0000',
    realChange: 2,
    realChangeDate: '2026-07-22',
    isCurrentReal: true
  }), '1.0200')
})
