import { isInactiveJdAdjustment, isPendingJdAdjustment, type JdAdjustmentItem } from './jdHoldings.ts'
import { getAdjustmentConfirmationAt, getTradeTimeSlot } from './tradingDate.ts'
import type { GridJdImportPayload } from './gridJdImport.ts'

export interface GridJdPendingRefreshEntry {
  id: string
  code: string
  tradeDate: string
  eligibleAt: number
  lastAttemptAt?: number
}

/**
 * Earliest automatic recheck for a pending JD purchase. JD's terminal status
 * remains authoritative, so a public holiday can only cause another retry;
 * it can never turn an unconfirmed order into a grid batch.
 */
export function getNextJdTradingDay13At(tradeDate: string, tradeTime?: string): number {
  return getAdjustmentConfirmationAt(tradeDate, getTradeTimeSlot(tradeTime))
}

export function getGridJdPendingRefreshEntries(
  payload: GridJdImportPayload,
  selectedCodes: Iterable<string>
): GridJdPendingRefreshEntry[] {
  const selected = new Set(selectedCodes)
  const entries = payload.adjustments.flatMap((adjustment): GridJdPendingRefreshEntry[] => {
    if (!isPendingJdAdjustment(adjustment)) return []
    const code = adjustment.type === 'convert' ? adjustment.targetCode : adjustment.type === 'add' ? adjustment.code : undefined
    if (!code || !selected.has(code)) return []
    return [{
      id: adjustment.id,
      code,
      tradeDate: adjustment.tradeDate,
      eligibleAt: getNextJdTradingDay13At(adjustment.tradeDate, adjustment.tradeTime)
    }]
  })
  return [...new Map(entries.map((entry) => [`${entry.id}:${entry.code}`, entry])).values()]
    .sort((left, right) => left.eligibleAt - right.eligibleAt || left.id.localeCompare(right.id))
}

export function mergeGridJdPendingRefreshEntries(
  current: GridJdPendingRefreshEntry[],
  incoming: GridJdPendingRefreshEntry[]
): GridJdPendingRefreshEntry[] {
  const merged = new Map(current.map((entry) => [`${entry.id}:${entry.code}`, entry]))
  for (const entry of incoming) {
    const previous = merged.get(`${entry.id}:${entry.code}`)
    merged.set(`${entry.id}:${entry.code}`, previous ? { ...entry, lastAttemptAt: previous.lastAttemptAt } : entry)
  }
  return [...merged.values()].sort((left, right) => left.eligibleAt - right.eligibleAt || left.id.localeCompare(right.id))
}

/**
 * Reconcile each queued order independently. A fund's already-verified older
 * cycle must not clear a newer PAY_SUCC order for the same code.
 */
export function reconcileGridJdPendingRefreshEntries(
  current: GridJdPendingRefreshEntry[],
  due: GridJdPendingRefreshEntry[],
  latestAdjustments: JdAdjustmentItem[],
  verifiedCodes: Iterable<string>
): GridJdPendingRefreshEntry[] {
  const dueKeys = new Set(due.map((entry) => `${entry.id}:${entry.code}`))
  const latestById = new Map(latestAdjustments.map((item) => [item.id, item]))
  const verified = new Set(verifiedCodes)
  return current.filter((entry) => {
    if (!dueKeys.has(`${entry.id}:${entry.code}`)) return true
    const latest = latestById.get(entry.id)
    if (!latest) return true
    if (isInactiveJdAdjustment(latest)) return false
    if (isPendingJdAdjustment(latest)) return true
    return !verified.has(entry.code)
  })
}
