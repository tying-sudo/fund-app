import { Capacitor, registerPlugin } from '@capacitor/core'
import type { PluginListenerHandle } from '@capacitor/core'
import { getAdjustmentConfirmationAt, getTradeTimeSlot } from './tradingDate.ts'

export interface JdHoldingItem {
  code: string
  name: string
  amount?: string
  yesterdayIncome?: string
  profit?: string
  rate?: string
  shares?: string
  costPrice?: string
  costAmount?: string
  profitDate?: string
  acquiredDate?: string
}

/** An explicit zero-position detail returned by JD, never inferred from absence. */
export interface JdClosedHoldingItem {
  code: string
  name?: string
  amount?: string
  shares?: string
}

export interface JdAdjustmentItem {
  id: string
  code: string
  name?: string
  type: 'add' | 'reduce' | 'convert'
  tradeDate: string
  tradeTime?: string
  shares?: string
  amount?: string
  targetCode?: string
  targetName?: string
  targetShares?: string
  status?: string
  /** Stable order state returned by queryTradeOrderList. */
  statusCode?: string
  /** JD's expected or actual share-confirmation time. */
  confirmTime?: string
  /** Current-position legs represented by this row; used to split conversions safely. */
  cycleCodes?: string[]
}

export interface JdImportResult {
  items: JdHoldingItem[]
  closedItems: JdClosedHoldingItem[]
  adjustments: JdAdjustmentItem[]
  /** Full current-holding stream used only to certify a grid import. */
  timelineAdjustments: JdAdjustmentItem[]
  /** Funds whose complete current-position cycle can replace older grid audit rows. */
  verifiedTimelineCodes: string[]
  summary?: JdAccountSummary
  /** A current-holding snapshot remains usable when JD's optional trade page is unavailable. */
  tradeWarning?: string
  /** Non-sensitive capture counts used to verify a successful Android import. */
  tradeDiagnostic?: string
}

export interface JdAccountSummary {
  yesterdayProfit: number
  yesterdayBaseValue: number
  profitDate?: string
}

export interface JdSyncProgress {
  stage: 'login' | 'reading_holdings' | 'reading_trades' | 'normalizing'
  message: string
  current?: number
  total?: number
}

export interface JdSyncProgressState {
  message: string
  percentage: number
}

interface NativeJdHoldingsPlugin {
  importHoldings(): Promise<{ items?: JdHoldingItem[]; closedItems?: JdClosedHoldingItem[]; adjustments?: JdAdjustmentItem[] }>
  importHoldingsWithCookie(options: { cookie: string; background?: boolean; grid?: boolean }): Promise<{ items?: JdHoldingItem[]; closedItems?: JdClosedHoldingItem[]; adjustments?: JdAdjustmentItem[] }>
  addListener(eventName: 'syncProgress', listenerFunc: (event: JdSyncProgress) => void): Promise<PluginListenerHandle>
}

const JdHoldings = registerPlugin<NativeJdHoldingsPlugin>('JdHoldings')

function text(value: unknown): string | undefined {
  const normalized = String(value ?? '').trim()
  return normalized || undefined
}

function hasCurrentPosition(candidate: Partial<JdHoldingItem>): boolean {
  const values = [candidate.shares, candidate.amount]
    .map(parseJdNumber)
    .filter((value): value is number => value !== null)
  return values.length === 0 || values.some((value) => value > 0)
}

function hasExplicitZeroPosition(candidate: Pick<Partial<JdHoldingItem>, 'amount' | 'shares'>): boolean {
  const values = [candidate.shares, candidate.amount]
    .map(parseJdNumber)
    .filter((value): value is number => value !== null)
  return values.length > 0 && values.every((value) => Math.abs(value) < 0.000001)
}

