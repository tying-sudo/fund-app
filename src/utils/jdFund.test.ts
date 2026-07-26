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
    buildJdFundTradeUrl('017472', 'buy'),
    'https://lc.jr.jd.com/finance/fund/fundtrade/index/?source=app&itemId=1017472&version=3&fundUtmSource=310&fundUtmParam=add_jjccxq&fromJumpType=2&createOrdermaket=310'
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

test('uses the captured JD Finance product ID for 100055 buy', () => {
  assert.equal(resolveJdFundBuyItemId('100055'), '107138')
  assert.equal(
    buildJdFundTradeUrl('100055', 'buy'),
    'https://lc.jr.jd.com/finance/fund/fundtrade/index/?source=app&itemId=107138&version=3&fundUtmSource=310&fundUtmParam=add_jjccxq&fromJumpType=2&createOrdermaket=310'
  )
})
