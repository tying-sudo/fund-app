import {
  filterJdCurrentPositionCycle,
  isInactiveJdAdjustment,
  isPendingJdAdjustment,
  isValidJdTradeDate,
  selectVerifiedJdCurrentTimeline,
  type JdAdjustmentItem,
  type JdHoldingItem
} from './jdHoldings.ts'
import { getBeijingDateString } from './tradingDate.ts'

export interface GridJdImportPayload {
  /** Complete JD current-account scope; never narrowed by the review selection. */
  full_current_holding_codes: string[]
  /** Funds selected for this mutation. */
  current_holding_codes: string[]
  replace_transaction_codes: string[]
  /** Let the grid backend derive amount-only trade shares and current-cycle bounds. */
  resolve_current_cycles_on_server: boolean
  current_holdings: Array<{
    code: string
    name: string
    amount?: string
    shares?: string
    costPrice?: string
    costAmount?: string
    profit?: string
    profitDate?: string
    acquiredDate?: string
  }>
  adjustments: JdAdjustmentItem[]
}

/** One selectable current-fund cycle in the grid Cookie-import review. */
export interface GridJdImportCandidate {
  code: string
  name: string
  /** Confirmed buy or transfer-in records that can become grid batches. */
  candidateBatchCount: number
  transactionCount: number
  pendingTransactionCount: number
  hasHoldingSnapshot: boolean
  batches: GridJdImportCandidateBatch[]
}

/** One JD purchase leg shown before it is written as a low-frequency-grid batch. */
export interface GridJdImportCandidateBatch {
  id: string
  tradeDate: string
  tradeTime?: string
  type: 'buy' | 'convert_in' | 'snapshot'
  amount?: string
  shares?: string
  status?: string
  statusCode?: string
  pending: boolean
}

function adjustmentSortKey(adjustment: JdAdjustmentItem): string {
  return adjustment.tradeTime || `${adjustment.tradeDate} 23:59:59`
}

function cycleCodesForAdjustment(adjustment: JdAdjustmentItem, currentCodes: Set<string>): string[] {
  const codes: string[] = []
  if (currentCodes.has(adjustment.code)) codes.push(adjustment.code)
  if (adjustment.type === 'convert' && adjustment.targetCode && currentCodes.has(adjustment.targetCode)) {
    codes.push(adjustment.targetCode)
  }
  return [...new Set(codes)].sort()
}

function hasRecentExplicitPendingStatus(adjustment: JdAdjustmentItem, now: Date): boolean {
  if (!isPendingJdAdjustment(adjustment)) return false
  const code = (adjustment.statusCode || '').trim().toUpperCase().replace(/[\s-]+/g, '_')
  const status = (adjustment.status || '').trim()
  const explicitPending = /^(?:PAY_SUCC|REDEEM|PROCESS|PROCESSING|PENDING|WAIT_CONFIRM|CONFIRMING)$/.test(code)
    || /(支付成功|受理|确认中|处理中|待确认|申请中|已申请|转出中)/.test(status)
  if (!explicitPending) return false
  const tradeTime = new Date(`${adjustment.tradeDate}T00:00:00+08:00`).getTime()
  const ageDays = Math.floor((now.getTime() - tradeTime) / 86_400_000)
  return Number.isFinite(ageDays) && ageDays >= 0 && ageDays <= 14
}