/** Normalize only the non-sensitive rows returned by the Android WebView flow. */
export function normalizeJdHoldingItems(value: unknown): JdHoldingItem[] {
  const items = Array.isArray((value as { items?: unknown })?.items)
    ? (value as { items: unknown[] }).items
    : []

  return items.flatMap((item): JdHoldingItem[] => {
    const candidate = item as Partial<JdHoldingItem>
    const code = text(candidate?.code) || ''
    const name = text(candidate?.name) || ''
    const acquiredDate = text(candidate?.acquiredDate)
    const costAmount = text(candidate?.costAmount)
    if (!/^\d{6}$/.test(code) || !name || !hasCurrentPosition(candidate)) return []
    return [{
      code,
      name,
      amount: text(candidate.amount),
      yesterdayIncome: text(candidate.yesterdayIncome),
      profit: text(candidate.profit),
      rate: text(candidate.rate),
      shares: text(candidate.shares),
      costPrice: text(candidate.costPrice),
      ...(costAmount ? { costAmount } : {}),
      profitDate: text(candidate.profitDate),
      ...(acquiredDate ? { acquiredDate } : {})
    }]
  })
}

/** Only use native-reported zero rows; a missing fund row is never a close signal. */
export function normalizeJdClosedHoldingItems(value: unknown): JdClosedHoldingItem[] {
  const items = Array.isArray((value as { closedItems?: unknown })?.closedItems)
    ? (value as { closedItems: unknown[] }).closedItems
    : []
  return items.flatMap((item): JdClosedHoldingItem[] => {
    const candidate = item as Partial<JdClosedHoldingItem>
    const code = text(candidate.code) || ''
    if (!/^\d{6}$/.test(code) || !hasExplicitZeroPosition(candidate)) return []
    return [{
      code,
      name: text(candidate.name),
      amount: text(candidate.amount),
      shares: text(candidate.shares)
    }]
  })
}

function normalizeJdAdjustments(value: unknown): JdAdjustmentItem[] {
  const adjustments = Array.isArray((value as { adjustments?: unknown })?.adjustments)
    ? (value as { adjustments: unknown[] }).adjustments
    : []

  return adjustments.flatMap((item): JdAdjustmentItem[] => {
    const candidate = item as Partial<JdAdjustmentItem>
    const code = text(candidate?.code) || ''
    const type = text(candidate?.type)
    const tradeDate = text(candidate?.tradeDate) || ''
    if (!/^\d{6}$/.test(code) || !['add', 'reduce', 'convert'].includes(type || '') || !isValidJdTradeDate(tradeDate)) return []
    const targetCode = text(candidate.targetCode)
    const rawTradeTime = text(candidate.tradeTime)
    const tradeTime = rawTradeTime && /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}(?::\d{2})?$/.test(rawTradeTime)
      ? rawTradeTime
      : undefined
    return [{
      id: text(candidate.id) || `${code}:${type}:${tradeDate}:${text(candidate.shares) || text(candidate.amount) || ''}`,
      code,
      name: text(candidate.name),
      type: type as JdAdjustmentItem['type'],
      tradeDate,
      tradeTime,
      shares: text(candidate.shares),
      amount: text(candidate.amount),
      targetCode: targetCode && /^\d{6}$/.test(targetCode) ? targetCode : undefined,
      targetName: text(candidate.targetName),
      targetShares: text(candidate.targetShares),
      status: text(candidate.status),
      statusCode: text(candidate.statusCode)?.toUpperCase(),
      confirmTime: text(candidate.confirmTime)
    }]
  })
}

function parseJdNumber(value: unknown): number | null {
  const matched = String(value ?? '').replace(/[,，\s]/g, '').match(/[+-]?(?:\d+(?:\.\d+)?|\.\d+)/)
  if (!matched) return null
  const parsed = Number(matched[0])
  return Number.isFinite(parsed) ? parsed : null
}

function adjustmentSortKey(adjustment: JdAdjustmentItem): string {
  return adjustment.tradeTime || `${adjustment.tradeDate} 23:59:59`
}

