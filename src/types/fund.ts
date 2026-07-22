// [WHY] 定义基金相关的 TypeScript 类型，确保类型安全
// [WHAT] 包含基金估值、基金信息、持仓数据等核心数据结构

/**
 * 基金实时估值数据（天天基金 JSONP 返回格式）
 * [EDGE] gszzl 可能为空字符串（非交易时间）
 */
export interface FundEstimate {
  /** 基金代码 */
  fundcode: string
  /** 基金名称 */
  name: string
  /** 单位净值（上一交易日） */
  dwjz: string
  /** 估算净值 */
  gsz: string
  /** 估算涨跌幅（百分比字符串，如 "1.23"） */
  gszzl: string
  /** 估值时间（格式：2024-01-01 15:00） */
  gztime: string
  /** 后端实际采用的数据源 */
  source?: string
  /** 是否为盘中实时估值 */
  realtime?: boolean
  /** 数据是否已超过正常交易日窗口 */
  stale?: boolean
  /** The final estimate is retained after close until the next market session. */
  frozen?: boolean
  /** Underlying market used for QDII session selection. */
  market?: 'cn' | 'hk' | 'us' | 'overseas'
  /** Trading date in the underlying market. */
  marketDate?: string
  /** The snapshot only carries the previous published NAV. */
  pending?: boolean
  /** 基金类型（后端快照补充） */
  fundType?: string
  /** 是否为货币基金 */
  isMoneyMarket?: boolean
  /** 货币基金每万份收益 */
  perTenThousandIncome?: number | null
  /** 货币基金七日年化收益率 */
  sevenDayAnnualized?: number | null
  /** WealthAgent 风格的估值分类 */
  valuationType?: string
  /** 本次实际采用的估值方法 */
  valuationMethod?: string
  /** 数据/方法置信度，范围 0-1 */
  confidence?: number
  /** 置信度与降级原因 */
  confidenceNote?: string
}

/**
 * 估值数据源枚举
 * [WHY] 支持多个数据源切换，提高估值准确度
 */
export type DataSource = 'fundgz' | 'sina_ds2' | 'sina_ds3'

/** 数据源配置映射 */
export const DATA_SOURCE_CONFIG: Record<DataSource, { id: number; name: string; description: string }> = {
  fundgz: { id: 1, name: '天天基金', description: '东方财富主数据源' },
  sina_ds2: { id: 2, name: '新浪A', description: '新浪财经 growthrate 口径' },
  sina_ds3: { id: 3, name: '新浪B', description: '新浪财经 growthrate2 口径' }
} as const

/** 所有数据源列表 */
export const ALL_DATA_SOURCES: DataSource[] = ['fundgz', 'sina_ds2', 'sina_ds3']

/**
 * 带数据源标记的估值数据（扩展版）
 * [WHY] 用于多数据源对比和智能选源
 */
export interface FundEstimateWithSource extends FundEstimate {
  /** 数据来源 */
  source: DataSource
}

/**
 * 多数据源对比结果
 * [WHAT] 同时获取3个数据源的估值用于对比展示
 */
export interface MultiSourceEstimate {
  /** 基金代码 */
  code: string
  /** 各数据源的估值结果（可能部分失败） */
  sources: Partial<Record<DataSource, FundEstimateWithSource>>
  /** 当前选中的数据源 */
  activeSource: DataSource
  /** 最佳数据源（智能选源结果） */
  bestSource?: DataSource
  /** 是否今日最准 */
  isTodayBest?: boolean
  /** 是否昨日最准 */
  isYesterdayBest?: boolean
}

/**
 * 基金基本信息（基金列表项）
 * 来源：天天基金 fundcode_search.js
 */
export interface FundInfo {
  /** 基金代码 */
  code: string
  /** 基金简称 */
  name: string
  /** 基金类型（如：混合型、股票型） */
  type: string
  /** 拼音简称（用于搜索） */
  pinyin: string
}

/**
 * 基金份额类型
 * [WHAT] A类前端收费，C类销售服务费
 */
export type FundShareClass = 'A' | 'C'

/**
 * 持仓记录
 * [WHAT] 用户录入的基金持仓信息，用于计算收益
 */
