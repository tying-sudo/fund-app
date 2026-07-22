const STRUCTURED_PROMPT = `请识别这张基金“交易记录”截图，并只返回紧凑 JSON，不要输出解释：
{"y":"页面年份","n":"当前交易页基金名称","items":[{"o":"转入/转换/买入/卖出/赎回","k":"buy或sell","d":"YYYY-MM-DD","m":"HH:mm:ss","a":"金额","s":"份额","f":"转换来源基金","t":"转换目标基金","x":"交易标题"}]}

识别规则：
1. 截图顶部系统日期、年份筛选和月份分组可用于补全每笔交易年份；d 必须返回完整 YYYY-MM-DD。
2. “转入-当前基金”“买入”“定投”记为 buy；“转出”“卖出”“赎回”记为 sell。转换必须保留箭头两端：当前交易页基金在箭头左侧记为 sell，在箭头右侧记为 buy。
3. a 只填写截图明确显示的人民币金额；s 只填写截图明确显示的基金份额。不要把份额填成金额，也不要自行计算。
4. 数字去掉逗号、元、份等单位但保留小数点；m 识别不到留空；x 保留可见交易标题。
5. 忽略状态栏数字、月份标题、筛选条件和“订单完成”等状态。每笔交易只返回一次；没有交易则返回 {"y":"","n":"","items":[]}。`

export const GRID_TRADE_OCR_PROMPT = STRUCTURED_PROMPT

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

function parsePayload(response) {
  for (const candidate of [response, response?.data, extractJsonObject(response?.md_results)]) {
    if (candidate && Array.isArray(candidate.items)) return candidate
  }
  return { items: [] }
}

function getMarkdown(response) {
  for (const candidate of [response, response?.data]) {
    if (typeof candidate?.md_results === 'string') return candidate.md_results
  }
  return ''
}

function normalizePositiveNumber(value) {
  const text = String(value ?? '').replace(/[，,￥¥元份\s]/g, '')
  if (!/^\d+(?:\.\d+)?$/.test(text)) return ''
  const number = Number(text)
  return Number.isFinite(number) && number > 0 ? String(number) : ''
}