/** Keep today's inbound funds even before JD has added them to the holding snapshot. */
export function buildGridJdImportPayload(
  items: JdHoldingItem[],
  adjustments: JdAdjustmentItem[],
  now = new Date(),
  options: { resolveCurrentCyclesOnServer?: boolean } = {}
): GridJdImportPayload {
  const snapshotCodes = [...new Set(items
    .map((item) => item.code.trim())
    .filter((code) => /^\d{6}$/.test(code)))]
  const today = getBeijingDateString(now)
  // A current holding's real acquisition date is its first effective buy, so
  // retain the complete JD timeline and only exclude impossible future rows.
  const normalizedAdjustments = adjustments.filter((item) =>
    /^\d{6}$/.test(item.code)
    && isValidJdTradeDate(item.tradeDate)
    && item.tradeDate <= today
    && ['add', 'reduce', 'convert'].includes(item.type)
    && !isInactiveJdAdjustment(item)
  )
  const currentCycle = filterJdCurrentPositionCycle(items, normalizedAdjustments)
  const activeInboundCodes = normalizedAdjustments.flatMap((item) => {
    const inboundCode = item.type === 'convert' ? item.targetCode : item.type === 'add' ? item.code : undefined
    if (!inboundCode || snapshotCodes.includes(inboundCode)) return []
    return item.tradeDate === today || hasRecentExplicitPendingStatus(item, now) ? [inboundCode] : []
  })
  const current_holding_codes = [...new Set([...snapshotCodes, ...activeInboundCodes])]
  const currentCodes = new Set(current_holding_codes)
  // A complete historical cycle is authoritative. Current-day and explicitly
  // pending rows are appended independently because the official snapshot has
  // not necessarily incorporated their shares yet.
  const liveAdjustments = normalizedAdjustments.flatMap((item) => {
    if (item.tradeDate !== today && !hasRecentExplicitPendingStatus(item, now)) return []
    const cycleCodes = cycleCodesForAdjustment(item, currentCodes)
    return cycleCodes.length > 0 ? [{ ...item, cycleCodes }] : []
  })
  const adjustmentMap = new Map<string, JdAdjustmentItem>()
  for (const item of [...currentCycle, ...liveAdjustments]) {
    const existing = adjustmentMap.get(item.id)
    adjustmentMap.set(item.id, existing
      ? { ...existing, cycleCodes: [...new Set([...(existing.cycleCodes || []), ...(item.cycleCodes || [])])].sort() }
      : item)
  }
  const validAdjustments = [...adjustmentMap.values()]
    .sort((left, right) => adjustmentSortKey(left).localeCompare(adjustmentSortKey(right)) || left.id.localeCompare(right.id))
  // JD's account timeline often discloses completed transfer-ins as an amount
  // only. The backend resolves their confirmation NAV, derives shares, and
  // cuts the current cycle from the reconstructed ledger. Send the complete
  // decoded timeline only for that explicit server-verified mode.
  const serverTimeline = normalizedAdjustments
    .flatMap((item) => {
      const cycleCodes = cycleCodesForAdjustment(item, currentCodes)
      return cycleCodes.length > 0 ? [{ ...item, cycleCodes }] : []
    })
    .sort((left, right) => adjustmentSortKey(left).localeCompare(adjustmentSortKey(right)) || left.id.localeCompare(right.id))
  const replace_transaction_codes = [...selectVerifiedJdCurrentTimeline(items, normalizedAdjustments).verifiedCodes].sort()
  return {
    full_current_holding_codes: current_holding_codes,
    current_holding_codes,
    replace_transaction_codes,
    resolve_current_cycles_on_server: options.resolveCurrentCyclesOnServer === true,
    current_holdings: items.flatMap((item) => {
      const code = item.code.trim()
      if (!currentCodes.has(code)) return []
      return [{
        code,
        name: item.name,
        ...(item.amount ? { amount: item.amount } : {}),
        ...(item.shares ? { shares: item.shares } : {}),
        ...(item.costPrice ? { costPrice: item.costPrice } : {}),
        ...(item.costAmount ? { costAmount: item.costAmount } : {}),
        ...(item.profit ? { profit: item.profit } : {}),
        ...(item.profitDate ? { profitDate: item.profitDate } : {}),
        ...(item.acquiredDate ? { acquiredDate: item.acquiredDate } : {})
      }]
    }),
    // Pending rows are intentionally retained. The backend persists them as
    // audit-only trade batches and never adds them to calculated shares.
    adjustments: (options.resolveCurrentCyclesOnServer ? serverTimeline : validAdjustments).filter((item) => {
      return currentCodes.has(item.code) || Boolean(item.targetCode && currentCodes.has(item.targetCode))
    })
  }
}

function adjustmentIncludesGridCode(adjustment: JdAdjustmentItem, code: string): boolean {
  return adjustment.cycleCodes?.includes(code) === true
    || adjustment.code === code
    || adjustment.targetCode === code
}

/**
 * Summarize each fund before any grid write. A fund remains the selection
 * unit because server reconciliation needs its full current holding cycle.
 */
