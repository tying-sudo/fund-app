import assert from 'node:assert/strict'
import test from 'node:test'
import { buildJdFundScheme, buildJdFundTradeScheme, buildJdFundTradeUrl, resolveJdFundBuyItemId } from './jdFund.ts'

test('builds the JD Finance fund detail scheme', () => {
  const scheme = buildJdFundScheme('000001')
  assert.match(scheme, /^jdmobile:\/\/share\?jumpType=7&jumpUrl=/)
  assert.match(decodeURIComponent(scheme), /lc\.jr\.jd\.com\/finance\/funddetail\/home\//)
  assert.match(decodeURIComponent(scheme), /fundCode=000001/)
})

test('rejects malformed fund codes', () => {
  assert.throws(() => buildJdFundScheme('123'), /six digits/)
})

test('builds captured JD Finance trade URLs for every holding action', () => {
  assert.equal(
    buildJdFundTradeUrl('002112', 'buy'),
    'https://lc.jr.jd.com/finance/fund/fundtrade/index/?source=app&itemId=105109&version=3'
  )
  assert.equal(
    buildJdFundTradeUrl('017472', 'sell'),
    'https://lc.jr.jd.com/fund/newfundtrade/redeem/?fundCode=017472&distinctCode=1&fromJumpType=2&createOrdermaket=310'
  )
  assert.equal(
    buildJdFundTradeUrl('017472', 'convert'),
    'https://lc.jr.jd.com/fund/newfundtrade/redeem/?fundCode=017472&distinctCode=1&fromJumpType=2&createOrdermaket=310&curType=transfer&hideTabFlag=1'
  )
  assert.match(decodeURIComponent(buildJdFundTradeScheme('017472', 'convert')), /curType=transfer/)
})

test('uses captured JD Finance product IDs when they differ from 1 + fund code', () => {
  const capturedProductIds = {
    '001470': '105457',
    '002112': '105109',
    '010524': '113000',
    '100055': '107138'
  }

  for (const [fundCode, itemId] of Object.entries(capturedProductIds)) {
    assert.equal(resolveJdFundBuyItemId(fundCode), itemId)
    assert.equal(
      buildJdFundTradeUrl(fundCode, 'buy'),
      `https://lc.jr.jd.com/finance/fund/fundtrade/index/?source=app&itemId=${itemId}&version=3`
    )
    assert.doesNotMatch(buildJdFundTradeUrl(fundCode, 'buy'), new RegExp(`itemId=1${fundCode}(?:&|$)`))
  }
})

test('does not invent a JD product ID for an uncaptured fund', () => {
  assert.equal(resolveJdFundBuyItemId('017472'), null)
  assert.equal(
    buildJdFundTradeUrl('017472', 'buy'),
    'https://lc.jr.jd.com/finance/funddetail/home/?fundCode=017472&fundUtmSource=340&fundUtmParam=AppShare'
  )
})