function adjustmentSharesForCode(adjustment: JdAdjustmentItem, code: string): number | null {
  if (adjustment.code === code) {
    const shares = parseJdNumber(adjustment.shares)
    if (shares === null || shares <= 0) return null
    return adjustment.type === 'add' ? shares : -shares
  }
  if (adjustment.type === 'convert' && adjustment.targetCode === code) {
    const shares = parseJdNumber(adjustment.targetShares)
    return shares && shares > 0 ? shares : null
  }
  return null
}

export interface JdCurrentTimelineSelection {
  adjustments: JdAdjustmentItem[]
  verifiedCodes: Set<string>
  incompleteCodes: Set<string>
  selectedIdsByCode: Map<string, Set<string>>
}

function isRelevantToCode(adjustment: JdAdjustmentItem, code: string): boolean {
  return adjustment.code === code || (adjustment.type === 'convert' && adjustment.targetCode === code)
}

/**
 * Walk a current holding backwards from the shares reported by JD.  The
 * selected records end exactly at the opening of the currently-held cycle.
 * A row without usable shares before that point makes the entire fund unsafe
 * for grid materialization, rather than silently skipping that row.
 */
export function selectVerifiedJdCurrentTimeline(items: JdHoldingItem[], adjustments: JdAdjustmentItem[]): JdCurrentTimelineSelection {
  const currentCodes = new Set(items.map((item) => item.code).filter((code) => /^\d{6}$/.test(code)))
  const ordered = adjustments
    .filter((item) => !isInactiveJdAdjustment(item)
      && (currentCodes.has(item.code) || Boolean(item.targetCode && currentCodes.has(item.targetCode))))
    .sort((left, right) => adjustmentSortKey(left).localeCompare(adjustmentSortKey(right)) || left.id.localeCompare(right.id))
  const requirements = new Map(items.flatMap((item) => {
    const shares = parseJdNumber(item.shares)
    return currentCodes.has(item.code) && shares !== null && shares > 0
      ? [[item.code, { remaining: shares, complete: false, invalid: false, startIndex: -1 }] as const]
      : []
  }))
  const expectedSharesByCode = new Map(items.flatMap((item) => {
    const shares = parseJdNumber(item.shares)
    return shares !== null && shares > 0 ? [[item.code, shares] as const] : []
  }))
  const incompleteCodes = new Set([...currentCodes].filter((code) => !requirements.has(code)))
  for (let index = ordered.length - 1; index >= 0; index--) {
    const adjustment = ordered[index]
    // Pending orders are not reflected in JD's official current-share
    // snapshot yet. Keep them in the selected audit range, but never use them
    // to decide whether the confirmed current cycle reconciles.
    if (isPendingJdAdjustment(adjustment)) continue
    for (const [code, requirement] of requirements) {
      if (requirement.complete) continue
      const delta = adjustmentSharesForCode(adjustment, code)
      if (delta === null) {
        if (isRelevantToCode(adjustment, code)) requirement.invalid = true
        continue
      }
      requirement.remaining -= delta
      const expectedShares = expectedSharesByCode.get(code) || 0
      const tolerance = 0.005
      if (Math.abs(requirement.remaining) < tolerance) {
        requirement.complete = true
        requirement.startIndex = index
      } else if (requirement.remaining < -tolerance) {
        requirement.invalid = true
      }
    }
  }
  const selected = new Set<string>()
  const verifiedCodes = new Set<string>()
  const selectedIdsByCode = new Map<string, Set<string>>()
  for (const [code, requirement] of requirements) {
    if (!requirement.complete || requirement.invalid || requirement.startIndex < 0) {
      incompleteCodes.add(code)
      continue
    }
    verifiedCodes.add(code)
    const codeIds = new Set<string>()
    for (let index = requirement.startIndex; index < ordered.length; index++) {
      const adjustment = ordered[index]
      if (!isRelevantToCode(adjustment, code)) continue
      codeIds.add(adjustment.id)
      selected.add(adjustment.id)
    }
    selectedIdsByCode.set(code, codeIds)
  }
  return {
    adjustments: ordered.filter((item) => selected.has(item.id)),
    verifiedCodes,
    incompleteCodes,
    selectedIdsByCode
  }
}

