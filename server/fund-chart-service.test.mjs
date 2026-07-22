import assert from 'node:assert/strict'
import test from 'node:test'

import { calculateIntradayProgress, parseFundPerformancePayload } from './fund-chart-service.mjs'

test('rebases cached fund performance and preserves peer/index gaps as null', () => {
  const day = 24 * 60 * 60 * 1000
  const latest = Date.UTC(2026, 6, 22)
  const source = `var Data_grandTotal = ${JSON.stringify([
    { name: '本基金', data: [[latest - 2 * day, 10], [latest - day, 11], [latest, 12]] },
    { name: '同类平均', data: [[latest - 2 * day, 5], [latest, 6]] },
    { name: '沪深300', data: [[latest - 2 * day, 20], [latest - day, 19], [latest, 21]] }
  ])};`

  const points = parseFundPerformancePayload(source, 'y')
  assert.equal(points.length, 3)
  assert.equal(points[0].fundReturn, 0)
  assert.equal(points[2].fundReturn, 2)
  assert.equal(points[1].avgReturn, null)
  assert.equal(points[2].indexReturn, 1)
})

test('rejects unsupported ranges and malformed performance payloads', () => {
  assert.deepEqual(parseFundPerformancePayload('var Data_grandTotal = [];', '1n'), [])
  assert.deepEqual(parseFundPerformancePayload('var Data_grandTotal = invalid;', 'y'), [])
})

test('normalizes US QDII anchors to the market clock and fills bounded per-second progress', () => {
  const points = calculateIntradayProgress([
    { time: '2026-07-21 09:30:00', value: 5, change: 0, source: 'previous_nav' },
    { time: '2026-07-21 03:21:00', timeIso: '2026-07-21T19:21:00.000Z', value: 5.45, change: 4.5, source: 'holdings_weighted' },
    { time: '2026-07-21 03:21:03', timeIso: '2026-07-21T19:21:03.000Z', value: 5.46, change: 4.6, source: 'holdings_weighted' }
  ], 'us', '2026-07-21')

  assert.equal(points[0].time, '2026-07-21 15:21:00')
  assert.equal(points.at(-1).time, '2026-07-21 15:21:03')
  assert.equal(points.length, 4)
  assert.equal(points[1].source, 'estimated_progress')
  assert.ok(points[1].value > 5.45 && points[1].value < 5.46)
})
