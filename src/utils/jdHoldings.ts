import { Capacitor, registerPlugin } from '@capacitor/core'
import type { PluginListenerHandle } from '@capacitor/core'
import { addCalendarDays, getBeijingDateString } from './tradingDate.ts'

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
}

export interface JdImportResult {
  items: JdHoldingItem[]
  adjustments: JdAdjustmentItem[]
  /** Full current-holding stream used only to certify a grid import. */
  timelineAdjustments: JdAdjustmentItem[]
  summary?: JdAccountSummary
  /** A current-holding snapshot remains usable when JD's optional trade page is unavailable. */
  tradeWarning?: string
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

interface NativeJdHoldingsPlugin {
  importHoldings(): Promise<{ items?: JdHoldingItem[]; adjustments?: JdAdjustmentItem[] }>
  importHoldingsWithCookie(options: { cookie: string; background?: boolean }): Promise<{ items?: JdHoldingItem[]; adjustments?: JdAdjustmentItem[] }>
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
      status: text(candidate.status)
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
    .filter((item) => currentCodes.has(item.code) || Boolean(item.targetCode && currentCodes.has(item.targetCode)))
    .sort((left, right) => adjustmentSortKey(left).localeCompare(adjustmentSortKey(right)) || left.id.localeCompare(right.id))
  const requirements = new Map(items.flatMap((item) => {
    const shares = parseJdNumber(item.shares)
    return currentCodes.has(item.code) && shares !== null && shares > 0
      ? [[item.code, { remaining: shares, complete: false, invalid: false, ids: new Set<string>() }] as const]
      : []
  }))
  const incompleteCodes = new Set([...currentCodes].filter((code) => !requirements.has(code)))
  for (let index = ordered.length - 1; index >= 0; index--) {
    const adjustment = ordered[index]
    for (const [code, requirement] of requirements) {
      if (requirement.complete) continue
      const delta = adjustmentSharesForCode(adjustment, code)
      if (delta === null) {
        if (isRelevantToCode(adjustment, code)) requirement.invalid = true
        continue
      }
      requirement.ids.add(adjustment.id)
      requirement.remaining -= delta
      if (requirement.remaining <= 0.01 && !requirement.invalid) requirement.complete = true
    }
  }
  const selected = new Set<string>()
  const verifiedCodes = new Set<string>()
  for (const [code, requirement] of requirements) {
    if (!requirement.complete || requirement.invalid) {
      incompleteCodes.add(code)
      continue
    }
    verifiedCodes.add(code)
    for (const id of requirement.ids) selected.add(id)
  }
  return {
    adjustments: ordered.filter((item) => selected.has(item.id)),
    verifiedCodes,
    incompleteCodes
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
    .filter((item) => currentCodes.has(item.code) || Boolean(item.targetCode && currentCodes.has(item.targetCode)))
    .sort((left, right) => adjustmentSortKey(left).localeCompare(adjustmentSortKey(right)) || left.id.localeCompare(right.id))
  const selection = selectVerifiedJdCurrentTimeline(items, ordered)
  // This list is audit-only. Keep the source rows visible when JD did not
  // return enough share fields to certify a grid reconstruction.
  return selection.verifiedCodes.size > 0 ? selection.adjustments : ordered
}

function hasTerminalJdStatus(status: string): boolean {
  if (!status) return false
  if (/(支付成功|受理|确认中|处理中|待确认|申请中|已申请)/.test(status)) return false
  return /(确认|完成|成交|到账|赎回成功|转换成功|交易成功|申购成功)/.test(status)
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

/** Browser transaction capture is bounded so imports never walk the full account history. */
export const JD_TRANSACTION_HISTORY_DAYS = 30

/** Only the current five Beijing calendar days are written to the holding adjustment audit. */
export const JD_RECENT_ADJUSTMENT_DAYS = 5

/** Include today and the preceding four Beijing calendar days. */
export function isJdAdjustmentRecent(
  adjustment: Pick<JdAdjustmentItem, 'tradeDate'>,
  now = new Date(),
  days = JD_RECENT_ADJUSTMENT_DAYS
): boolean {
  if (!isValidJdTradeDate(adjustment.tradeDate)) return false
  const windowDays = Math.max(1, Math.floor(days))
  const today = getBeijingDateString(now)
  const earliest = addCalendarDays(today, -(windowDays - 1))
  return adjustment.tradeDate >= earliest && adjustment.tradeDate <= today
}

export function filterRecentJdAdjustments(
  adjustments: JdAdjustmentItem[],
  now = new Date(),
  days = JD_RECENT_ADJUSTMENT_DAYS
): JdAdjustmentItem[] {
  return adjustments.filter((adjustment) => isJdAdjustmentRecent(adjustment, now, days))
}

/**
 * Keep the 30-day browser capture available to consumers such as the grid
 * importer, while the holding page applies its stricter five-day audit limit.
 */
export function filterRecentJdTransactions(
  adjustments: JdAdjustmentItem[],
  now = new Date()
): JdAdjustmentItem[] {
  return filterRecentJdAdjustments(adjustments, now, JD_TRANSACTION_HISTORY_DAYS)
}

/** JD normally confirms pre-close orders at about noon and post-close orders at 15:00 the next day. */
export function getJdAdjustmentConfirmationAt(adjustment: JdAdjustmentItem): number {
  if (!isValidJdTradeDate(adjustment.tradeDate)) return Number.POSITIVE_INFINITY
  const time = adjustment.tradeTime?.slice(11, 16) || ''
  const timeSlot = time >= '15:00' ? 'after' : 'before'
  const date = addCalendarDays(adjustment.tradeDate, 1)
  return Date.parse(`${date}T${timeSlot === 'before' ? '12:00:00' : '15:00:00'}+08:00`)
}

/** A completed JD status wins; old rows without a status become eligible after their confirmation window. */
export function hasReachedJdConfirmationWindow(adjustment: JdAdjustmentItem, now = Date.now()): boolean {
  if (!isValidJdTradeDate(adjustment.tradeDate)) return false
  return hasTerminalJdStatus((adjustment.status || '').trim()) || now >= getJdAdjustmentConfirmationAt(adjustment)
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

export function normalizeJdImportResult(value: unknown): JdImportResult {
  const items = normalizeJdHoldingItems(value)
  const timelineAdjustments = filterRecentJdTransactions(normalizeJdAdjustments(value))
  const tradeWarning = text((value as { tradeWarning?: unknown })?.tradeWarning)
  return {
    items,
    adjustments: filterJdCurrentPositionCycle(items, timelineAdjustments),
    timelineAdjustments,
    summary: summarizeJdAccount(items),
    ...(tradeWarning ? { tradeWarning } : {})
  }
}

export function normalizeJdCookie(value: unknown): string | null {
  const cookie = String(value ?? '').trim().replace(/^cookie\s*:\s*/i, '')
  if (cookie.length < 3 || cookie.length > 16_384 || !cookie.includes('=') || /[\r\n]/.test(cookie)) return null
  return cookie
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
export async function importJdHoldingsWithCookie(cookie: string, options: { onProgress?: (progress: JdSyncProgress) => void; background?: boolean } = {}): Promise<JdImportResult> {
  if (Capacitor.getPlatform() !== 'android') {
    throw new Error('京东 Cookie 读取仅支持 Android App')
  }
  const normalizedCookie = normalizeJdCookie(cookie)
  if (!normalizedCookie) throw new Error('请输入有效的京东 Cookie')
  const listener = options.onProgress
    ? await JdHoldings.addListener('syncProgress', options.onProgress)
    : undefined
  try {
    return normalizeJdImportResult(await JdHoldings.importHoldingsWithCookie({
      cookie: normalizedCookie,
      ...(options.background ? { background: true } : {})
    }))
  } finally {
    await listener?.remove()
  }
}