function normalizeDate(value, fallbackYear) {
  const source = String(value || '').trim().replace(/[年/.]/g, '-').replace(/[月]/g, '-').replace(/日/g, '')
  const match = /^(?:(\d{4})-)?(\d{1,2})-(\d{1,2})$/.exec(source)
  if (!match) return ''
  const year = Number(match[1] || fallbackYear)
  const month = Number(match[2])
  const day = Number(match[3])
  if (!Number.isInteger(year) || year < 2000 || year > 2100) return ''
  const date = new Date(Date.UTC(year, month - 1, day))
  if (date.getUTCFullYear() !== year || date.getUTCMonth() + 1 !== month || date.getUTCDate() !== day) return ''
  return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`
}

function normalizeType(value, description) {
  const type = String(value || '').trim().toLowerCase()
  if (type === 'buy' || /^(买入|转入|定投)/.test(type)) return 'buy'
  if (type === 'sell' || /^(卖出|转出|赎回|转换)/.test(type)) return 'sell'
  const title = String(description || '').trim()
  if (/^(买入|转入|定投)/.test(title)) return 'buy'
  if (/^(卖出|转出|赎回|转换)/.test(title)) return 'sell'
  return ''
}

function cleanText(value, maxLength = 160) {
  return String(value || '').replace(/\s+/g, ' ').trim().slice(0, maxLength)
}

function operationKind(value) {
  const text = String(value || '').trim()
  if (/^转换/.test(text)) return 'conversion'
  if (/^转入/.test(text)) return 'transfer_in'
  if (/^转出/.test(text)) return 'transfer_out'
  if (/^定投/.test(text)) return 'scheduled_buy'
  if (/^买入/.test(text)) return 'buy'
  if (/^赎回/.test(text)) return 'redeem'
  if (/^卖出/.test(text)) return 'sell'
  return ''
}

function normalizeFundIdentity(value) {
  return String(value || '')
    .replace(/[\s()（）\-]/g, '')
    .replace(/发起式/g, '发起')
    .replace(/[.…]+$/g, '')
    .toLowerCase()
}

function sameFundIdentity(left, right) {
  const a = normalizeFundIdentity(left)
  const b = normalizeFundIdentity(right)
  if (!a || !b) return false
  if (a === b) return true
  return Math.min(a.length, b.length) >= 8 && (a.startsWith(b) || b.startsWith(a))
}

function parseTradeFundNames(description, operation) {
  const compact = String(description || '').replace(/\s+/g, '')
  const body = compact.replace(/^(?:转换|转入|转出|定投|买入|赎回|卖出)[-：:]?/, '')
  if (operation === 'conversion') {
    const [source = '', target = ''] = body.split(/→|->|⇒/, 2)
    return { source: cleanText(source, 100), target: cleanText(target, 100) }
  }
  if (operation === 'transfer_in' || operation === 'scheduled_buy' || operation === 'buy') {
    return { source: '', target: cleanText(body, 100) }
  }
  return { source: cleanText(body, 100), target: '' }
}

function resolveFundCode(name, fundList) {
  const normalized = normalizeFundIdentity(name)
  if (!normalized || !Array.isArray(fundList)) return ''
  const candidates = fundList.filter(fund => !/\(后端\)$/.test(String(fund?.name || '')))
  const exact = candidates.filter(fund => normalizeFundIdentity(fund?.name) === normalized)
  if (exact.length === 1) return String(exact[0].code || '')
  const prefix = candidates.filter(fund => {
    const candidate = normalizeFundIdentity(fund?.name)
    return Math.min(candidate.length, normalized.length) >= 8
      && (candidate.startsWith(normalized) || normalized.startsWith(candidate))
  })
  return prefix.length === 1 ? String(prefix[0].code || '') : ''
}

function enrichTradeItem(item, pageFundName, fundList) {
  const operation = item.operation || operationKind(item.description)
  const parsedNames = parseTradeFundNames(item.description, operation)
  const sourceFundName = cleanText(item.source_fund_name || parsedNames.source, 100)
  const targetFundName = cleanText(item.target_fund_name || parsedNames.target, 100)
  const sourceFundCode = resolveFundCode(sourceFundName, fundList)
  const targetFundCode = resolveFundCode(targetFundName, fundList)
  let type = item.type

  if (operation === 'conversion') {
    if (sameFundIdentity(pageFundName, targetFundName)) type = 'buy'
    else if (sameFundIdentity(pageFundName, sourceFundName)) type = 'sell'
  } else if (['transfer_in', 'scheduled_buy', 'buy'].includes(operation)) type = 'buy'
  else if (['transfer_out', 'redeem', 'sell'].includes(operation)) type = 'sell'

  const {
    source_fund_name: _sourceFundName,
    target_fund_name: _targetFundName,
    source_fund_code: _sourceFundCode,
    target_fund_code: _targetFundCode,
    source_shares: _sourceShares,
    ...baseItem
  } = item
  return {
    ...baseItem,
    type,
    ...(operation ? { operation } : {}),
    ...(sourceFundName ? { source_fund_name: sourceFundName } : {}),
    ...(targetFundName ? { target_fund_name: targetFundName } : {}),
    ...(sourceFundCode ? { source_fund_code: sourceFundCode } : {}),
    ...(targetFundCode ? { target_fund_code: targetFundCode } : {}),
    ...(operation === 'conversion' && item.shares ? { source_shares: item.shares } : {})
  }
}

const TRADE_START_PATTERN = /(?:^|\s)(转入|买入|定投|转换|转出|卖出|赎回)\s*[-：:]?/m
const AMOUNT_PATTERN = /(\d[\d,，]*(?:\.\s*\d+)?)\s*元/
const SHARES_PATTERN = /(\d[\d,，]*(?:\.\s*\d+)?)\s*份/
const DATE_TIME_PATTERN = /(?<!\d)(\d{1,2})[-/.月](\d{1,2})(?:日)?\s*(\d{1,2})\s*:\s*(\d{2})(?:\s*:\s*(\d{2}))?/

function parseMarkdownTradeBlock(block, fallbackYear) {
  const source = String(block || '').replace(/\r/g, '')
  const tradeMatch = TRADE_START_PATTERN.exec(source)
  const dateMatch = DATE_TIME_PATTERN.exec(source)
  if (!tradeMatch || !dateMatch) return null

  const operation = tradeMatch[1]
  const operationType = operationKind(operation)
  const amountMatch = AMOUNT_PATTERN.exec(source)
  const sharesMatch = SHARES_PATTERN.exec(source)
  const date = normalizeDate(`${dateMatch[1]}-${dateMatch[2]}`, fallbackYear)
  const time = `${String(dateMatch[3]).padStart(2, '0')}:${dateMatch[4]}:${dateMatch[5] || '00'}`
  const amount = normalizePositiveNumber(amountMatch?.[1])
  const shares = normalizePositiveNumber(sharesMatch?.[1])
  const type = normalizeType(operation, operation)
  if (!type || !date || (!amount && !shares)) return null

  const transactionText = source.slice(tradeMatch.index)
    .replace(DATE_TIME_PATTERN, ' ')
    .replace(AMOUNT_PATTERN, ' ')
    .replace(SHARES_PATTERN, ' ')
    .replace(/订单完成/g, ' ')
    .replace(/20\d{2}年\d{1,2}月/g, ' ')
    .replace(/-\s*没有更多记录了\s*-/g, ' ')
  const compactTitle = transactionText.replace(/\s+/g, '')
  const names = parseTradeFundNames(compactTitle, operationType)
  const fundName = operationType === 'conversion' ? '' : (names.target || names.source)

  return {
    fundName: cleanText(fundName, 100),
    fallbackFundName: cleanText(names.source || names.target, 100),
    item: {
      type,
      operation: operationType,
      date,
      time,
      amount,
      shares,
      description: cleanText(transactionText)
    }
  }
}

function parseMarkdownPayload(response) {
  const markdown = getMarkdown(response)
  if (!markdown) return { fund_name: '', items: [] }
  const fallbackYear = markdown.match(/\b(20\d{2})年/)?.[1] || ''
  const parsed = markdown
    .split(/!\[[^\]]*\]\([^)]*\)/g)
    .map(block => parseMarkdownTradeBlock(block, fallbackYear))
    .filter(Boolean)

  const nameCounts = new Map()
  for (const value of parsed) {
    if (value.fundName) nameCounts.set(value.fundName, (nameCounts.get(value.fundName) || 0) + 1)
  }
  const fundName = [...nameCounts.entries()].sort((left, right) => right[1] - left[1])[0]?.[0] || ''
  const fallbackFundName = parsed.find(value => value.fallbackFundName)?.fallbackFundName || ''
  const pageFundName = fundName || fallbackFundName
  return {
    fund_name: pageFundName,
    items: parsed.map(value => enrichTradeItem(value.item, pageFundName, []))
  }
}

export function parseGridTradeOcrResponse(response, fundList = []) {
  const payload = parsePayload(response)
  const fallbackYear = /^\d{4}$/.test(String(payload.y || payload.year || ''))
    ? String(payload.y || payload.year)
    : ''
  const sourceItems = payload.items || []
  const items = []

  for (const value of sourceItems) {
    const description = cleanText(value?.x ?? value?.description ?? value?.title)
    const type = normalizeType(value?.k ?? value?.type, description)
    const operation = operationKind(value?.o ?? value?.operation ?? description)
    const date = normalizeDate(value?.d ?? value?.date, fallbackYear)
    const amount = normalizePositiveNumber(value?.a ?? value?.amount)
    const shares = normalizePositiveNumber(value?.s ?? value?.shares)
    const time = /^\d{1,2}:\d{2}(?::\d{2})?$/.test(String(value?.m ?? value?.time ?? '').trim())
      ? String(value?.m ?? value?.time).trim().padStart(8, '0')
      : ''
    if (!type || !date || (!amount && !shares)) continue
    items.push({
      type,
      operation,
      date,
      time,
      amount,
      shares,
      description,
      source_fund_name: cleanText(value?.f ?? value?.source_fund_name, 100),
      target_fund_name: cleanText(value?.t ?? value?.target_fund_name, 100)
    })
  }

  const pageFundName = cleanText(payload.n ?? payload.fund_name, 100)
  const structured = {
    fund_name: pageFundName,
    fund_code: resolveFundCode(pageFundName, fundList),
    items: items.map(item => enrichTradeItem(item, pageFundName, fundList))
  }
  if (structured.items.length > 0) return structured
  const markdown = parseMarkdownPayload(response)
  return {
    ...markdown,
    fund_code: resolveFundCode(markdown.fund_name, fundList),
    items: markdown.items.map(item => enrichTradeItem(item, markdown.fund_name, fundList))
  }
}
