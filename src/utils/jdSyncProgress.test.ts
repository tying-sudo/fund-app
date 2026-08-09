import assert from 'node:assert/strict'
import test from 'node:test'
import { mergeJdSyncProgress } from './jdSyncProgress.ts'

test('keeps percentage monotonic while still showing the latest progress message', () => {
  const reading = { message: '正在读取京东持仓（4/7）...', percentage: 37 }
  const fallback = { message: '新版读取未完成，正在使用兼容读取...', percentage: 12 }

  assert.deepEqual(mergeJdSyncProgress(reading, fallback), {
    message: fallback.message,
    percentage: 37
  })
  assert.deepEqual(mergeJdSyncProgress(reading, { message: '正在读取交易记录', percentage: 55 }), {
    message: '正在读取交易记录',
    percentage: 55
  })
})

test('explicitly resets percentage when a separate import task starts', () => {
  assert.deepEqual(
    mergeJdSyncProgress(
      { message: '上次同步完成', percentage: 100 },
      { message: '正在读取京东当前持仓...', percentage: 12 },
      true
    ),
    { message: '正在读取京东当前持仓...', percentage: 12 }
  )
})