/**
 * Keep only the current JD holding cycle for each fund. A verified full exit
 * closes the previous cycle; the next buy or transfer-in starts the cycle that
 * may be imported or shown in the holding audit trail.
 */
export function filterJdCurrentPositionCycle(items: JdHoldingItem[], adjustments: JdAdjustmentItem[]): JdAdjustmentItem[] {
  const currentCodes = new Set(items.map((item) => item.code).filter((code) => /^\d{6}$/.test(code)))
  const ordered = adjustments
    .filter((item) => !isInactiveJdAdjustment(item)
      && (currentCodes.has(item.code) || Boolean(item.targetCode && currentCodes.has(item.targetCode))))
    .sort((left, right) => adjustmentSortKey(left).localeCompare(adjustmentSortKey(right)) || left.id.localeCompare(right.id))
  const selection = selectVerifiedJdCurrentTimeline(items, ordered)
  return ordered.flatMap((item) => {
    const cycleCodes = [...selection.selectedIdsByCode]
      .filter(([, ids]) => ids.has(item.id))
      .map(([code]) => code)
      .sort()
    return cycleCodes.length > 0 ? [{ ...item, cycleCodes }] : []
  })
}

type JdAdjustmentStatusInput = Pick<JdAdjustmentItem, 'status' | 'statusCode'>
type JdAdjustmentTimingInput = Pick<JdAdjustmentItem, 'tradeDate' | 'tradeTime' | 'status' | 'statusCode' | 'confirmTime'>
type JdAdjustmentTagInput = JdAdjustmentTimingInput & Pick<JdAdjustmentItem, 'code' | 'type' | 'targetCode'>

function normalizeJdStatusCode(value: string | undefined): string {
  return (value || '').trim().toUpperCase().replace(/[\s-]+/g, '_')
}

/** Refunded/cancelled/failed orders stay in the audit trail but never affect positions or tags. */
export function isInactiveJdAdjustment(adjustment: JdAdjustmentStatusInput): boolean {
  const code = normalizeJdStatusCode(adjustment.statusCode)
  const status = (adjustment.status || '').trim()
  return /(?:^|_)(?:CANCEL(?:ED|LED)?|REFUND(?:_SUCC)?|FAIL(?:ED)?|CLOSED|REJECT(?:ED)?)(?:_|$)/.test(code)
    || /(取消|已撤销|撤单|退款|失败|关闭|作废|驳回)/.test(status)
}

/** PAY_SUCC, REDEEM and PROCESS still wait for share confirmation. */
export function hasTerminalJdStatus(adjustment: JdAdjustmentStatusInput): boolean {
  if (isInactiveJdAdjustment(adjustment)) return false
  const code = normalizeJdStatusCode(adjustment.statusCode)
  const status = (adjustment.status || '').trim()
  if (/^(?:PAY_SUCC|REDEEM|PROCESS|PROCESSING|PENDING|WAIT_CONFIRM|CONFIRMING)$/.test(code)) return false
  if (/^(?:COMPLETE|COMPLETED|REDEEM_SUCC|CONFIRM_SUCC|TRANSFORM_SUCC|TRANSFER_SUCC|TRADE_SUCC)$/.test(code)) return true
  if (/(支付成功|受理|确认中|处理中|待确认|申请中|已申请|转出中)/.test(status)) return false
  return /(订单完成|转出完成|确认成功|份额确认|成交|到账|赎回成功|转换成功|交易成功|申购成功)/.test(status)
}

/** Explicit JD states that have not entered the official holding shares yet. */
export function isPendingJdAdjustment(adjustment: JdAdjustmentStatusInput): boolean {
  if (isInactiveJdAdjustment(adjustment) || hasTerminalJdStatus(adjustment)) return false
  // Match the backend contract: only an explicit successful terminal state is
  // allowed into visible batch reconstruction. Unknown/legacy states remain
  // audit-only instead of being guessed as confirmed.
  return true
}

