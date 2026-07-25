export interface HoldingImportValues {
  amount?: string
  profit?: string
  rate?: string
  costPrice?: string
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