export interface HoldingRecord {
  /** 基金代码 */
  code: string
  /** 基金名称 */
  name: string
  /** 基金类型（如：混合型-灵活、股票型） */
  type?: string
  /** 份额类型（A类/C类） */
  shareClass: FundShareClass
  /** 持有金额（元，实际投入的钱） */
  amount: number
  /** 买入时净值 */
  buyNetValue: number
  /** 持有份额（自动计算） */
  shares: number
  /** 持仓成本价（总成本/持有份额） */
  costPrice?: number
  /** 持仓成本单价（买入时净值） */
  costUnitPrice?: number
  /** 买入日期 */
  buyDate: string
  /** 持仓天数 */
  holdingDays: number
  /** 创建时间 */
  createdAt: number
  /** ===== A类基金专用 ===== */
  /** 买入手续费率（%，如0.15表示0.15%） */
  buyFeeRate?: number
  /** 是否已扣买入手续费 */
  buyFeeDeducted?: boolean
  /** 买入手续费金额 */
  buyFeeAmount?: number
  /** 卖出手续费率（%，根据持有天数不同） */
  sellFeeRate?: number
  /** ===== C类基金专用 ===== */
  /** 销售服务费年化费率（%，如0.4表示0.4%/年） */
  serviceFeeRate?: number
  /** 已扣除的销售服务费累计（元） */
  serviceFeeDeducted?: number
  /** 上次扣费日期 */
  lastFeeDate?: string
}

/**
 * 基金费率信息
 * [WHAT] 从API获取的基金费率详情
 */
export interface FundFeeInfo {
  /** 基金代码 */
  code: string
  /** 份额类型 */
  shareClass: FundShareClass
  /** 申购费率（A类，%） */
  buyFeeRate: number
  /** 赎回费率数组（根据持有天数） */
  sellFeeRates: { minDays: number; maxDays: number; rate: number }[]
  /** 销售服务费年化费率（C类，%） */
  serviceFeeRate: number
  /** 管理费年化费率（%） */
  managementFeeRate: number
  /** 托管费年化费率（%） */
  custodianFeeRate: number
}

/**
 * 历史净值记录
 * [WHAT] 基金每日净值数据，用于绘制走势图
 */
export interface NetValueRecord {
  /** 净值日期（YYYY-MM-DD） */
  date: string
  /** 单位净值 */
  netValue: number
  /** 累计净值 */
  totalValue: number
  /** 日涨跌幅（%） */
  changeRate: number
}

/**
 * 重仓股票
 * [WHAT] 基金持有的股票信息
 */
export interface StockHolding {
  /** 股票代码 */
  stockCode: string
  /** 股票名称 */
  stockName: string
  /** 持仓占比（%） */
  holdingRatio: number
  /** 持仓市值（万元） */
  holdingAmount: string
  /** 较上期变化 */
  changeFromLast: string
  /** 市场前缀（用于获取涨跌幅：0=深市，1=沪市，116=港股等） */
  marketPrefix?: string
  /** 当日涨跌幅（%） */
  dayChange?: number
  /** 较上一报告期的持仓占比变化（百分点） */
  quarterChange?: number | null
  /** 行业板块标签 */
  sector?: string | null
}

/**
 * 自选基金项（包含实时估值）
 * [WHAT] 自选列表中展示的基金数据，合并了基本信息和实时估值
 */
export interface WatchlistItem {
  /** 基金代码 */
  code: string
  /** 基金名称 */
  name: string
  /** 基金类型（如：混合型-灵活、股票型） */
  type?: string
  /** 估算净值 */
  estimateValue?: string
  /** 估算涨跌幅 */
  estimateChange?: string
  /** 估值时间 */
  estimateTime?: string
  /** 上一交易日净值 */
  lastValue?: string
  /** 是否加载中 */
  loading?: boolean
  /** 当日真实涨跌幅（盘后基金机构公布） */
  realChange?: number
  /** 真实涨跌幅日期 */
  realChangeDate?: string
  /** 真实涨跌幅是否为今日数据 */
  isRealChangeToday?: boolean
  /** 阶段涨幅（最新、1周、1月、3月、6月、1年） */
  periodReturns?: PeriodReturnItem[]
  // ===== 多数据源新增字段 =====
  /** 当前使用的数据源 */
  dataSource?: DataSource
  /** 各数据源的估值对比 */
  sourceComparison?: Partial<Record<DataSource, number>>
  /** 最佳数据源标记 */
  bestSourceLabel?: 'today' | 'yesterday' | null
}

