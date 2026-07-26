import test from 'node:test'
import assert from 'node:assert/strict'

import { buildHttpCacheKey, getHttpCachePolicy } from './http-cache.mjs'

test('normalizes HTTP cache query parameters', () => {
  assert.equal(
    buildHttpCacheKey('/api/fund-rank?pn=50&ft=gp'),
    buildHttpCacheKey('/api/fund-rank?ft=gp&pn=50')
  )
})

test('caches stable API data but never real-time or operational routes', () => {
  assert.equal(getHttpCachePolicy('/api/funds/000001/nav-history'), 21_600)
  assert.equal(getHttpCachePolicy('/api/fund-estimates'), 0)
  assert.equal(getHttpCachePolicy('/api/funds/000001/intraday'), 0)
  assert.equal(getHttpCachePolicy('/api/health'), 0)
})
