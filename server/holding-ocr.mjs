const STRUCTURED_PROMPT = `请从截图中分析基金持仓信息，并只返回紧凑 JSON，不要输出任何解释文字：
{"items":[{"n":"名称","c":"6位代码","a":"当前持有金额","p":"持有收益","r":"持有收益率","t":"单位成本价"}]}

字段语义：
n：基金名称。
c：基金代码。
a：当前持有金额/持仓市值，即截图中该基金当前持有部分对应的金额。
p：持有收益，即当前持仓相对成本的盈亏金额。
r：持有收益率，即当前持仓相对成本的盈亏比例，去掉百分号。
t：单位成本价/成本净值，即每份基金的持仓成本单价。

数字去掉逗号、货币符号和百分号；金额、收益、收益率中的小数点必须严格保留，不要把 23692.93 识别成 2369293；每只基金一条；识别不到的字段留空；没有识别到基金持仓则返回 {"items":[]}。`

export const HOLDING_OCR_PROMPT = STRUCTURED_PROMPT

function decodeHtml(value) {
  return String(value || '')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&#39;/g, "'")
    .replace(/&quot;/gi, '"')
}

function textFromHtml(value) {
  return decodeHtml(value).replace(/<[^>]*>/g, '').replace(/\s+/g, ' ').trim()
}

function normalizeName(value) {
  return String(value || '')
    .replace(/[.…]+$/g, '')
    .replace(/\(后端\)$/g, '')
    .replace(/[()（）\s\-]/g, '')
    .toLowerCase()
}

function cleanName(value) {
  return textFromHtml(value).replace(/[.…]+$/g, '').trim()
}

export function normalizeHoldingNumber(value, { signed = true } = {}) {
  const text = String(value ?? '')
    .replace(/[，,￥¥$%\s]/g, '')
    .replace(/[－–—]/g, '-')
    .replace(/^\+/, '+')
  if (!text) return ''
  const pattern = signed ? /^[+-]?\d+(?:\.\d+)?$/ : /^\d+(?:\.\d+)?$/
  return pattern.test(text) ? text : ''
}

function extractJsonObject(text) {
  const source = String(text || '')
  const start = source.indexOf('{')
  if (start < 0) return null
  let depth = 0
  let quoted = false
  let escaped = false
  for (let index = start; index < source.length; index++) {
    const char = source[index]
    if (quoted) {
      if (escaped) escaped = false
      else if (char === '\\') escaped = true
      else if (char === '"') quoted = false
      continue
    }
    if (char === '"') quoted = true
    else if (char === '{') depth++
    else if (char === '}' && --depth === 0) {
      try {
        return JSON.parse(source.slice(start, index + 1))
      } catch {
        return null
      }
    }
  }
  return null
}

function parseJsonItems(response) {
  const candidates = [response, response?.data, extractJsonObject(response?.md_results)]
  for (const candidate of candidates) {
    if (Array.isArray(candidate?.items)) return candidate.items
  }
  return []
}

function parseHtmlRows(markdown) {
  const rows = []
  const rowPattern = /<tr[^>]*>([\s\S]*?)<\/tr>/gi
  let rowMatch
  while ((rowMatch = rowPattern.exec(markdown || '')) !== null) {
    const cells = []
    const cellPattern = /<t[dh][^>]*>([\s\S]*?)<\/t[dh]>/gi
    let cellMatch
    while ((cellMatch = cellPattern.exec(rowMatch[1])) !== null) cells.push(textFromHtml(cellMatch[1]))
    if (cells.length === 3) rows.push(cells)
  }
  return rows
}

function parseHtmlItems(markdown) {
  const items = []
  const rows = parseHtmlRows(markdown)
  for (let index = 0; index < rows.length; index++) {
    const [name, amount, profit] = rows[index]
    if (!name || !/[\u4e00-\u9fff]{2,}/.test(name) || /^(基金名称|交易：)/.test(name) || /(?:榜\s*)?No\.?\s*\d+/i.test(name)) continue

    let rate = ''
    for (let next = index + 1; next < rows.length; next++) {
      const [nextName, , nextProfit] = rows[next]
      if (nextName && !/(?:榜\s*)?No\.?\s*\d+/i.test(nextName)) break
      if (nextProfit.includes('%')) {
        rate = nextProfit
        break
      }
    }
    const parsed = buildItem({ n: name, a: amount, p: profit, r: rate, t: '' })
    if (parsed.n && parsed.a) items.push(parsed)
  }
  return items
}

function buildItem(value = {}) {
  return {
    n: cleanName(value.n),
    c: /^\d{6}$/.test(String(value.c || '')) ? String(value.c) : '',
    a: normalizeHoldingNumber(value.a),
    p: normalizeHoldingNumber(value.p),
    r: normalizeHoldingNumber(value.r),
    t: normalizeHoldingNumber(value.t, { signed: false })
  }
}

function matchFund(item, fundList) {
  const candidates = fundList.filter(fund => !/\(后端\)$/.test(fund.name || ''))
  const byCode = item.c ? candidates.find(fund => fund.code === item.c) : null
  if (byCode) return byCode

  const normalized = normalizeName(item.n)
  if (!normalized) return null
  const exact = candidates.filter(fund => normalizeName(fund.name) === normalized)
  if (exact.length === 1) return exact[0]

  const shareClass = normalized.match(/([abc])$/)?.[1] || ''
  const coreName = shareClass ? normalized.slice(0, -1) : normalized
  const prefix = candidates.filter(fund => {
    const candidateName = normalizeName(fund.name)
    return candidateName.startsWith(coreName) && (!shareClass || candidateName.endsWith(shareClass))
  })
  return prefix.length === 1 ? prefix[0] : null
}

export function parseHoldingOcrResponse(response, fundList = []) {
  const rawItems = parseJsonItems(response)
  const parsedItems = rawItems.length > 0
    ? rawItems.map(buildItem).filter(item => item.n && item.a)
    : parseHtmlItems(response?.md_results)

  const seen = new Set()
  return parsedItems.reduce((items, item) => {
    const fund = matchFund(item, fundList)
    const resolved = fund ? { ...item, n: fund.name, c: fund.code } : item
    const key = `${resolved.c}:${normalizeName(resolved.n)}:${resolved.a}:${resolved.p}`
    if (!seen.has(key)) {
      seen.add(key)
      items.push(resolved)
    }
    return items
  }, [])
}
