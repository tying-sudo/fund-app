export interface HoldingImportValues {
  amount?: string
  profit?: string
  rate?: string
  costPrice?: string
  costAmount?: string
  shares?: string
}

export interface HoldingImportBasis {
  principal: number
  shares: number
  costPrice: number
}

export function parseHoldingImportNumber(value: unknown): number | null {
  const normalized = String(value ?? '')
    .replace(/[，,￥¥$%\s]/g, '')
    .replace(/[－–—]/g, '-')
  if (!/^[+-]?\d+(?:\.\d+)?$/.test(normalized)) return null
  const parsed = Number(normalized)
  return Number.isFinite(parsed) ? parsed : null
}

export function deriveHoldingImportBasis(values: HoldingImportValues, currentNav: number): HoldingImportBasis | null {
  const marketValue = parseHoldingImportNumber(values.amount)
  if (marketValue === null || marketValue <= 0) return null

  const profit = parseHoldingImportNumber(values.profit)
  const rate = parseHoldingImportNumber(values.rate)
  const principal = profit !== null
    ? marketValue - profit
    : rate !== null && rate > -100
      ? marketValue / (1 + rate / 100)
      : marketValue
  if (!Number.isFinite(principal) || principal <= 0) return null

  const importedShares = parseHoldingImportNumber(values.shares)
  if (importedShares !== null && importedShares > 0) {
    return { principal, shares: importedShares, costPrice: principal / importedShares }
  }

  const importedCost = parseHoldingImportNumber(values.costPrice)
  if (importedCost !== null && importedCost > 0 && importedCost < 1000) {
    return { principal, shares: principal / importedCost, costPrice: importedCost }
  }

  if (!Number.isFinite(currentNav) || currentNav <= 0) return null
  const shares = marketValue / currentNav
  return { principal, shares, costPrice: principal / shares }
}

/**
 * JD's current-holding detail already includes exact shares and normally the
 * total cost. Use that snapshot directly instead of waiting for trade history.
 */
export function deriveJdHoldingImportBasis(values: HoldingImportValues): HoldingImportBasis | null {
  const shares = parseHoldingImportNumber(values.shares)
  if (shares === null || shares <= 0) return null

  const reportedCost = parseHoldingImportNumber(values.costAmount)
  const marketValue = parseHoldingImportNumber(values.amount)
  const profit = parseHoldingImportNumber(values.profit)
  const rate = parseHoldingImportNumber(values.rate)
  // JD detail templates label their cost fields inconsistently. When the
  // displayed market value and holding profit are both present, their
  // difference is the unambiguous total principal and must win over a label
  // that may actually contain a unit cost.
  const principalFromProfit = marketValue !== null && marketValue > 0 && profit !== null
    ? marketValue - profit
    : null
  const principal = principalFromProfit !== null && principalFromProfit > 0
    ? principalFromProfit
    : reportedCost !== null && reportedCost > 0
      ? reportedCost
      : marketValue !== null && marketValue > 0 && rate !== null && rate > -100
        ? marketValue / (1 + rate / 100)
        : null
  if (principal === null || !Number.isFinite(principal) || principal <= 0) return null

  const reportedUnitCost = parseHoldingImportNumber(values.costPrice)
  const calculatedUnitCost = principal / shares
  const costPrice = reportedUnitCost !== null && reportedUnitCost > 0 && reportedUnitCost < 1000
    && Math.abs(reportedUnitCost - calculatedUnitCost) / calculatedUnitCost <= 0.03
    ? reportedUnitCost
    : calculatedUnitCost
  if (!Number.isFinite(costPrice) || costPrice <= 0) return null

  return { principal, shares, costPrice }
}

/** Build the official JD snapshot without replacing the local intraday quote. */
export function buildJdHoldingSnapshot(values: HoldingImportValues, syncedAt: number): JdHoldingSnapshot | null {
  const basis = deriveJdHoldingImportBasis(values)
  const amount = parseHoldingImportNumber(values.amount)
  const profit = parseHoldingImportNumber(values.profit)
  if (!basis || amount === null || amount <= 0 || profit === null) return null

  const reportedRate = parseHoldingImportNumber(values.rate)
  const profitRate = reportedRate ?? (profit / basis.principal) * 100
  if (!Number.isFinite(profitRate)) return null
  const costAmount = Math.round(basis.principal * 10_000) / 10_000
  return {
    source: 'jd',
    amount,
    profit,
    profitRate,
    shares: basis.shares,
    costAmount,
    costPrice: basis.costPrice,
    syncedAt
  }
}
import type { JdHoldingSnapshot } from '@/types/fund'
