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
  current_holding_codes: string[]
  replace_transaction_codes: string[]
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
  now = new Date()
): GridJdImportPayload {
  const snapshotCodes = [...new Set(items
    .map((item) => item.code.trim())
    .filter((code) => /^\d{6}$/.test(code)))]
  const today = getBeijingDateString(now)
  const normalizedAdjustments = adjustments.filter((item) =>
    /^\d{6}$/.test(item.code)
    && isValidJdTradeDate(item.tradeDate)
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
  const replace_transaction_codes = [...selectVerifiedJdCurrentTimeline(items, normalizedAdjustments).verifiedCodes].sort()
  return {
    current_holding_codes,
    replace_transaction_codes,
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
    adjustments: validAdjustments.filter((item) => {
      return currentCodes.has(item.code) || Boolean(item.targetCode && currentCodes.has(item.targetCode))
    })
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