/** Inbound orders have not reached JD's current-position snapshot and protect local rows from deletion. */
export function getPendingJdInboundCodes(adjustments: JdAdjustmentItem[]): Set<string> {
  return new Set(adjustments.flatMap((adjustment) => {
    if (!isPendingJdAdjustment(adjustment)) return []
    if (adjustment.type === 'add') return [adjustment.code]
    if (adjustment.type === 'convert' && adjustment.targetCode) return [adjustment.targetCode]
    return []
  }))
}

/** Decide which explicit zero snapshots may safely remove an existing local holding. */
export function getSafeJdClosedHoldingCodes(
  closedItems: JdClosedHoldingItem[],
  currentItems: JdHoldingItem[],
  adjustments: JdAdjustmentItem[],
  localCodes: Iterable<string>
): string[] {
  const currentCodes = new Set(currentItems.map((item) => item.code))
  const pendingInboundCodes = getPendingJdInboundCodes(adjustments)
  const localCodeSet = new Set(localCodes)
  return [...new Set(closedItems.map((item) => item.code))]
    .filter((code) => localCodeSet.has(code) && !currentCodes.has(code) && !pendingInboundCodes.has(code))
}

/** A regex alone accepts impossible dates such as 2026-02-31. */
export function isValidJdTradeDate(value: string): boolean {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value)
  if (!match) return false
  const year = Number(match[1])
  const month = Number(match[2])
  const day = Number(match[3])
  const date = new Date(Date.UTC(year, month - 1, day))
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day
}

function parseJdConfirmationTime(value: string | undefined): number | null {
  const raw = (value || '').trim()
  if (!raw) return null
  if (/^\d{10,13}$/.test(raw)) {
    const numeric = Number(raw)
    const timestamp = raw.length === 10 ? numeric * 1000 : numeric
    return Number.isFinite(timestamp) ? timestamp : null
  }
  // JD may return a human-readable value such as "预计2026-08-05到账".
  // Keep the embedded calendar date instead of falling back to the next-day
  // legacy window, which would hide a redemption tag too early.
  const beijing = /(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})(?:[ T](\d{1,2}):(\d{2})(?::(\d{2}))?)?/.exec(raw)
  if (beijing) {
    const [, year, month, day, hour = '13', minute = '00', second = '00'] = beijing
    const normalized = `${year}-${month.padStart(2, '0')}-${day.padStart(2, '0')}T${hour.padStart(2, '0')}:${minute}:${second}+08:00`
    const parsed = Date.parse(normalized)
    return Number.isFinite(parsed) ? parsed : null
  }
  const parsed = Date.parse(raw)
  return Number.isFinite(parsed) ? parsed : null
}

/** Prefer JD's real confirmation time; otherwise use JD's 15:00 trading-session rule. */
export function getJdAdjustmentConfirmationAt(adjustment: JdAdjustmentTimingInput): number {
  if (!isValidJdTradeDate(adjustment.tradeDate)) return Number.POSITIVE_INFINITY
  const explicitConfirmation = parseJdConfirmationTime(adjustment.confirmTime)
  if (explicitConfirmation !== null) return explicitConfirmation
  return getAdjustmentConfirmationAt(adjustment.tradeDate, getTradeTimeSlot(adjustment.tradeTime))
}

/** A completed JD status wins; old rows without a status become eligible after their confirmation window. */
export function hasReachedJdConfirmationWindow(adjustment: JdAdjustmentTimingInput, now = Date.now()): boolean {
  if (!isValidJdTradeDate(adjustment.tradeDate)) return false
  if (isInactiveJdAdjustment(adjustment)) return false
  return hasTerminalJdStatus(adjustment) || now >= getJdAdjustmentConfirmationAt(adjustment)
}

