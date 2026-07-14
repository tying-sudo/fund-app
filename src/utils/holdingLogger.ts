// [WHY] 持仓操作日志系统 - 结构化审计追踪
// [WHAT] 记录所有持仓变更、计算过程、异常事件
// [DEBUG] 支持本地存储、导出分析、问题排查

/** 日志级别 */
export type LogLevel = 'DEBUG' | 'INFO' | 'WARN' | 'ERROR'

/** 日志条目 */
export interface LogEntry {
  /** 唯一ID */
  id: string
  /** 时间戳 */
  timestamp: number
  /** 时间字符串（北京时间） */
  timeStr: string
  /** 日志级别 */
  level: LogLevel
  /** 模块 */
  module: string
  /** 操作类型 */
  action: string
  /** 基金代码 */
  code?: string
  /** 基金名称 */
  name?: string
  /** 详细消息 */
  message: string
  /** 关联数据（JSON序列化） */
  data?: Record<string, unknown>
  /** 耗时（毫秒） */
  durationMs?: number
  /** 是否成功 */
  success?: boolean
  /** 错误信息 */
  error?: string
  /** 用户ID/设备标识 */
  deviceId?: string
}

/** 日志配置 */
export interface LoggerConfig {
  /** 是否启用 */
  enabled: boolean
  /** 本地存储最大条目数 */
  maxLocalEntries: number
  /** 控制台输出最小级别 */
  consoleLevel: LogLevel
  /** 记录到本地存储的最小级别 */
  storageLevel: LogLevel
  /** 是否包含性能数据 */
  includePerformance: boolean
  /** 是否自动上传（预留） */
  autoUpload: boolean
}

/** 默认配置 */
const DEFAULT_CONFIG: LoggerConfig = {
  enabled: true,
  maxLocalEntries: 500,
  consoleLevel: 'INFO',
  storageLevel: 'WARN',
  includePerformance: true,
  autoUpload: false
}

/** 日志级别优先级 */
const LOG_LEVEL_PRIORITY: Record<LogLevel, number> = {
  DEBUG: 0,
  INFO: 1,
  WARN: 2,
  ERROR: 3
}

/**
 * 持仓日志管理器
 */
export class HoldingLogger {
  private config: LoggerConfig
  private buffer: LogEntry[] = []
  private readonly STORAGE_KEY = 'holding_operation_logs'
  private flushTimer: ReturnType<typeof setTimeout> | null = null

  constructor(config: Partial<LoggerConfig> = {}) {
    this.config = { ...DEFAULT_CONFIG, ...config }
  }

  /**
   * 更新配置
   */
  updateConfig(updates: Partial<LoggerConfig>): void {
    this.config = { ...this.config, ...updates }
  }

  /**
   * 记录日志
   */
  log(params: {
    level: LogLevel
    module: string
    action: string
    code?: string
    name?: string
    message: string
    data?: Record<string, unknown>
    durationMs?: number
    success?: boolean
    error?: unknown
  }): void {
    if (!this.config.enabled) return

    const entry: LogEntry = {
      id: this.generateId(),
      timestamp: Date.now(),
      timeStr: new Date(Date.now() + 8 * 3600000).toISOString().replace('Z', ''),
      level: params.level,
      module: params.module,
      action: params.action,
      code: params.code,
      name: params.name,
      message: params.message,
      data: params.data,
      durationMs: params.durationMs,
      success: params.success,
      error: params.error instanceof Error ? params.error.message : String(params.error),
      deviceId: this.getDeviceId()
    }

    // 控制台输出
    if (LOG_LEVEL_PRIORITY[params.level] >= LOG_LEVEL_PRIORITY[this.config.consoleLevel]) {
      this.outputToConsole(entry)
    }

    // 存储输出
    if (LOG_LEVEL_PRIORITY[params.level] >= LOG_LEVEL_PRIORITY[this.config.storageLevel]) {
      this.buffer.push(entry)
      this.scheduleFlush()
    }
  }

  /**
   * 便捷方法：记录 INFO 级别日志
   */
  info(module: string, action: string, message: string, extras?: Partial<LogEntry>): void {
    this.log({ level: 'INFO', module, action, message, ...extras })
  }

