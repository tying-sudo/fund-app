// [WHY] 统一数据格式化，保证 UI 展示一致性
// [WHAT] 金额、百分比、日期等格式化函数

/**
 * 格式化金额（保留2位小数）
 * [WHAT] 用于净值、市值等金额展示
 * @param value 原始数值
 * @param prefix 前缀（如 ¥）
 */
export function formatMoney(value: number | string, prefix = ''): string {
  const num = typeof value === 'string' ? parseFloat(value) : value
  if (isNaN(num)) return '--'
  return `${prefix}${num.toFixed(2)}`
}

/**
 * 格式化百分比
 * [WHAT] 用于涨跌幅展示
 * [EDGE] 正数添加 + 号，负数保留原有 - 号
 * @param value 百分比数值（如 1.23 表示 1.23%）
 * @param withSign 是否显示正负号
 */
export function formatPercent(value: number | string, withSign = true): string {
  const num = typeof value === 'string' ? parseFloat(value) : value
  if (isNaN(num)) return '--'
  const sign = withSign && num > 0 ? '+' : ''
  return `${sign}${num.toFixed(2)}%`
}

/**
 * 格式化净值（保留4位小数）
 * [WHAT] 基金净值通常保留4位小数
 */
export function formatNetValue(value: number | string): string {
  const num = typeof value === 'string' ? parseFloat(value) : value
  if (isNaN(num)) return '--'
  return num.toFixed(4)
}

/**
 * 判断涨跌状态
 * [WHAT] 用于决定文字颜色（红涨绿跌）
 * @returns 'up' | 'down' | 'flat'
 */
export function getChangeStatus(value: number | string): 'up' | 'down' | 'flat' {
  const num = typeof value === 'string' ? parseFloat(value) : value
  if (isNaN(num) || num === 0) return 'flat'
  return num > 0 ? 'up' : 'down'
}

/**
 * 生成京东金融APP基金详情页跳转链接
 * [WHAT] 点击基金代码可跳转到京东金融APP查看基金详情
 * [HOW] 使用jdmobile scheme，域名必须用lc.jr.jd.com
 * @param fundCode 基金代码
 * @returns 京东金融APP跳转链接
 */
export function getJdFundLink(fundCode: string): string {
  // 基金详情页URL（必须用lc.jr.jd.com域名，不能用m.jdjr.com）
  const fundUrl = `https://lc.jr.jd.com/finance/funddetail/home/?fundCode=${fundCode}&fundUtmSource=340&fundUtmParam=AppShare`
  // 编码后拼接到scheme中
  const encodedUrl = encodeURIComponent(fundUrl)
  return `jdmobile://share?jumpType=7&jumpUrl=${encodedUrl}`
}
