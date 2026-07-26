import assert from 'node:assert/strict'
import test from 'node:test'
import { buildGridJdImportPayload } from './gridJdImport.ts'

test('keeps only current JD holdings and their relevant transaction stream', () => {
  const payload = buildGridJdImportPayload(
    [{ code: '000001', name: 'Current', shares: '108' }, { code: 'bad', name: 'Ignored' }],
    [
      { id: 'buy', code: '000001', type: 'add', tradeDate: '2026-07-20', shares: '100', amount: '100' },
      { id: 'closed', code: '000002', type: 'reduce', tradeDate: '2026-07-20', shares: '10' },
      { id: 'in', code: '000002', type: 'convert', tradeDate: '2026-07-20', amount: '8', targetCode: '000001', targetShares: '8' },
      { id: 'invalid', code: 'x', type: 'add', tradeDate: '2026-07-20' }
    ]
  )

  assert.deepEqual(payload.current_holding_codes, ['000001'])
  assert.deepEqual(payload.current_holdings, [{ code: '000001', name: 'Current', shares: '108' }])
  assert.deepEqual(payload.adjustments.map((item) => item.id), ['buy', 'in'])
})

test('keeps current holding values for the no-recent-trades baseline', () => {
  const payload = buildGridJdImportPayload(
    [{ code: '000001', name: 'Current', amount: '1200', shares: '1000', costPrice: '1.1' }],
    []
  )

  assert.deepEqual(payload.current_holdings, [{
    code: '000001', name: 'Current', amount: '1200', shares: '1000', costPrice: '1.1'
  }])
})

test('keeps snapshot profit and JD dates for a cost-basis fallback batch', () => {
  const payload = buildGridJdImportPayload(
    [{ code: '000001', name: 'Current', amount: '1200', shares: '1000', profit: '200', profitDate: '2026-07-23', acquiredDate: '2026-01-02' }],
    []
  )

  assert.deepEqual(payload.current_holdings, [{
    code: '000001',
    name: 'Current',
    amount: '1200',
    shares: '1000',
    profit: '200',
    profitDate: '2026-07-23',
    acquiredDate: '2026-01-02'
  }])
})

test('keeps the explicit JD holding cost when it is present', () => {
  const payload = buildGridJdImportPayload(
    [{ code: '000001', name: 'Current', shares: '1000', costPrice: '1.05', costAmount: '1050' }],
    []
  )

  assert.equal(payload.current_holdings[0].costAmount, '1050')
})

test('keeps malformed JD dates from aborting or reaching the grid importer', () => {
  const payload = buildGridJdImportPayload(
    [{ code: '000001', name: 'Current', shares: '100' }],
    [{ id: 'malformed', code: '000001', type: 'add', tradeDate: '07-03', shares: '100', status: '订单完成' }]
  )

  assert.deepEqual(payload.adjustments, [])
  assert.deepEqual(payload.current_holding_codes, ['000001'])
})

test('keeps amount-only buy, sell, and conversion records for backend NAV confirmation', () => {
  const payload = buildGridJdImportPayload(
    [{ code: '000001', name: 'Current', shares: '100' }],
    [
      { id: 'buy', code: '000001', type: 'add', tradeDate: '2026-07-20', amount: '120', status: '订单完成' },
      { id: 'sell', code: '000001', type: 'reduce', tradeDate: '2026-07-21', amount: '60', status: '订单完成' },
      { id: 'convert', code: '000001', type: 'convert', tradeDate: '2026-07-22', amount: '30', status: '订单完成', targetCode: '000002' }
    ]
  )

  assert.deepEqual(payload.adjustments.map((item) => item.id), ['buy', 'sell', 'convert'])
})

test('uses the first real purchase in the current cycle as the grid opening check', () => {
  const payload = buildGridJdImportPayload(
    [{ code: '000001', name: 'Current', shares: '60' }],
    [
      { id: 'first-buy', code: '000001', type: 'add', tradeDate: '2024-01-02', shares: '10', amount: '10' },
      { id: 'second-buy', code: '000001', type: 'add', tradeDate: '2025-07-03', shares: '50', amount: '50' }
    ]
  )

  assert.deepEqual(payload.adjustments.map((item) => item.id), ['first-buy', 'second-buy'])
  assert.equal(payload.adjustments[0].tradeDate, '2024-01-02')
})
