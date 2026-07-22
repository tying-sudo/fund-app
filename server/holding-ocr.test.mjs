import test from 'node:test'
import assert from 'node:assert/strict'

import { normalizeHoldingNumber, parseHoldingOcrResponse } from './holding-ocr.mjs'

const fundList = [
  { code: '017472', name: '国泰中证机床ETF发起联接C' },
  { code: '002112', name: '德邦鑫星价值灵活配置混合C' },
  { code: '018523', name: '华泰紫金恒生互联网科技业指数型发起基金(QDII)A' },
  { code: '018524', name: '华泰紫金恒生互联网科技业指数型发起基金(QDII)C' }
]

test('keeps decimal points and signs when normalizing screenshot numbers', () => {
  assert.equal(normalizeHoldingNumber('23,692.93'), '23692.93')
  assert.equal(normalizeHoldingNumber('-1,742.63'), '-1742.63')
  assert.equal(normalizeHoldingNumber('+3.10%'), '+3.10')
  assert.equal(normalizeHoldingNumber('23,692..93'), '')
})

test('parses paired GLM OCR table rows and resolves only unambiguous fund codes', () => {
  const mdResults = `<table><tbody>
    <tr><td>国泰中证机床ETF发起联接C</td><td>2,398.37</td><td>-664.45</td></tr>
    <tr><td></td><td>0.00</td><td>-21.69%</td></tr>
    <tr><td>交易：2笔买入中合计60.00元</td><td></td><td></td></tr>
    <tr><td>华泰紫金恒生互联网科技业指数型...</td><td>3,680.56</td><td>+80.56</td></tr>
    <tr><td></td><td>0.00</td><td>+3.10%</td></tr>
  </tbody></table>`
  assert.deepEqual(parseHoldingOcrResponse({ md_results: mdResults }, fundList), [
    { n: '国泰中证机床ETF发起联接C', c: '017472', a: '2398.37', p: '-664.45', r: '-21.69', t: '' },
    { n: '华泰紫金恒生互联网科技业指数型', c: '', a: '3680.56', p: '+80.56', r: '+3.10', t: '' }
  ])
})

test('accepts the requested compact JSON contract before applying fund-list validation', () => {
  const response = { items: [{ n: '国泰中证机床ETF发起联接C', c: '', a: '2,398.37', p: '-664.45', r: '-21.69%', t: '' }] }
  assert.deepEqual(parseHoldingOcrResponse(response, fundList), [
    { n: '国泰中证机床ETF发起联接C', c: '017472', a: '2398.37', p: '-664.45', r: '-21.69', t: '' }
  ])
})

test('uses a visible share class to resolve a truncated name but ignores ranking labels', () => {
  const mdResults = `<table><tbody>
    <tr><td>德邦鑫星价值C</td><td>4,600.75</td><td>-1,149.25</td></tr>
    <tr><td>光模块 No.3</td><td>0.00</td><td>-19.99%</td></tr>
  </tbody></table>`
  assert.deepEqual(parseHoldingOcrResponse({ md_results: mdResults }, fundList), [
    { n: '德邦鑫星价值灵活配置混合C', c: '002112', a: '4600.75', p: '-1149.25', r: '-19.99', t: '' }
  ])
})
