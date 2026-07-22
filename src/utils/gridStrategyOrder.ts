export function mergeStrategyOrder(savedOrder: string[], availableKeys: string[]) {
  const available = new Set(availableKeys)
  const seen = new Set<string>()
  const order: string[] = []

  for (const key of [...savedOrder, ...availableKeys]) {
    if (!available.has(key) || seen.has(key)) continue
    seen.add(key)
    order.push(key)
  }
  return order
}

export function sortByStrategyOrder<T>(rows: T[], order: string[], keyFor: (row: T) => string) {
  const position = new Map(order.map((key, index) => [key, index]))
  return [...rows].sort((left, right) => {
    const leftIndex = position.get(keyFor(left))
    const rightIndex = position.get(keyFor(right))
    if (leftIndex === undefined && rightIndex === undefined) return 0
    if (leftIndex === undefined) return 1
    if (rightIndex === undefined) return -1
    return leftIndex - rightIndex
  })
}