/**
 * 阶段涨幅项
 */
export interface PeriodReturnItem {
  /** 周期标识 */
  period: string
  /** 显示标签 */
  label: string
  /** 涨跌幅（%） */
  change: number
}

/**
 * 持仓汇总信息
 * [WHAT] 持仓页面顶部的汇总统计数据
 */
export interface HoldingSummary {
  /** 总市值 */
  totalValue: number
  /** 总成本 */
  totalCost: number
  /** 总盈亏金额 */
  totalProfit: number
  /** 总收益率 */
  totalProfitRate: number
  /** 当日总收益 */
  todayProfit: number
  /** Latest published prior-session total profit. */
  yesterdayProfit: number
  /** Weighted return for the latest published prior session. */
  yesterdayProfitRate: number
  /** Aggregate current-session return. */
  todayProfitRate: number
}

/**
 * 待确认调仓记录
 * [WHAT] 15:00前/后加仓或减仓，先记录不立即修改持仓，等官方净值更新后自动确认
 */
export interface PendingAdjustment {
  /** 记录ID（唯一） */
  id: string
  /** 基金代码 */
  code: string
  /** 基金名称 */
  name: string
  /** 调仓类型：add=加仓，reduce=减仓 */
  type: 'add' | 'reduce'
  /** 交易日期（YYYY-MM-DD） */
  tradeDate: string
  /** 交易时段：before=15:00前，after=15:00后 */
  timeSlot: 'before' | 'after'
  /** 份额确认日期（YYYY-MM-DD） */
  confirmDate: string
  /** 加仓：原始投入金额；减仓：应扣减成本 */
  amount: number
  /** 变动份额（正数） */
  shares: number
  /** 手续费 */
  fee: number
  /** 交易时参考净值 */
  nav: number
  /** 状态 */
  status: 'pending' | 'confirmed'
  /** 创建时间 */
  createdAt: number
}


/**
 * 交易类型枚举
 */
export type TradeType = 'buy' | 'sell' | 'dividend' | 'auto_invest'

/**
 * 交易记录
 * [WHAT] 记录每笔基金交易的详细信息
 */
export interface TradeRecord {
  /** 交易ID（唯一标识） */
  id: string
  /** 基金代码 */
  code: string
  /** 基金名称 */
  name: string
  /** 交易类型 */
  type: TradeType
  /** 交易日期（YYYY-MM-DD） */
  date: string
  /** 交易金额（元） */
  amount: number
  /** 成交净值 */
  netValue: number
  /** 成交份额 */
  shares: number
  /** 手续费（元） */
  fee: number
  /** 备注 */
  remark?: string
  /** 创建时间 */
  createdAt: number
}

/**
 * 交易类型显示配置
 */
export const TRADE_TYPE_CONFIG = {
  buy: { label: '买入', color: '#e4393c' },
  sell: { label: '卖出', color: '#1db82c' },
  dividend: { label: '分红', color: '#ff9800' },
  auto_invest: { label: '定投', color: '#1989fa' }
} as const

// ========== 大盘指数相关类型 ==========

/**
 * 大盘指数数据
 */
export interface MarketIndex {
  /** 指数代码 */
  code: string
  /** 指数名称 */
  name: string
  /** 当前点位 */
  current: number
  /** 涨跌额 */
  change: number
  /** 涨跌幅（%） */
  changeRate: number
  /** 成交额（亿） */
  volume: number
}

/**
 * 基金排行项
 */
export interface FundRankItem {
  /** 基金代码 */
  code: string
  /** 基金名称 */
  name: string
  /** 基金类型 */
  type: string
  /** 单位净值 */
  netValue: number
  /** 日涨跌幅 */
  dayChange: number
  /** 近一周涨跌幅 */
  weekChange: number
  /** 近一月涨跌幅 */
  monthChange: number
  /** 近一年涨跌幅 */
  yearChange: number
}