  /**
   * 便捷方法：记录 WARN 级别日志
   */
  warn(module: string, action: string, message: string, extras?: Partial<LogEntry>): void {
    this.log({ level: 'WARN', module, action, message, ...extras })
  }

  /**
   * 便捷方法：记录 ERROR 级别日志
   */
  error(module: string, action: string, message: string, extras?: Partial<LogEntry>): void {
    this.log({ level: 'ERROR', module, action, message, ...extras })
  }

  /**
   * 便捷方法：记录 DEBUG 级别日志
   */
  debug(module: string, action: string, message: string, extras?: Partial<LogEntry>): void {
    this.log({ level: 'DEBUG', module, action, message, ...extras })
  }

  /**
   * 记录持仓添加操作
   */
  logHoldingAdd(code: string, name: string, amount: number, success: boolean, error?: unknown): void {
    this.info('HOLDING', 'ADD', `${success ? '成功' : '失败'}添加持仓`, {
      code,
      name,
      message: `金额: ${amount}`,
      data: { amount },
      success,
      error: error instanceof Error ? error.message : String(error)
    })
  }

  /**
   * 记录持仓更新操作
   */
  logHoldingUpdate(code: string, name: string, changes: Record<string, unknown>, success: boolean): void {
    this.info('HOLDING', 'UPDATE', `更新持仓`, {
      code,
      name,
      message: `变更项: ${Object.keys(changes).join(', ')}`,
      data: changes,
      success
    })
  }

  /**
   * 记录持仓删除操作
   */
  logHoldingDelete(code: string, name: string, success: boolean): void {
    this.info('HOLDING', 'DELETE', `${success ? '成功' : '失败'}删除持仓`, {
      code,
      name,
      success
    })
  }

  /**
   * 记录估值刷新操作
   */
  logRefreshStart(count: number): void {
    this.debug('CALCULATION', 'REFRESH_START', `开始刷新 ${count} 只基金估值`)
  }

  logRefreshComplete(
    count: number,
    successCount: number,
    failCount: number,
    durationMs: number
  ): void {
    this.info('CALCULATION', 'REFRESH_COMPLETE', 
      `刷新完成: ${successCount} 成功, ${failCount} 失败`,
      { durationMs, data: { count, successCount, failCount } }
    )
  }

  logSingleFundRefresh(code: string, name: string, success: boolean, durationMs?: number): void {
    this.debug('CALCULATION', 'SINGLE_REFRESH', 
      `${success ? '成功' : '失败'}刷新 ${name}`,
      { code, name, success, durationMs }
    )
  }

  /**
   * 记录风控检查
   */
  logRiskCheck(code: string, name: string, passed: boolean, details: {
    warnings: string[]
    errors: string[]
    score: number
  }): void {
    if (!passed) {
      this.warn('RISK', 'CHECK', `风控未通过: ${name}`, {
        code,
        name,
        success: false,
        data: details
      })
    } else if (details.score > 30) {
      this.info('RISK', 'CHECK', `风控通过但存在风险点: ${name}`, {
        code,
        name,
        success: true,
        data: details
      })
    } else {
      this.debug('RISK', 'CHECK', `风控通过: ${name}`, { code, name })
    }
  }

  /**
   * 记录计算过程（调试用）
   */
  logCalculationDetail(
    code: string,
    step: string,
    inputs: Record<string, unknown>,
    outputs: Record<string, unknown>
  ): void {
    this.debug('CALCULATION', step, `[${code}] 计算步骤详情`, {
      code,
      data: { inputs, outputs }
    })
  }

  /**
   * 导出日志（用于问题排查）
   */
  exportLogs(level?: LogLevel, limit?: number): LogEntry[] {
    const allLogs = this.loadLogsFromStorage()
    
    let filtered = allLogs
    if (level) {
      filtered = allLogs.filter(log => LOG_LEVEL_PRIORITY[log.level] >= LOG_LEVEL_PRIORITY[level])
    }
    
    if (limit) {
      filtered = filtered.slice(-limit)
    }
    
    return filtered
  }

