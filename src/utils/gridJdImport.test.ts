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
