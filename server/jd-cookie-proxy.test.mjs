import assert from 'node:assert/strict'
import test from 'node:test'

import { importJdCookie } from './jd-cookie-proxy.mjs'

const GROUP_URL = 'https://ms.jr.jd.com/gw/generic/base/h5/m/fundHoldGroup'
const DETAIL_URL = 'https://ms.jr.jd.com/gw/generic/jj/h5/m/getNewFundPositionDetail'
const TRADE_URL = 'https://ms.jr.jd.com/gw2/generic/cfGateway/newna/m/queryTradeOrderList'

function response(payload, status = 200) {
  return { ok: status >= 200 && status < 300, status, text: async () => JSON.stringify(payload) }
}

function product(code) {
  return {
    productId: `1${code}`,
    productName: `Fund ${code}`,
    jumpData: { param: { extJson: { productId: `1${code}`, distinctCode: code } } }
  }
}

function detail(code) {
  return {
    success: true,
    resultData: {
      data: {
        pageInfo: { fundCode: code, acquiredDate: '2024-01-02' },
        templateList: [{ templateData: {
          fundAmount: {
            majorData: { yieldList: [{ title1: '昨日收益', title2: '1.23' }] },
            minorData: { dataList: [
              { title1: '持有金额', title2: '100.00' },
              { title1: '持有份额', title2: '80.00' },
              { title1: '持仓成本单价', title2: '1.20' },
              { title1: '持仓成本价', title2: '96.00' }
            ] }
          },
          fundIntro: { fundName: `Fund ${code}` }
        } }]
      }
    }
  }
}

function groupPayload(codes) {
  return { success: true, resultData: { resultData: { fundData: { fundList: [{ productList: codes.map(product) }] } } } }
}

test('uses the verified H5 snapshot endpoints and reads every product in a group', async () => {
  const originalFetch = globalThis.fetch
  const calls = []
  const codes = ['000001', '000002', '000003', '000004', '000005', '000006']
  globalThis.fetch = async (url, options) => {
    calls.push({ url, options })
    if (url === GROUP_URL) return response(groupPayload(codes))
    if (url === DETAIL_URL) {
      const request = JSON.parse(new URLSearchParams(options.body).get('reqData'))
      return response(detail(request.extJson.includes('000006') ? '000006' : request.extJson.match(/00000\d/)?.[0] || '000001'))
    }
    if (url === TRADE_URL) {
      return response({ success: true, resultData: { data: { allCount: 1, tradeOrderVoList: [{
        orderId: 'convert-1', tradeTypeCode: 'TRANSFORM', sellProductId: '1000001', productId: '1000002',
        bizTime: '2026-08-06 10:10:00', confirmUnit: '80', confirmAmount: '100', targetUnit: '75',
        orderStatusCode: 'CONFIRM_SUCC', orderStatusDesc: '确认成功'
      }] } } })
    }
    throw new Error(`unexpected URL: ${url}`)
  }

  try {
    const result = await importJdCookie('pt_key=test; pt_pin=test')
    assert.equal(calls[0].url, GROUP_URL)
    assert.equal(calls[0].options.headers.Referer, 'https://roma.jd.com/')
    assert.equal(calls[0].options.headers.Origin, undefined)
    assert.equal(calls.filter(call => call.url === DETAIL_URL).length, codes.length)
    assert.deepEqual(result.items.map(item => item.code), codes)
    assert.equal(result.items[0].acquiredDate, '2024-01-02')
    assert.deepEqual(result.adjustments, [{
      id: 'convert-1', code: '000002', name: undefined, type: 'convert', tradeDate: '2026-08-06',
      tradeTime: '2026-08-06 10:10:00', shares: '80', amount: '100', status: '确认成功', statusCode: 'CONFIRM_SUCC',
      targetCode: '000001', targetName: undefined, targetShares: '75'
    }])
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('does not report an encrypted transaction envelope as a successful empty timeline', async () => {
  const originalFetch = globalThis.fetch
  globalThis.fetch = async (url, options) => {
    if (url === GROUP_URL) return response(groupPayload(['000001']))
    if (url === DETAIL_URL) return response(detail('000001'))
    if (url === TRADE_URL) return response({ success: true, resultData: 'encrypted-response-envelope' })
    throw new Error(`unexpected URL: ${url} ${options?.body || ''}`)
  }

  try {
    const result = await importJdCookie('pt_key=test; pt_pin=test')
    assert.equal(result.items.length, 1)
    assert.deepEqual(result.adjustments, [])
    assert.match(result.tradeWarning, /not returned in decoded form/)
  } finally {
    globalThis.fetch = originalFetch
  }
})
