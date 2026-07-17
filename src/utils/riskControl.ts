// [WHY] 持仓风险控制模块 - 防范异常交易和过度集中风险
// [WHAT] 提供持仓上限校验、集中度检测、异常数据预警
// [SECURITY] 所有校验规则可配置，支持动态调整

/** 风险级别 */
import { getBeijingDateString } from '@/utils/tradingDate'

export type RiskLevel = 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL'

/** 风险检测结果 */
export interface RiskCheckResult {
  /** 是否通过校验 */
  passed: boolean
  /** 风险级别 */
  level: RiskLevel
  /** 警告信息列表 */
  warnings: string[]
  /** 错误信息列表（阻止操作） */
  errors: string[]
  /** 风险评分 (0-100, 越高越危险) */
  score: number
}

/** 风控配置 */
export interface RiskConfig {
  /** 单基金最大持仓金额（元） */
  maxSingleAmount: number
  /** 单基金最大持有份额 */
  maxSingleShares: number
  /** 最大持仓数量上限 */
  maxHoldingCount: number
  /** 单只基金占总资产最大比例 (%) */
  maxConcentrationRate: number
  /** 同一类型基金最大占比 (%) */
  maxTypeConcentrationRate: number
  /** 单日最大买入金额（元） */
  maxDailyBuyAmount: number
  /** 单日最大交易次数 */
  maxDailyTradeCount: number
  /** 允许的最大亏损比例 (%) - 触发预警 */
  maxLossRateWarning: number
  /** 允许的最大亏损比例 (%) - 阻止买入 */
  maxLossRateBlock: number
  /** 最小买入金额（元） */
  minBuyAmount: number
  /** 最大买入金额（元） */
  maxBuyAmount: number
}

/** 默认风控配置 */
export const DEFAULT_RISK_CONFIG: RiskConfig = {
  maxSingleAmount: 10000000,     // 单基金最高1000万
  maxSingleShares: 100000000,    // 单基金最高1亿份
  maxHoldingCount: 200,          // 最多200只基金
  maxConcentrationRate: 40,      // 单只不超40%
  maxTypeConcentrationRate: 60,  // 同类型不超60%
  maxDailyBuyAmount: 5000000,    // 日买入不超500万
  maxDailyTradeCount: 50,        // 日交易不超50次
  maxLossRateWarning: 20,        // 亏损20%预警
  maxLossRateBlock: 50,          // 亏损50%阻止
  minBuyAmount: 1,               // 最低1元
  maxBuyAmount: 10000000,        // 最高1000万
}

/** 交易统计（用于频率限制） */
interface TradeStats {
  /** 今日已交易次数 */
  todayTradeCount: number
  /** 今日已买入总金额 */
  todayBuyAmount: number
  /** 最后一次交易时间 */
  lastTradeTime: number
  /** 统计日期（YYYY-MM-DD） */
  date: string
}

/**
 * 风控管理器
 */
export class RiskController {
  private config: RiskConfig
  private tradeStats: TradeStats
  private readonly STORAGE_KEY = 'risk_trade_stats'

  constructor(config: Partial<RiskConfig> = {}) {
    this.config = { ...DEFAULT_RISK_CONFIG, ...config }
    this.tradeStats = this.loadTradeStats()
  }

  /**
   * 更新风控配置
   */
  updateConfig(updates: Partial<RiskConfig>): void {
    this.config = { ...this.config, ...updates }
    console.log('[RiskControl] 配置已更新:', updates)
  }

  /**
   * 获取当前配置
   */
  getConfig(): Readonly<RiskConfig> {
    return { ...this.config }
  }

  /**
   * 全面风控检查
   * [WHAT] 在添加/更新持仓前调用，返回详细的风险评估结果
   */
  checkRisk(params: {
    record: import('@/types/fund').HoldingRecord
    existingHoldings: import('@/types/fund').HoldingRecord[]
    totalAssetValue?: number
    isAddOperation?: boolean
  }): RiskCheckResult {
    const { record, existingHoldings, totalAssetValue = 0, isAddOperation = true } = params
    const warnings: string[] = []
    const errors: string[] = []
    let riskScore = 0

    // ===== 1. 数据有效性校验 =====
    this.validateData(record, errors)

    // ===== 2. 金额校验 =====
    this.checkAmount(record, warnings, errors, riskScore)

    // ===== 3. 持仓数量校验 =====
    this.checkHoldingCount(record, existingHoldings, warnings, errors, riskScore)

    // ===== 4. 集中度校验 =====
    this.checkConcentration(record, existingHoldings, totalAssetValue, warnings, riskScore)

    // ===== 5. 亏损预警 =====
    this.checkLossWarning(record, warnings, riskScore)

    // ===== 6. 交易频率校验（仅新增操作）=====
    if (isAddOperation) {
      this.checkTradeFrequency(record.amount, errors, riskScore)
    }

    // ===== 7. 特殊基金校验 =====
    this.checkSpecialFund(record, warnings, riskScore)

    // 计算最终风险评分
    const finalScore = Math.min(100, riskScore + errors.length * 20 + warnings.length * 5)

    // 确定风险级别
    let level: RiskLevel = 'LOW'
    if (errors.length > 0) level = 'CRITICAL'
    else if (finalScore >= 70) level = 'HIGH'
    else if (finalScore >= 40) level = 'MEDIUM'

    return {
      passed: errors.length === 0,
      level,
      warnings,
      errors,
      score: finalScore
    }
  }

