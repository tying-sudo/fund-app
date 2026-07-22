export interface LocalHoldingDraft {
  name: string
  amount: string
  profit: string
  rate: string
}

interface FundDirectoryItem {
  code: string
  name: string
}

const METADATA_LINE = /^(基金名称|金额|持仓收益|我的持有|基金持仓|近期交易排序|全部\(?\d*\)?|股票型|债券型|混合|交易：|.*榜\s*No\.?\d+)/

function normalizeName(value: string) {
  return value
    .replace(/[.…]+$/g, '')
    .replace(/\(后端\)$/g, '')
    .replace(/[()（）\s\-]/g, '')
    .toLowerCase()
}

function cleanNumber(value: string) {
  const normalized = value.replace(/[，,￥¥$%\s]/g, '').replace(/[－–—]/g, '-')
  return /^[+-]?\d+(?:\.\d+)?$/.test(normalized) ? normalized : ''
}

function isFundNameLine(line: string) {
  return /[\u4e00-\u9fff]{4,}/.test(line) && !METADATA_LINE.test(line) && !/\d+\.\d{2}|%/.test(line)
}

export function parseLocalHoldingText(text: string): LocalHoldingDraft[] {
  const lines = text
    .split(/\r?\n/)
    .map(line => line.replace(/([\u4e00-\u9fff])\s+(?=[\u4e00-\u9fff])/g, '$1').trim())
    .filter(Boolean)
  const drafts: LocalHoldingDraft[] = []

  for (let index = 0; index < lines.length; index++) {
    if (!isFundNameLine(lines[index])) continue
    let name = lines[index].replace(/[.…]+$/g, '')
    let cursor = index + 1
    while (cursor < lines.length && isFundNameLine(lines[cursor])) {
      name += lines[cursor].replace(/[.…]+$/g, '')
      cursor++
    }

    const values: string[] = []
    let profit = ''
    let rate = ''
    for (let next = cursor; next < lines.length && !isFundNameLine(lines[next]); next++) {
      const line = lines[next]
      const rateMatch = line.match(/([+-]?\d+(?:\.\d+)?)\s*%/)
      if (rateMatch && !rate) rate = cleanNumber(rateMatch[1])
      const signed = line.match(/[+-]\d{1,3}(?:[,，]\d{3})*\.\d{2}/g) || []
      if (!profit && signed[0]) profit = cleanNumber(signed[0])
      const amounts = line.match(/(?<![+-])\d{1,3}(?:[,，]\d{3})*\.\d{2}/g) || []
      values.push(...amounts.map(cleanNumber).filter(Boolean))
    }

    const amount = values.find(value => Number(value) > 0) || ''
    if (name && amount) drafts.push({ name, amount, profit, rate })
    index = Math.max(index, cursor - 1)
  }

  return drafts
}

export function resolveLocalFund(name: string, directory: FundDirectoryItem[]) {
  const candidates = directory.filter(item => !/\(后端\)$/.test(item.name || ''))
  const normalized = normalizeName(name)
  const exact = candidates.filter(item => normalizeName(item.name) === normalized)
  if (exact.length === 1) return exact[0]

  const shareClass = normalized.match(/([abc])$/)?.[1] || ''
  const coreName = shareClass ? normalized.slice(0, -1) : normalized
  const prefix = candidates.filter(item => {
    const candidate = normalizeName(item.name)
    return candidate.startsWith(coreName) && (!shareClass || candidate.endsWith(shareClass))
  })
  return prefix.length === 1 ? prefix[0] : null
}