/** A holding-row tag represents a real order that is still waiting for share confirmation. */
export function shouldShowJdAdjustmentTag(adjustment: JdAdjustmentTimingInput, now = Date.now()): boolean {
  if (!isValidJdTradeDate(adjustment.tradeDate) || isInactiveJdAdjustment(adjustment) || hasTerminalJdStatus(adjustment)) return false
  // A real JD pending state remains pending until a later sync returns a
  // terminal state. Only legacy rows without any state use the time fallback.
  if ((adjustment.statusCode || '').trim() || (adjustment.status || '').trim()) return true
  return now < getJdAdjustmentConfirmationAt(adjustment)
}

export function getJdAdjustmentTagLabel(adjustment: JdAdjustmentTagInput, fundCode: string): string | null {
  const belongsToSource = adjustment.code === fundCode
  const belongsToTarget = adjustment.type === 'convert' && adjustment.targetCode === fundCode
  if (!belongsToSource && !belongsToTarget) return null
  if (adjustment.type === 'add') return '调仓·买入'
  if (adjustment.type === 'reduce') return '调仓·卖出'
  return '调仓·转换'
}

export function summarizeJdAccount(items: JdHoldingItem[]): JdAccountSummary | undefined {
  if (items.length === 0) return undefined
  const amounts = items.map((item) => parseJdNumber(item.amount))
  const profits = items.map((item) => parseJdNumber(item.yesterdayIncome))
  // A partial sum is more misleading than the local fallback. Only persist
  // the JD total when every current holding contributed both values.
  if (amounts.some((value) => value === null) || profits.some((value) => value === null)) return undefined

  const totalAmount = amounts.reduce<number>((sum, value) => sum + (value || 0), 0)
  const yesterdayProfit = profits.reduce<number>((sum, value) => sum + (value || 0), 0)
  const profitDates = items
    .map((item) => item.profitDate)
    .filter((value): value is string => Boolean(value && /^\d{4}-\d{2}-\d{2}$/.test(value)))
    .sort()
  return {
    yesterdayProfit: Math.round(yesterdayProfit * 100) / 100,
    yesterdayBaseValue: Math.max(0, Math.round((totalAmount - yesterdayProfit) * 100) / 100),
    profitDate: profitDates.at(-1)
  }
}

/** Use JD's first effective inbound record when the holding card omits its start date. */
export function applyJdFirstInboundDates(items: JdHoldingItem[], adjustments: JdAdjustmentItem[]): JdHoldingItem[] {
  return items.map((item) => {
    if (item.acquiredDate) return item
    const firstInbound = adjustments
      .filter((adjustment) => !isInactiveJdAdjustment(adjustment)
        && ((adjustment.type === 'add' && adjustment.code === item.code)
          || (adjustment.type === 'convert' && adjustment.targetCode === item.code)))
      .sort((left, right) => adjustmentSortKey(left).localeCompare(adjustmentSortKey(right)))[0]
    return firstInbound ? { ...item, acquiredDate: firstInbound.tradeDate } : item
  })
}

export function normalizeJdImportResult(value: unknown): JdImportResult {
  const rawItems = normalizeJdHoldingItems(value)
  const closedItems = normalizeJdClosedHoldingItems(value)
  const normalizedAdjustments = normalizeJdAdjustments(value)
  const items = (value as { firstInboundDatesComplete?: unknown })?.firstInboundDatesComplete === true
    ? applyJdFirstInboundDates(rawItems, normalizedAdjustments)
    : rawItems
  const selection = selectVerifiedJdCurrentTimeline(items, normalizedAdjustments)
  const currentCycle = filterJdCurrentPositionCycle(items, normalizedAdjustments)
  // Preserve the decoded account timeline for audit and let each consumer
  // apply its own current-cycle boundary. This does not mutate holdings.
  const timelineAdjustments = [...new Map(normalizedAdjustments.map((item) => [item.id, item])).values()]
    .sort((left, right) => adjustmentSortKey(left).localeCompare(adjustmentSortKey(right)) || left.id.localeCompare(right.id))
  const tradeWarning = text((value as { tradeWarning?: unknown })?.tradeWarning)
  const tradeDiagnostic = text((value as { tradeDiagnostic?: unknown })?.tradeDiagnostic)
  return {
    items,
    closedItems,
    adjustments: currentCycle,
    timelineAdjustments,
    verifiedTimelineCodes: [...selection.verifiedCodes].sort(),
    summary: summarizeJdAccount(items),
    ...(tradeWarning ? { tradeWarning } : {}),
    ...(tradeDiagnostic ? { tradeDiagnostic } : {})
  }
}