  /**
   * 数据有效性校验
   */
  private validateData(record: import('@/types/fund').HoldingRecord, errors: string[]): void {
    // 金额不能为负
    if (record.amount < 0) {
      errors.push('持仓金额不能为负数')
    }

    // 份额不能为负
    if (record.shares < 0) {
      errors.push('持有份额不能为负数')
    }

    // 净值合理性
    if (record.buyNetValue <= 0) {
      errors.push('买入净值必须大于0')
    }

    // 代码格式
    if (!/^\d{6}$/.test(record.code)) {
      errors.push('基金代码格式错误（必须为6位数字）')
    }

    // 日期合理性
    if (record.buyDate) {
      // Date-only form values must be compared as Beijing calendar dates.
      // Comparing against the current timestamp rejects the current day before 08:00.
      const buyDate = record.buyDate.replace(/\//g, '-').slice(0, 10)
      const today = getBeijingDateString()
      if (buyDate > today) {
        errors.push('买入日期不能晚于今天')
      }
      
      // 不支持太早的日期（1990年之前）
      if (Number(buyDate.slice(0, 4)) < 1990) {
        errors.push('买入日期不合理')
      }
    }
  }

  /**
   * 金额范围校验
   */
  private checkAmount(
    record: import('@/types/fund').HoldingRecord,
    warnings: string[],
    errors: string[],
    scoreRef: number
  ): void {
    const amount = record.amount
    
    if (amount < this.config.minBuyAmount && amount > 0) {
      warnings.push(`金额过小（最低${this.config.minBuyAmount}元）`)
    }
    
    if (amount > this.config.maxBuyAmount) {
      errors.push(`金额超出上限（最高${this.config.maxBuyAmount}元）`)
    }
    
    if (amount > this.config.maxSingleAmount) {
      errors.push(`超出单基金持仓上限（${this.config.maxSingleAmount / 10000}万元）`)
    }

    // 检查整数金额是否合理（通常基金最小单位是1元或0.01元）
    if (amount > 0 && amount < 1) {
      warnings.push('金额不足1元，请确认')
    }
  }

  /**
   * 持仓数量校验
   */
  private checkHoldingCount(
    record: import('@/types/fund').HoldingRecord,
    existingHoldings: import('@/types/fund').HoldingRecord[],
    warnings: string[],
    errors: string[],
    scoreRef: number
  ): void {
    // 检查是否为新持仓
    const isExisting = existingHoldings.some(h => h.code === record.code)
    const currentCount = existingHoldings.length
    const newCount = isExisting ? currentCount : currentCount + 1

    if (newCount > this.config.maxHoldingCount) {
      errors.push(`持仓数量已达上限（${this.config.maxHoldingCount}只）`)
    } else if (newCount > this.config.maxHoldingCount * 0.8) {
      warnings.push(`持仓数量接近上限（${newCount}/${this.config.maxHoldingCount}）`)
    }
  }

  /**
   * 集中度校验
   */
  private checkConcentration(
    record: import('@/types/fund').HoldingRecord,
    existingHoldings: import('@/types/fund').HoldingRecord[],
    totalAssetValue: number,
    warnings: string[],
    scoreRef: number
  ): void {
    if (totalAssetValue <= 0) return

    const concentrationRate = (record.amount / totalAssetValue) * 100

    // 单只集中度
    if (concentrationRate > this.config.maxConcentrationRate) {
      warnings.push(
        `单只占比过高（${concentrationRate.toFixed(1)}%，建议不超过${this.config.maxConcentrationRate}%）`
      )
      scoreRef += 20
    } else if (concentrationRate > this.config.maxConcentrationRate * 0.8) {
      warnings.push(`单只占比偏高（${concentrationRate.toFixed(1)}%）`)
      scoreRef += 10
    }

    // 类型集中度（简化版）
    const typeKeywords = this.extractTypeKeyword(record.name || '')
    if (typeKeywords) {
      let typeTotal = record.amount
      for (const h of existingHoldings) {
        if (h.code !== record.code && this.extractTypeKeyword(h.name || '') === typeKeywords) {
          typeTotal += h.amount
        }
      }
      const typeRate = (typeTotal / totalAssetValue) * 100
      if (typeRate > this.config.maxTypeConcentrationRate) {
        warnings.push(`${typeKeywords}类型占比过高（${typeRate.toFixed(1)}%）`)
        scoreRef += 15
      }
    }
  }

  /**
   * 亏损预警
   */
  private checkLossWarning(
    record: import('@/types/fund').HoldingRecord,
    warnings: string[],
    scoreRef: number
  ): void {
    // 这里可以扩展：如果已有该基金的估值数据，检查当前亏损情况
    // 由于此时尚未获取估值，暂时跳过
    // 实际使用时可在 refreshEstimates 后调用二次检查
  }

  /**
   * 交易频率校验
   */
  private checkTradeFrequency(amount: number, errors: string[], scoreRef: number): void {
    this.refreshStatsIfNeeded()

    if (this.tradeStats.todayTradeCount >= this.config.maxDailyTradeCount) {
      errors.push(`今日交易次数已达上限（${this.config.maxDailyTradeCount}次）`)
    }

    if (this.tradeStats.todayBuyAmount + amount > this.config.maxDailyBuyAmount) {
      errors.push(`今日买入金额接近上限`)
    }
  }

  /**
   * 特殊基金校验
   */
  private checkSpecialFund(
    record: import('@/types/fund').HoldingRecord,
    warnings: string[],
    scoreRef: number
  ): void {
    const name = record.name.toLowerCase()
    
    // QDII基金提醒
    if (/qdii|全球|海外|纳斯达克|标普/i.test(name)) {
      warnings.push('QDII基金存在汇率风险和时差，净值更新较慢')
    }

    // 分级基金提醒
    if (name.includes('分级') || /\d*[Aa]$/.test(record.code.slice(-2))) {
      warnings.push('请注意分级基金风险')
    }

    // 新发基金提醒
    if (record.buyDate) {
      const establishDays = Math.floor((Date.now() - new Date(record.buyDate).getTime()) / 86400000)
      if (establishDays < 30 && record.amount > 100000) {
        warnings.push('新发基金大额投资需谨慎')
      }
    }
  }

  /**
   * 提取基金类型关键词
   */
  private extractTypeKeyword(name: string): string | null {
    if (/股票|偏股|成长/.test(name)) return '股票型'
    if (/债券|偏债|稳健/.test(name)) return '债券型'
    if (/混合|平衡/.test(name)) return '混合型'
    if (/指数|ETF|LOF/.test(name)) return '指数型'
    if (/货币|现金/.test(name)) return '货币型'
    if (/QDII|全球|海外/.test(name)) return 'QDII'
    if (/黄金|贵金属/.test(name)) return '商品型'
    return null
  }

  /**
   * 记录交易（用于频率统计）
   */
  recordTrade(amount: number): void {
    this.refreshStatsIfNeeded()
    this.tradeStats.todayTradeCount++
    this.tradeStats.todayBuyAmount += amount
    this.tradeStats.lastTradeTime = Date.now()
    this.saveTradeStats()
  }

  /**
   * 刷新统计日期（跨天重置）
   */
  private refreshStatsIfNeeded(): void {
    const today = new Date().toISOString().slice(0, 10)
    if (this.tradeStats.date !== today) {
      this.tradeStats = {
        todayTradeCount: 0,
        todayBuyAmount: 0,
        lastTradeTime: 0,
        date: today
      }
    }
  }

  /**
   * 加载交易统计
   */
  private loadTradeStats(): TradeStats {
    try {
      const raw = localStorage.getItem(this.STORAGE_KEY)
      return raw ? JSON.parse(raw) : {
        todayTradeCount: 0,
        todayBuyAmount: 0,
        lastTradeTime: 0,
        date: new Date().toISOString().slice(0, 10)
      }
    } catch {
      return {
        todayTradeCount: 0,
        todayBuyAmount: 0,
        lastTradeTime: 0,
        date: new Date().toISOString().slice(0, 10)
      }
    }
  }

  /**
   * 保存交易统计
   */
  private saveTradeStats(): void {
    try {
      localStorage.setItem(this.STORAGE_KEY, JSON.stringify(this.tradeStats))
    } catch (error) {
      console.error('[RiskControl] 保存交易统计失败:', error)
    }
  }

  /**
   * 获取当前交易统计（只读）
   */
  getTradeStats(): Readonly<TradeStats> {
    this.refreshStatsIfNeeded()
    return { ...this.tradeStats }
  }
}

/**
 * 全局风控实例（单例）
 */
let globalRiskController: RiskController | null = null

/**
 * 获取全局风控控制器
 */
export function getRiskController(config?: Partial<RiskConfig>): RiskController {
  if (!globalRiskController) {
    globalRiskController = new RiskController(config)
  } else if (config) {
    globalRiskController.updateConfig(config)
  }
  return globalRiskController
}
