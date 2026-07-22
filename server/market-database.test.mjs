import assert from 'node:assert/strict'
import test from 'node:test'

import {
  currencyForMarket,
  holdingChangeType,
  marketFromPrefix
} from './market-database.mjs'

test('maps Eastmoney security prefixes across mainland, Hong Kong, and US markets', () => {
  assert.equal(marketFromPrefix('1'), 'cn')
  assert.equal(marketFromPrefix('0'), 'cn')
  assert.equal(marketFromPrefix('116'), 'hk')
  assert.equal(marketFromPrefix('105'), 'us')
  assert.equal(marketFromPrefix('106'), 'us')
  assert.equal(marketFromPrefix('999'), 'unknown')
  assert.equal(currencyForMarket('cn'), 'CNY')
  assert.equal(currencyForMarket('hk'), 'HKD')
  assert.equal(currencyForMarket('us'), 'USD')
})

test('classifies quarter-over-quarter holding changes without inventing missing history', () => {
  assert.equal(holdingChangeType(null, false, false), 'unknown')
  assert.equal(holdingChangeType(4.25, true, false), 'new')
  assert.equal(holdingChangeType(0.5, true, true), 'increased')
  assert.equal(holdingChangeType(-0.5, true, true), 'decreased')
  assert.equal(holdingChangeType(0, true, true), 'unchanged')
})