export function normalizeJdCookie(value: unknown): string | null {
  const cookie = String(value ?? '').trim().replace(/^cookie\s*:\s*/i, '')
  if (cookie.length < 3 || cookie.length > 16_384 || !cookie.includes('=') || /[\r\n]/.test(cookie)) return null
  return cookie
}

export function toJdSyncProgressState(progress: JdSyncProgress): JdSyncProgressState {
  const ratio = progress.total && progress.total > 0
    ? Math.min(1, Math.max(0, (progress.current || 0) / progress.total))
    : 0
  const percentage = progress.stage === 'reading_holdings'
    ? 12 + Math.round(ratio * 43)
    : progress.stage === 'reading_trades'
      ? 55 + Math.round(ratio * 25)
      : ({ login: 8, normalizing: 82, saving: 88, refreshing: 95, completed: 100 } as Record<string, number>)[progress.stage] || 8
  return { message: progress.message, percentage }
}

type JdErrorKind = 'auth' | 'timeout' | 'network' | 'rate_limit' | 'server' | 'json' | 'unknown'

function errorText(error: unknown): string {
  if (typeof error === 'string') return error.trim()
  return String((error as { message?: unknown } | null)?.message || '').trim()
}

function chineseErrorReason(message: string): string {
  return message.match(/[\u3400-\u9fff][\s\S]*/)?.[0]?.trim() || ''
}

function errorStatus(error: unknown, message: string): number | null {
  const value = error as {
    status?: unknown
    statusCode?: unknown
    response?: { status?: unknown }
  } | null
  for (const candidate of [value?.status, value?.statusCode, value?.response?.status]) {
    const status = Number(candidate)
    if (Number.isInteger(status) && status >= 100 && status <= 599) return status
  }
  const match = /(?:http(?:\s+status)?\s*[:=]?\s*)?\b(401|403|429|5\d\d)\b/i.exec(message)
  return match ? Number(match[1]) : null
}

function classifyJdError(error: unknown, message: string): JdErrorKind {
  const code = String((error as { code?: unknown } | null)?.code || '').trim()
  const signal = `${code} ${message}`.toLowerCase()
  const status = errorStatus(error, message)

  if (status === 401 || status === 403
    || /(?:^|[_\s.-])(?:jd_)?(?:auth(?:entication)?|unauthorized|forbidden|login_required|cookie_(?:expired|invalid))(?:$|[_\s.-])/i.test(code)
    || /\b(?:unauthorized|forbidden|login required|sign[- ]?in required|authentication required|not authenticated)\b|loginrequiredexception|(?:cookie[^\n]*(?:expired|invalid)|(?:expired|invalid)[^\n]*cookie)/i.test(signal)) {
    return 'auth'
  }
  if (status === 429 || /\b(?:too many requests|rate[ _-]?limit(?:ed|ing)?)\b/i.test(signal)) return 'rate_limit'
  if ((status !== null && status >= 500) || /\b(?:bad gateway|service unavailable|internal server error)\b/i.test(signal)) return 'server'
  if (/(?:jsonexception|jsonobject|jsonarray|json[ _-]?parse|unexpected token|not valid json|malformed json|response[ _-]?format)/i.test(signal)) return 'json'
  if (/(?:sockettimeoutexception|timed?\s*out|timeout|etimedout)/i.test(signal)) return 'timeout'
  if (/(?:unknownhostexception|unknown host|failed to fetch|network(?: error| request)?|connectexception|connection (?:reset|refused|aborted)|econn\w*|ssl(?:exception|handshake)|certificate|\bdns\b|no route to host|socketexception|ioexception|host (?:is )?unreachable)/i.test(signal)) return 'network'
  return 'unknown'
}