export function getGridJdImportCandidates(payload: GridJdImportPayload): GridJdImportCandidate[] {
  return payload.current_holding_codes.map((code) => {
    const holding = payload.current_holdings.find((item) => item.code === code)
    const records = payload.adjustments.filter((item) => adjustmentIncludesGridCode(item, code))
    const fallback = records.find((item) => item.code === code || item.targetCode === code)
    const batches = records.flatMap((item): GridJdImportCandidateBatch[] => {
      const isBuy = item.type === 'add' && item.code === code
      const isConversionIn = item.type === 'convert' && item.targetCode === code
      if (!isBuy && !isConversionIn) return []
      return [{
        id: `${item.id}:${isConversionIn ? 'target' : 'source'}`,
        tradeDate: item.tradeDate,
        ...(item.tradeTime ? { tradeTime: item.tradeTime } : {}),
        type: isConversionIn ? 'convert_in' : 'buy',
        ...(item.amount ? { amount: item.amount } : {}),
        ...((isConversionIn ? item.targetShares : item.shares)
          ? { shares: isConversionIn ? item.targetShares : item.shares }
          : {}),
        ...(item.status ? { status: item.status } : {}),
        ...(item.statusCode ? { statusCode: item.statusCode } : {}),
        pending: isPendingJdAdjustment(item)
      }]
    })
    if (!batches.length && holding) {
      batches.push({
        id: `jd:snapshot:${code}`,
        // Profit-date is a valuation timestamp, never a holding-start date.
        // Keep an unknown baseline visibly unknown instead of inventing a buy date.
        tradeDate: holding.acquiredDate || '',
        type: 'snapshot',
        amount: holding.costAmount || holding.amount,
        shares: holding.shares,
        status: '交易批次不完整，将保留当前持仓基线',
        pending: false
      })
    }
    // A snapshot without JD's real holding-start date is useful for review,
    // but cannot become a tradable grid batch without fabricating a buy date.
    const candidateBatchCount = batches.filter((item) => !item.pending && (item.type !== 'snapshot' || Boolean(item.tradeDate))).length
    return {
      code,
      name: holding?.name || (fallback?.targetCode === code ? fallback.targetName : fallback?.name) || `基金 ${code}`,
      candidateBatchCount,
      transactionCount: records.length,
      pendingTransactionCount: records.filter(isPendingJdAdjustment).length,
      hasHoldingSnapshot: Boolean(holding),
      batches
    }
  })
}

/** Return an independent payload containing only the user-selected fund cycles. */
export function selectGridJdImportPayload(payload: GridJdImportPayload, codes: Iterable<string>): GridJdImportPayload {
  const selectedCodes = new Set([...codes].filter((code) => payload.current_holding_codes.includes(code)))
  const adjustments = payload.adjustments.flatMap((item) => {
    const cycleCodes = item.cycleCodes?.filter((code) => selectedCodes.has(code))
    const included = cycleCodes?.length
      || (!item.cycleCodes?.length && (selectedCodes.has(item.code) || Boolean(item.targetCode && selectedCodes.has(item.targetCode))))
    if (!included) return []
    return [{
      ...item,
      ...(item.cycleCodes ? { cycleCodes } : {})
    }]
  })
  return {
    ...payload,
    // Preserve the complete account scope so a partial import cannot make the
    // backend delete an unselected but still-current JD-managed fund.
    full_current_holding_codes: payload.full_current_holding_codes,
    current_holding_codes: payload.current_holding_codes.filter((code) => selectedCodes.has(code)),
    replace_transaction_codes: payload.replace_transaction_codes.filter((code) => selectedCodes.has(code)),
    current_holdings: payload.current_holdings.filter((item) => selectedCodes.has(item.code)),
    adjustments
  }
}

export interface GridJdImportSummaryInput {
  results: Array<{
    action?: string
    status: 'imported' | 'updated' | 'partial' | 'skipped'
    reason?: string
  }>
}

export interface GridJdImportSummary {
  baselineImported: number
  baselineUpdated: number
  baselineUnchanged: number
  transactionImported: number
  transactionUpdated: number
  transactionExisting: number
  transactionPartial: number
  rejected: number
}

/** Separate position baselines from real trades so duplicate snapshots are not reported as failed trades. */
export function summarizeGridJdImportResult(result: GridJdImportSummaryInput): GridJdImportSummary {
  const summary: GridJdImportSummary = {
    baselineImported: 0,
    baselineUpdated: 0,
    baselineUnchanged: 0,
    transactionImported: 0,
    transactionUpdated: 0,
    transactionExisting: 0,
    transactionPartial: 0,
    rejected: 0
  }
  for (const item of result.results) {
    const baseline = item.action === 'seed'
    if (baseline) {
      if (item.status === 'imported') summary.baselineImported++
      else if (item.status === 'updated') summary.baselineUpdated++
      else if (item.status === 'skipped' && item.reason === 'duplicate') summary.baselineUnchanged++
      else if (item.status === 'skipped' || item.status === 'partial') summary.rejected++
      continue
    }
    if (item.action === 'replace_audit') continue
    if (item.status === 'imported') summary.transactionImported++
    else if (item.status === 'updated') summary.transactionUpdated++
    else if (item.status === 'partial') summary.transactionPartial++
    else if (item.reason === 'duplicate') summary.transactionExisting++
    else summary.rejected++
  }
  return summary
}

