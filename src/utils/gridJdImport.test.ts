import assert from 'node:assert/strict'
import test from 'node:test'
import { buildGridJdImportPayload, formatGridJdImportFeedback, getGridJdImportCandidates, selectGridJdImportPayload, summarizeGridJdImportResult } from './gridJdImport.ts'

test('keeps the complete JD history needed to find the true first buy', () => {
  const now = new Date('2026-08-04T12:00:00+08:00')
  const payload = buildGridJdImportPayload(
    [{ code: '000001', name: 'Current', shares: '30' }],
    [
      { id: 'first-buy', code: '000001', type: 'add', tradeDate: '2021-05-03', shares: '10', statusCode: 'COMPLETE' },
      { id: 'recent', code: '000001', type: 'add', tradeDate: '2026-08-03', shares: '20', statusCode: 'COMPLETE' },
      { id: 'future', code: '000001', type: 'add', tradeDate: '2026-08-05', shares: '10', statusCode: 'COMPLETE' }
    ],
    now,
    { resolveCurrentCyclesOnServer: true }
  )

  assert.deepEqual(payload.adjustments.map((item) => item.id), ['first-buy', 'recent'])
  assert.equal(payload.adjustments[0]?.tradeDate, '2021-05-03')
})

test('keeps only current JD holdings and their relevant transaction stream', () => {
  const payload = buildGridJdImportPayload(
    [{ code: '000001', name: 'Current', shares: '108' }, { code: 'bad', name: 'Ignored' }],
    [
      { id: 'buy', code: '000001', type: 'add', tradeDate: '2026-07-20', shares: '100', amount: '100', statusCode: 'COMPLETE' },
      { id: 'closed', code: '000002', type: 'reduce', tradeDate: '2026-07-20', shares: '10' },
      { id: 'in', code: '000002', type: 'convert', tradeDate: '2026-07-20', amount: '8', targetCode: '000001', targetShares: '8', statusCode: 'COMPLETE' },
      { id: 'invalid', code: 'x', type: 'add', tradeDate: '2026-07-20' }
    ],
    new Date('2026-07-30T10:00:00+08:00')
  )

  assert.deepEqual(payload.current_holding_codes, ['000001'])
  assert.deepEqual(payload.replace_transaction_codes, ['000001'])
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
  assert.deepEqual(payload.replace_transaction_codes, [])
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

test('keeps a same-day pending purchase even before the holding snapshot contains it', () => {
  const payload = buildGridJdImportPayload(
    [{ code: '000001', name: 'Existing', shares: '100' }],
    [{
      id: 'today-buy', code: '000002', name: 'New fund', type: 'add',
      tradeDate: '2026-07-30', tradeTime: '2026-07-30 10:30:00',
      amount: '100', statusCode: 'PAY_SUCC', status: '支付成功'
    }],
    new Date('2026-07-30T11:00:00+08:00')
  )

  assert.deepEqual(payload.current_holding_codes, ['000001', '000002'])
  assert.deepEqual(payload.adjustments.map((item) => item.id), ['today-buy'])
})

test('keeps both conversion legs for a same-day inbound fund without restoring old closed purchases', () => {
  const payload = buildGridJdImportPayload(
    [{ code: '000001', name: 'Existing', shares: '100' }],
    [
      {
        id: 'today-convert', code: '000003', name: 'Source', type: 'convert',
        tradeDate: '2026-07-30', amount: '100', targetCode: '000004', targetName: 'Target',
        statusCode: 'PROCESS'
      },
      {
        id: 'old-closed-buy', code: '000005', type: 'add', tradeDate: '2026-07-20',
        amount: '100', statusCode: 'COMPLETE'
      }
    ],
    new Date('2026-07-30T11:00:00+08:00')
  )

  assert.deepEqual(payload.current_holding_codes, ['000001', '000004'])
  assert.deepEqual(payload.adjustments.map((item) => item.id), ['today-convert'])
})

test('drops cancelled or refunded same-day inbound funds', () => {
  const payload = buildGridJdImportPayload(
    [],
    [
      { id: 'cancelled', code: '000001', type: 'add', tradeDate: '2026-07-30', statusCode: 'CANCELLED' },
      { id: 'refunded', code: '000002', type: 'add', tradeDate: '2026-07-30', statusCode: 'REFUND_SUCC' }
    ],
    new Date('2026-07-30T11:00:00+08:00')
  )

  assert.deepEqual(payload.current_holding_codes, [])
  assert.deepEqual(payload.adjustments, [])
})

test('does not revive an old fund from a stale pending status in the ten-year history', () => {
  const payload = buildGridJdImportPayload(
    [{ code: '000001', name: 'Current', shares: '100' }],
    [{
      id: 'stale-paid', code: '000002', name: 'Closed long ago', type: 'add',
      tradeDate: '2018-07-30', amount: '100', statusCode: 'PAY_SUCC', status: '支付成功'
    }],
    new Date('2026-07-30T11:00:00+08:00')
  )

  assert.deepEqual(payload.current_holding_codes, ['000001'])
  assert.deepEqual(payload.adjustments, [])
})

test('keeps a recent explicitly pending inbound fund until confirmation', () => {
  const payload = buildGridJdImportPayload(
    [{ code: '000001', name: 'Current', shares: '100' }],
    [{
      id: 'recent-paid', code: '000002', name: 'Pending inbound', type: 'add',
      tradeDate: '2026-07-25', amount: '100', statusCode: 'PAY_SUCC', status: '支付成功'
    }],
    new Date('2026-07-30T11:00:00+08:00')
  )

  assert.deepEqual(payload.current_holding_codes, ['000001', '000002'])
  assert.deepEqual(payload.adjustments.map((item) => item.id), ['recent-paid'])
})

test('keeps same-day amount-only buy, sell, and conversion records for backend NAV confirmation', () => {
  const payload = buildGridJdImportPayload(
    [{ code: '000001', name: 'Current', shares: '100' }],
    [
      { id: 'buy', code: '000001', type: 'add', tradeDate: '2026-07-30', amount: '120', status: '订单完成' },
      { id: 'sell', code: '000001', type: 'reduce', tradeDate: '2026-07-30', amount: '60', status: '订单完成' },
      { id: 'convert', code: '000001', type: 'convert', tradeDate: '2026-07-30', amount: '30', status: '订单完成', targetCode: '000002' }
    ],
    new Date('2026-07-30T11:00:00+08:00')
  )

  assert.deepEqual(payload.adjustments.map((item) => item.id), ['buy', 'convert', 'sell'])
})

test('uses the first real purchase in the current cycle as the grid opening check', () => {
  const payload = buildGridJdImportPayload(
    [{ code: '000001', name: 'Current', shares: '60' }],
    [
      { id: 'first-buy', code: '000001', type: 'add', tradeDate: '2026-05-04', shares: '10', amount: '10', statusCode: 'COMPLETE' },
      { id: 'second-buy', code: '000001', type: 'add', tradeDate: '2026-07-03', shares: '50', amount: '50', statusCode: 'COMPLETE' }
    ],
    new Date('2026-08-04T11:00:00+08:00')
  )

  assert.deepEqual(payload.adjustments.map((item) => item.id), ['first-buy', 'second-buy'])
  assert.equal(payload.adjustments[0].tradeDate, '2026-05-04')
  assert.deepEqual(payload.replace_transaction_codes, ['000001'])
  assert.deepEqual(payload.adjustments[0].cycleCodes, ['000001'])
})

test('removes the fully closed cycle before a later rebuild', () => {
  const payload = buildGridJdImportPayload(
    [{ code: '000001', name: 'Rebuilt', shares: '40' }],
    [
      { id: 'old-buy', code: '000001', type: 'add', tradeDate: '2026-05-05', shares: '100', statusCode: 'COMPLETE' },
      { id: 'old-exit', code: '000001', type: 'reduce', tradeDate: '2026-05-06', shares: '100', statusCode: 'REDEEM_SUCC' },
      { id: 'rebuild-buy', code: '000001', type: 'add', tradeDate: '2026-06-01', shares: '60', statusCode: 'COMPLETE' },
      { id: 'rebuild-sell', code: '000001', type: 'reduce', tradeDate: '2026-07-01', shares: '20', statusCode: 'REDEEM_SUCC' }
    ],
    new Date('2026-08-04T11:00:00+08:00')
  )

  assert.deepEqual(payload.adjustments.map((item) => item.id), ['rebuild-buy', 'rebuild-sell'])
  assert.deepEqual(payload.replace_transaction_codes, ['000001'])
})

test('does not let pending trades break a verified current cycle', () => {
  const payload = buildGridJdImportPayload(
    [{ code: '000001', name: 'Current', shares: '100' }],
    [
      { id: 'old-buy', code: '000001', type: 'add', tradeDate: '2021-01-01', shares: '100', statusCode: 'COMPLETE' },
      { id: 'old-exit', code: '000001', type: 'reduce', tradeDate: '2022-01-01', shares: '100', statusCode: 'REDEEM_SUCC' },
      { id: 'rebuild-buy', code: '000001', type: 'add', tradeDate: '2026-07-01', shares: '100', statusCode: 'COMPLETE' },
      { id: 'pending-buy', code: '000001', type: 'add', tradeDate: '2026-07-30', amount: '50', statusCode: 'PAY_SUCC' },
      { id: 'pending-sell', code: '000001', type: 'reduce', tradeDate: '2026-07-30', shares: '20', statusCode: 'REDEEM' }
    ],
    new Date('2026-07-30T11:00:00+08:00')
  )

  assert.deepEqual(payload.replace_transaction_codes, ['000001'])
  assert.deepEqual(payload.adjustments.map((item) => item.id), ['rebuild-buy', 'pending-buy', 'pending-sell'])
  assert.ok(payload.adjustments.every((item) => item.cycleCodes?.includes('000001')))
})

test('keeps both pending conversion legs without using them to reconcile snapshot shares', () => {
  const payload = buildGridJdImportPayload(
    [
      { code: '000001', name: 'Source', shares: '100' },
      { code: '000002', name: 'Target', shares: '50' }
    ],
    [
      { id: 'source-buy', code: '000001', type: 'add', tradeDate: '2026-06-01', shares: '100', statusCode: 'COMPLETE' },
      { id: 'target-buy', code: '000002', type: 'add', tradeDate: '2026-06-02', shares: '50', statusCode: 'COMPLETE' },
      {
        id: 'pending-convert', code: '000001', type: 'convert', tradeDate: '2026-07-30', shares: '10',
        targetCode: '000002', amount: '10', statusCode: 'PROCESS'
      }
    ],
    new Date('2026-07-30T11:00:00+08:00')
  )

  assert.deepEqual(payload.replace_transaction_codes, ['000001', '000002'])
  assert.deepEqual(payload.adjustments.find((item) => item.id === 'pending-convert')?.cycleCodes, ['000001', '000002'])
})

test('does not send an unverified old history as the current cycle', () => {
  const payload = buildGridJdImportPayload(
    [{ code: '000001', name: 'Current', shares: '60' }],
    [
      { id: 'old-amount-buy', code: '000001', type: 'add', tradeDate: '2021-01-01', amount: '100' },
      { id: 'old-exit', code: '000001', type: 'reduce', tradeDate: '2022-01-01', shares: '100' },
      { id: 'unknown-current-buy', code: '000001', type: 'add', tradeDate: '2026-01-01', amount: '60' }
    ],
    new Date('2026-07-30T11:00:00+08:00')
  )

  assert.deepEqual(payload.replace_transaction_codes, [])
  assert.deepEqual(payload.adjustments, [])
})

test('sends every amount-only current-fund row to the server cycle resolver', () => {
  const payload = buildGridJdImportPayload(
    [{ code: '006616', name: 'Target', shares: '3834.69' }],
    [
      { id: 'in-1', code: '006616', type: 'add', tradeDate: '2026-06-26', amount: '1.00', statusCode: 'COMPLETE' },
      { id: 'in-2', code: '006616', type: 'add', tradeDate: '2026-06-29', amount: '809.38', statusCode: 'COMPLETE' },
      { id: 'in-3', code: '006616', type: 'add', tradeDate: '2026-07-02', amount: '10000.00', statusCode: 'COMPLETE' },
      { id: 'in-4', code: '006616', type: 'add', tradeDate: '2026-07-06', amount: '1500.00', statusCode: 'COMPLETE' },
      { id: 'in-5', code: '006616', type: 'add', tradeDate: '2026-07-29', amount: '5000.00', statusCode: 'COMPLETE' }
    ],
    new Date('2026-08-02T16:49:44+08:00'),
    { resolveCurrentCyclesOnServer: true }
  )

  assert.equal(payload.resolve_current_cycles_on_server, true)
  assert.deepEqual(payload.adjustments.map((item) => item.id), ['in-1', 'in-2', 'in-3', 'in-4', 'in-5'])
})

test('selects whole fund cycles from the Cookie-import review without leaking another fund', () => {
  const payload = buildGridJdImportPayload(
    [
      { code: '000001', name: 'Source', shares: '100' },
      { code: '000002', name: 'Target', shares: '50' }
    ],
    [
      { id: 'source-buy', code: '000001', type: 'add', tradeDate: '2026-07-01', shares: '100', statusCode: 'COMPLETE' },
      { id: 'target-buy', code: '000002', type: 'add', tradeDate: '2026-07-02', shares: '40', statusCode: 'COMPLETE' },
      { id: 'convert', code: '000001', type: 'convert', targetCode: '000002', targetShares: '10', tradeDate: '2026-07-03', statusCode: 'COMPLETE' }
    ],
    new Date('2026-08-02T16:49:44+08:00'),
    { resolveCurrentCyclesOnServer: true }
  )

  assert.deepEqual(getGridJdImportCandidates(payload), [
    {
      code: '000001',
      name: 'Source',
      candidateBatchCount: 1,
      transactionCount: 2,
      pendingTransactionCount: 0,
      hasHoldingSnapshot: true,
      batches: [{
        id: 'source-buy:source',
        tradeDate: '2026-07-01',
        type: 'buy',
        shares: '100',
        statusCode: 'COMPLETE',
        pending: false
      }]
    },
    {
      code: '000002',
      name: 'Target',
      candidateBatchCount: 2,
      transactionCount: 2,
      pendingTransactionCount: 0,
      hasHoldingSnapshot: true,
      batches: [
        {
          id: 'target-buy:source',
          tradeDate: '2026-07-02',
          type: 'buy',
          shares: '40',
          statusCode: 'COMPLETE',
          pending: false
        },
        {
          id: 'convert:target',
          tradeDate: '2026-07-03',
          type: 'convert_in',
          shares: '10',
          statusCode: 'COMPLETE',
          pending: false
        }
      ]
    }
  ])

  const selected = selectGridJdImportPayload(payload, ['000002'])
  assert.deepEqual(selected.current_holding_codes, ['000002'])
  assert.deepEqual(selected.full_current_holding_codes, ['000001', '000002'])
  assert.deepEqual(selected.current_holdings.map((item) => item.code), ['000002'])
  assert.deepEqual(selected.adjustments.map((item) => item.id), ['target-buy', 'convert'])
  assert.deepEqual(selected.adjustments.find((item) => item.id === 'convert')?.cycleCodes, ['000002'])
})

test('shows a snapshot fallback as one review row when JD returned no purchase batches', () => {
  const payload = buildGridJdImportPayload(
    [{ code: '000001', name: 'Current', amount: '1200', shares: '1000', acquiredDate: '2026-01-02' }],
    []
  )

  assert.deepEqual(getGridJdImportCandidates(payload)[0]?.batches, [{
    id: 'jd:snapshot:000001',
    tradeDate: '2026-01-02',
    type: 'snapshot',
    amount: '1200',
    shares: '1000',
    status: '交易批次不完整，将保留当前持仓基线',
    pending: false
  }])
})

test('does not count an undated JD snapshot as an importable batch', () => {
  const payload = buildGridJdImportPayload(
    [{ code: '000001', name: 'Current', amount: '1200', shares: '1000' }],
    []
  )

  const candidate = getGridJdImportCandidates(payload)[0]
  assert.equal(candidate?.candidateBatchCount, 0)
  assert.equal(candidate?.batches[0]?.type, 'snapshot')
  assert.equal(candidate?.batches[0]?.tradeDate, '')
})

test('does not treat a profit-date as the holding start for a snapshot fallback', () => {
  const payload = buildGridJdImportPayload(
    [{ code: '000001', name: 'Current', amount: '1200', shares: '1000', profitDate: '2026-07-23' }],
    []
  )

  assert.equal(getGridJdImportCandidates(payload)[0]?.batches[0]?.tradeDate, '')
})

test('reports duplicate snapshot baselines separately from skipped real trades', () => {
  const summary = summarizeGridJdImportResult({
    results: [
      { action: 'seed', status: 'skipped', reason: 'duplicate' },
      { action: 'buy', status: 'imported' },
      { action: 'sell', status: 'skipped', reason: 'duplicate' },
      { action: 'convert_in', status: 'updated' },
      { action: 'convert_out', status: 'skipped', reason: 'missing_conversion_source' }
    ]
  })

  assert.deepEqual(summary, {
    baselineImported: 0,
    baselineUpdated: 0,
    baselineUnchanged: 1,
    transactionImported: 1,
    transactionUpdated: 1,
    transactionExisting: 1,
    transactionPartial: 0,
    rejected: 1
  })
})

test('keeps native detail-read failures visible in grid import feedback', () => {
  const feedback = formatGridJdImportFeedback({
    imported: 0,
    skipped: 0,
    partial: 0,
    audit_imported: 1,
    results: []
  }, {
    verifiedCycles: 0,
    snapshotFunds: 12,
    tradeWarning: '11 只基金的详情交易记录补全失败，已保留账号完整流水'
  })

  assert.equal(feedback.hasWarning, true)
  assert.equal(feedback.hasChanges, true)
  assert.match(feedback.message, /更新交易记录 1 笔/)
  assert.match(feedback.message, /完整周期 0\/12 只/)
  assert.match(feedback.message, /11 只基金的详情交易记录补全失败/)
  assert.match(feedback.message, /12 只基金未通过完整周期校验/)
})

test('reports incomplete cycles even when native code did not provide a warning', () => {
  const feedback = formatGridJdImportFeedback({
    imported: 0,
    skipped: 0,
    partial: 0,
    results: [{ action: 'buy', status: 'skipped', reason: 'missing_buy_value' }]
  }, { verifiedCycles: 2, snapshotFunds: 3 })

  assert.equal(feedback.hasWarning, true)
  assert.equal(feedback.hasChanges, false)
  assert.match(feedback.message, /跳过：缺少买入金额\/净值 1 笔/)
  assert.match(feedback.message, /1 只基金未通过完整周期校验/)
})

test('does not mark a fully verified import as warning', () => {
  const feedback = formatGridJdImportFeedback({
    imported: 2,
    skipped: 0,
    partial: 0,
    results: []
  }, {
    verifiedCycles: 2,
    snapshotFunds: 2,
    tradeDiagnostic: '交易记录诊断：账号 3 页、原始 45 条、有效 40 条；详情成功 2/2 只'
  })

  assert.equal(feedback.hasWarning, false)
  assert.equal(feedback.hasChanges, true)
  assert.doesNotMatch(feedback.message, /警告/)
  assert.match(feedback.message, /账号 3 页、原始 45 条、有效 40 条/)
})
