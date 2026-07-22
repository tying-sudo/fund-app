import test from 'node:test'
import assert from 'node:assert/strict'

import { parseGridTradeOcrResponse } from './grid-trade-ocr.mjs'

function basicResult(result) {
  return {
    fund_name: result.fund_name,
    items: result.items.map(({ type, date, time, amount, shares, description }) => ({
      type, date, time, amount, shares, description
    }))
  }
}

test('normalizes buy amounts and conversion shares with the page year', () => {
  const response = {
    md_results: '```json\n{"y":"2026","n":"国泰中证机床ETF发起联接C","items":[' +
      '{"k":"sell","d":"07-10","m":"14:39:49","a":"","s":"482.28份","x":"转换-国泰中证机床ETF发起联接C→宏利半导体产业混合发起C"},' +
      '{"k":"buy","d":"07-08","m":"14:57:17","a":"1,000.00元","s":"","x":"转入-国泰中证机床ETF发起联接C"}' +
      ']}\n```'
  }

  assert.deepEqual(basicResult(parseGridTradeOcrResponse(response)), {
    fund_name: '国泰中证机床ETF发起联接C',
    items: [
      {
        type: 'sell', date: '2026-07-10', time: '14:39:49', amount: '', shares: '482.28',
        description: '转换-国泰中证机床ETF发起联接C→宏利半导体产业混合发起C'
      },
      {
        type: 'buy', date: '2026-07-08', time: '14:57:17', amount: '1000', shares: '',
        description: '转入-国泰中证机床ETF发起联接C'
      }
    ]
  })
})

test('rejects invalid dates, unrelated rows, and rows without a value', () => {
  const response = {
    y: '2026',
    items: [
      { k: 'sell', d: '02-30', s: '10' },
      { k: 'status', d: '07-01', a: '500', x: '订单完成' },
      { k: 'buy', d: '07-02', x: '买入-基金' },
      { k: '', d: '2026/07/03', a: '50.00', x: '转入-基金' }
    ]
  }

  assert.deepEqual(basicResult(parseGridTradeOcrResponse(response)), {
    fund_name: '',
    items: [{ type: 'buy', date: '2026-07-03', time: '', amount: '50', shares: '', description: '转入-基金' }]
  })
})

test('parses GLM layout markdown with wrapped names, compact dates, and conversion shares', () => {
  const response = {
    md_results: `基金交易

2026年07月

![](page=0,bbox=[41, 613, 172, 740])

转换-国泰中证机床ETF发起联 482.28份

接C→宏利半导体产业混合发起C

订单完成

07-10 14:39:49

![](page=0,bbox=[41, 1368, 172, 1497])

转入-国泰中证机床ETF发起 1,000.00元

联接C 订单完成

07-0814:57:17`
  }

  assert.deepEqual(basicResult(parseGridTradeOcrResponse(response)), {
    fund_name: '国泰中证机床ETF发起联接C',
    items: [
      {
        type: 'sell', date: '2026-07-10', time: '14:39:49', amount: '', shares: '482.28',
        description: '转换-国泰中证机床ETF发起联 接C→宏利半导体产业混合发起C'
      },
      {
        type: 'buy', date: '2026-07-08', time: '14:57:17', amount: '1000', shares: '',
        description: '转入-国泰中证机床ETF发起 联接C'
      }
    ]
  })
})

test('parses GLM markdown when amount text is split around the decimal point', () => {
  const response = {
    md_results: `2026年07月

![](page=0,bbox=[37, 1092, 174, 1221])

转入-方正富邦核心优势混合C 500.00元

07-0114:19:46

订单完成

2026年06月

![](page=0,bbox=[36, 1451, 175, 1580])

转入-方正富邦核心优势混合C

06-17 12:48:52

50. 00元订单完成`
  }

  assert.deepEqual(basicResult(parseGridTradeOcrResponse(response)), {
    fund_name: '方正富邦核心优势混合C',
    items: [
      {
        type: 'buy', date: '2026-07-01', time: '14:19:46', amount: '500', shares: '',
        description: '转入-方正富邦核心优势混合C'
      },
      {
        type: 'buy', date: '2026-06-17', time: '12:48:52', amount: '50', shares: '',
        description: '转入-方正富邦核心优势混合C'
      }
    ]
  })
})

test('treats a conversion as a buy when the screenshot fund is on the arrow target side', () => {
  const response = {
    md_results: `2026年07月

![](page=0,bbox=[37, 480, 174, 610])

转换-国泰中证机床ETF发起联接C 400.00份→华泰柏瑞上证科创板半导体材料设备主题ETF发起...

07-10 14:39:15

![](page=0,bbox=[37, 720, 174, 850])

转入-华泰柏瑞上证科创板半导体材料设备主题ETF发起式联接C 1000.00元

07-06 14:50:29`
  }
  const fundList = [
    { code: '017472', name: '国泰中证机床ETF发起联接C' },
    { code: '024975', name: '华泰柏瑞上证科创板半导体材料设备主题ETF发起式联接C' }
  ]

  const result = parseGridTradeOcrResponse(response, fundList)
  assert.equal(result.fund_name, '华泰柏瑞上证科创板半导体材料设备主题ETF发起式联接C')
  assert.equal(result.fund_code, '024975')
  assert.deepEqual(result.items[0], {
    type: 'buy',
    operation: 'conversion',
    date: '2026-07-10',
    time: '14:39:15',
    amount: '',
    shares: '400',
    description: '转换-国泰中证机床ETF发起联接C →华泰柏瑞上证科创板半导体材料设备主题ETF发起...',
    source_fund_name: '国泰中证机床ETF发起联接C',
    target_fund_name: '华泰柏瑞上证科创板半导体材料设备主题ETF发起...',
    source_fund_code: '017472',
    target_fund_code: '024975',
    source_shares: '400'
  })
})