export interface GridJdImportFeedbackInput extends GridJdImportSummaryInput {
  imported?: number
  updated?: number
  skipped?: number
  partial?: number
  audit_imported?: number
  audit_updated?: number
  audit_skipped?: number
  audit_results?: GridJdImportSummaryInput['results']
}

export interface GridJdImportFeedback {
  message: string
  hasWarning: boolean
  hasChanges: boolean
}

const gridJdSkipReasonLabels: Record<string, string> = {
  duplicate: '已导入',
  missing_buy_value: '缺少买入金额/净值',
  missing_sell_shares: '缺少卖出份额',
  no_matching_batches: '没有可匹配买入批次',
  not_current_holding: '非当前持仓',
  existing_grid_position: '已有网格持仓',
  existing_manual_grid_position: '已有手工网格持仓',
  invalid_adjustment: '无效交易记录',
  invalid_trade_date: '交易日期无效',
  future_trade_date: '交易日期晚于今天',
  inactive_transaction: '已取消/退款/失败',
  missing_conversion_source: '缺少转换转出数据',
  missing_conversion_target: '缺少转换转入数据',
  missing_current_cycle_transaction: '缺少本轮建仓真实交易记录',
  missing_snapshot_cost: '缺少当前持仓成本/份额',
  missing_snapshot_trade_date: '缺少真实交易日期',
  missing_snapshot_value: '缺少当前持仓数据',
  unverified_current_timeline: '当前周期未通过份额校验'
}

/** Build one user-visible result that never hides native trade-read warnings. */
export function formatGridJdImportFeedback(
  result: GridJdImportFeedbackInput,
  options: { verifiedCycles: number; snapshotFunds: number; tradeWarning?: string; tradeDiagnostic?: string }
): GridJdImportFeedback {
  const legacySummary = summarizeGridJdImportResult(result)
  const auditImported = result.audit_imported ?? legacySummary.transactionImported
  const auditUpdated = result.audit_updated ?? legacySummary.transactionUpdated
  const auditSkipped = result.audit_skipped ?? legacySummary.transactionExisting
  const rebuiltBatches = result.imported || 0
  const updatedBatches = result.updated || 0
  const partial = result.partial || 0
  const verifiedCycles = Math.max(0, options.verifiedCycles || 0)
  const snapshotFunds = Math.max(0, options.snapshotFunds || 0)
  const incompleteFunds = Math.max(0, snapshotFunds - verifiedCycles)
  const details = [
    rebuiltBatches ? `重建批次 ${rebuiltBatches} 笔` : '',
    updatedBatches ? `更新批次 ${updatedBatches} 笔` : '',
    auditImported + auditUpdated ? `更新交易记录 ${auditImported + auditUpdated} 笔` : '',
    auditSkipped ? `已有交易记录 ${auditSkipped} 笔` : '',
    partial ? `部分匹配 ${partial} 笔` : '',
    snapshotFunds ? `完整周期 ${verifiedCycles}/${snapshotFunds} 只` : ''
  ].filter(Boolean)
  const allResults = [...(result.results || []), ...(result.audit_results || [])]
  const skippedReasons = Object.entries(allResults
    .filter((item) => item.status === 'skipped' && item.reason && item.reason !== 'duplicate')
    .reduce<Record<string, number>>((counts, item) => {
      counts[item.reason!] = (counts[item.reason!] || 0) + 1
      return counts
    }, {}))
    .map(([reason, count]) => `${gridJdSkipReasonLabels[reason] || reason} ${count} 笔`)
  if (skippedReasons.length) details.push(`跳过：${skippedReasons.join('、')}`)
  const tradeDiagnostic = (options.tradeDiagnostic || '').trim()
  if (tradeDiagnostic) details.push(tradeDiagnostic)

  const warnings = [
    (options.tradeWarning || '').trim(),
    incompleteFunds ? `${incompleteFunds} 只基金未通过完整周期校验，已保留当前持仓基线` : ''
  ].filter(Boolean)
  const status = details.length ? `京东网格同步结果：${details.join('，')}` : '京东网格已是最新状态'
  return {
    message: warnings.length ? `${status}；警告：${warnings.join('；')}` : status,
    hasWarning: warnings.length > 0,
    hasChanges: Boolean(rebuiltBatches || updatedBatches || auditImported || auditUpdated || partial)
  }
}
