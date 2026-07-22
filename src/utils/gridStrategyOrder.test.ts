import test from 'node:test'
import assert from 'node:assert/strict'

import { mergeStrategyOrder, sortByStrategyOrder } from './gridStrategyOrder.ts'

test('keeps saved cards in order and appends newly available funds', () => {
  assert.deepEqual(
    mergeStrategyOrder(['B', 'missing', 'A', 'B'], ['A', 'B', 'C']),
    ['B', 'A', 'C']
  )
})

test('keeps the dragged order when card expansion state changes', () => {
  const rows = [
    { key: 'A', expanded: true },
    { key: 'B', expanded: false },
    { key: 'C', expanded: true }
  ]
  assert.deepEqual(
    sortByStrategyOrder(rows, ['C', 'B', 'A'], row => row.key).map(row => [row.key, row.expanded]),
    [['C', true], ['B', false], ['A', true]]
  )
})
