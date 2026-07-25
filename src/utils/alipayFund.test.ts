import test from 'node:test'
import assert from 'node:assert/strict'

import { buildAlipayFundDetailUrl, buildAlipayFundScheme } from './alipayFund.ts'

test('builds the Alipay fund detail URL with the six-digit fund code', () => {
  assert.equal(
    buildAlipayFundDetailUrl('012922'),
    'https://20000793.h5app.alipay.com/www/detail.html?fundCode=012922'
  )
})

test('wraps and encodes the detail URL in the Alipay mini-app scheme', () => {
  const scheme = buildAlipayFundScheme(' 012922 ')
  const parsed = new URL(scheme)

  assert.equal(parsed.protocol, 'alipays:')
  assert.equal(parsed.hostname, 'platformapi')
  assert.equal(parsed.pathname, '/startapp')
  assert.equal(parsed.searchParams.get('appId'), '20000793')
  assert.equal(parsed.searchParams.get('pullRefresh'), 'NO')
  assert.equal(parsed.searchParams.get('appClearTop'), 'false')
  assert.equal(parsed.searchParams.get('startMultApp'), 'YES')
  assert.equal(
    parsed.searchParams.get('url'),
    'https://20000793.h5app.alipay.com/www/detail.html?fundCode=012922'
  )
})

test('rejects an invalid fund code', () => {
  assert.throws(() => buildAlipayFundDetailUrl('   '), /Fund code must be six digits/)
  assert.throws(() => buildAlipayFundDetailUrl('123'), /Fund code must be six digits/)
})
