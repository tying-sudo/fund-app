import { hasReachedJdConfirmationWindow, isValidJdTradeDate, type JdAdjustmentItem, type JdHoldingItem } from './jdHoldings.ts'

export interface GridJdImportPayload {
  current_holding_codes: string[]
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

/** Keep the native response intact; the grid backend owns trade normalization and deduplication. */
export function buildGridJdImportPayload(items: JdHoldingItem[], adjustments: JdAdjustmentItem[]): GridJdImportPayload {
  const current_holding_codes = [...new Set(items
    .map((item) => item.code.trim())
    .filter((code) => /^\d{6}$/.test(code)))]
  const currentCodes = new Set(current_holding_codes)
  const confirmed = adjustments.filter((item) => isValidJdTradeDate(item.tradeDate) && hasReachedJdConfirmationWindow(item))
  return {
    current_holding_codes,
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
    // JD may omit confirmed shares on a transaction row. The backend derives
    // shares from the amount and official NAV on the actual order time, then
    // verifies the complete buy/sell/conversion timeline against the snapshot.
    adjustments: confirmed.filter((item) => {
      if (!/^\d{6}$/.test(item.code) || !isValidJdTradeDate(item.tradeDate) || !['add', 'reduce', 'convert'].includes(item.type)) return false
      // For a conversion, its target can be a current holding even if the
      // source was fully converted away and no longer appears in the snapshot.
      return currentCodes.has(item.code) || Boolean(item.targetCode && currentCodes.has(item.targetCode))
    })
  }
}
