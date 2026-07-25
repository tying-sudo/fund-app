import assert from 'node:assert/strict'
import test from 'node:test'
import { buildJdFundScheme } from './jdFund.ts'

test('builds the JD Finance fund detail scheme', () => {
  const scheme = buildJdFundScheme('000001')
  assert.match(scheme, /^jdmobile:\/\/share\?jumpType=7&jumpUrl=/)
  assert.match(decodeURIComponent(scheme), /lc\.jr\.jd\.com\/finance\/funddetail\/home\//)
  assert.match(decodeURIComponent(scheme), /fundCode=000001/)
})

test('rejects malformed fund codes', () => {
  assert.throws(() => buildJdFundScheme('123'), /six digits/)
})