  /**
   * 清除本地日志
   */
  clearLogs(): void {
    try {
      localStorage.removeItem(this.STORAGE_KEY)
      this.buffer = []
    } catch (error) {
      console.error('[HoldingLogger] 清除日志失败:', error)
    }
  }

  /**
   * 获取日志统计
   */
  getLogStats(): {
    totalInStorage: number
    inBuffer: number
    latestError?: LogEntry
    operationCounts: Record<string, number>
  } {
    const storedLogs = this.loadLogsFromStorage()
    const operationCounts: Record<string, number> = {}
    
    for (const log of storedLogs) {
      const key = `${log.module}:${log.action}`
      operationCounts[key] = (operationCounts[key] || 0) + 1
    }
    
    const latestError = [...storedLogs].reverse().find(l => l.level === 'ERROR')
    
    return {
      totalInStorage: storedLogs.length,
      inBuffer: this.buffer.length,
      latestError,
      operationCounts
    }
  }

  // ========== 私有方法 ==========

  /**
   * 生成唯一ID
   */
  private generateId(): string {
    return `log_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`
  }

  /**
   * 获取设备标识（简化版）
   */
  private getDeviceId(): string {
    const stored = localStorage.getItem('device_id')
    if (stored) return stored
    const newId = `device_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`
    localStorage.setItem('device_id', newId)
    return newId
  }

  /**
   * 输出到控制台
   */
  private outputToConsole(entry: LogEntry): void {
    const prefix = `[${entry.timeStr}] [${entry.level}] [${entry.module}:${entry.action}]`
    const args = [
      prefix,
      entry.message,
      entry.code ? `(Code: ${entry.code})` : '',
      entry.name ? `(Name: ${entry.name})` : ''
    ].filter(Boolean)
    
    switch (entry.level) {
      case 'ERROR':
        console.error(...args, entry.error || '', entry.data || '')
        break
      case 'WARN':
        console.warn(...args, entry.data || '')
        break
      case 'DEBUG':
        console.debug(...args, entry.data || '')
        break
      default:
        console.log(...args, entry.data || '')
    }
  }

  /**
   * 安排批量写入
   */
  private scheduleFlush(): void {
    if (this.flushTimer) return
    
    this.flushTimer = setTimeout(() => {
      this.flush()
      this.flushTimer = null
    }, 1000) // 1秒内多次日志合并写入
  }

  /**
   * 写入日志到本地存储
   */
  private flush(): void {
    if (this.buffer.length === 0) return

    try {
      const existingLogs = this.loadLogsFromStorage()
      const mergedLogs = [...existingLogs, ...this.buffer]
      
      // 限制存储数量（保留最新的）
      const trimmedLogs = mergedLogs.slice(-this.config.maxLocalEntries)
      
      localStorage.setItem(this.STORAGE_KEY, JSON.stringify(trimmedLogs))
      this.buffer = []
    } catch (error) {
      // 存储空间不足时尝试清理
      if (error instanceof DOMException && error.name === 'QuotaExceededError') {
        console.warn('[HoldingLogger] 存储空间不足，清理旧日志')
        try {
          const logs = this.loadLogsFromStorage()
          localStorage.setItem(this.STORAGE_KEY, JSON.stringify(logs.slice(-Math.floor(this.config.maxLocalEntries / 2))))
        } catch {
          // 无法恢复
        }
      }
    }
  }

  /**
   * 从本地存储加载日志
   */
  private loadLogsFromStorage(): LogEntry[] {
    try {
      const raw = localStorage.getItem(this.STORAGE_KEY)
      return raw ? JSON.parse(raw) : []
    } catch {
      return []
    }
  }
}

/**
 * 全局日志实例（单例）
 */
let globalLogger: HoldingLogger | null = null

/**
 * 获取全局日志管理器
 */
export function getHoldingLogger(config?: Partial<LoggerConfig>): HoldingLogger {
  if (!globalLogger) {
    globalLogger = new HoldingLogger(config)
  } else if (config) {
    globalLogger.updateConfig(config)
  }
  return globalLogger
}