export function jdImportErrorMessage(error: unknown): string {
  const message = errorText(error)
  const chineseReason = chineseErrorReason(message)
  if (chineseReason) return chineseReason

  switch (classifyJdError(error, message)) {
    case 'auth': return '京东认证已失效，请更新 Cookie 后重试'
    case 'timeout': return '京东持仓读取超时，请检查网络后重试'
    case 'network': return '京东持仓读取失败，请检查网络后重试'
    case 'rate_limit': return '京东接口请求过于频繁，请稍后重试'
    case 'server': return '京东服务暂时不可用，请稍后重试'
    case 'json': return '京东返回数据格式异常，请稍后重试'
    default: return '京东持仓读取失败，请稍后重试'
  }
}

/** Formats failures after the JD read has completed without blaming its Cookie. */
export function jdDataSaveErrorMessage(error: unknown, operation = '京东数据保存'): string {
  const message = errorText(error)
  const chineseReason = chineseErrorReason(message)
  if (chineseReason) return chineseReason

  switch (classifyJdError(error, message)) {
    case 'timeout': return `${operation}超时，请检查网络后重试`
    case 'network': return `${operation}失败，请检查网络后重试`
    case 'rate_limit': return `${operation}请求过于频繁，请稍后重试`
    case 'server': return `${operation}失败，服务暂时不可用，请稍后重试`
    case 'json': return `${operation}失败，服务返回数据格式异常，请稍后重试`
    case 'auth': return `${operation}失败，服务认证异常，请稍后重试`
    default: return `${operation}失败，请稍后重试`
  }
}

/** Opens the isolated native JD sign-in flow and returns only normalized fund data. */
export async function importJdHoldings(options: { onProgress?: (progress: JdSyncProgress) => void } = {}): Promise<JdImportResult> {
  if (Capacitor.getPlatform() !== 'android') {
    throw new Error('京东账户读取仅支持 Android App')
  }
  const listener = options.onProgress
    ? await JdHoldings.addListener('syncProgress', options.onProgress)
    : undefined
  try {
    return normalizeJdImportResult(await JdHoldings.importHoldings())
  } finally {
    await listener?.remove()
  }
}

/** Sends a user-approved Cookie only to JD's fixed holdings endpoints. */
export async function importJdHoldingsWithCookie(cookie: string, options: { onProgress?: (progress: JdSyncProgress) => void; background?: boolean; grid?: boolean } = {}): Promise<JdImportResult> {
  if (Capacitor.getPlatform() !== 'android') {
    const normalizedCookie = normalizeJdCookie(cookie)
    if (!normalizedCookie) throw new Error('Invalid JD Cookie')
    options.onProgress?.({ stage: 'login', message: 'Connecting to JD' })
    const response = await fetch('/api/jd/holdings/import', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ cookie: normalizedCookie, background: Boolean(options.background), grid: Boolean(options.grid) }),
      cache: 'no-store'
    })
    let payload: unknown = null
    try { payload = await response.json() } catch { /* handled below */ }
    if (!response.ok) {
      const error = new Error(String((payload as { error?: unknown } | null)?.error || `JD import failed (${response.status})`))
      ;(error as Error & { status?: number }).status = response.status
      throw error
    }
    return normalizeJdImportResult(payload)
  }
  const normalizedCookie = normalizeJdCookie(cookie)
  if (!normalizedCookie) throw new Error('请输入有效的京东 Cookie')
  const listener = options.onProgress
    ? await JdHoldings.addListener('syncProgress', options.onProgress)
    : undefined
  try {
    return normalizeJdImportResult(await JdHoldings.importHoldingsWithCookie({
      cookie: normalizedCookie,
      ...(options.background ? { background: true } : {}),
      ...(options.grid ? { grid: true } : {})
    }))
  } finally {
    await listener?.remove()
  }
}
