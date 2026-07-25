import test from 'node:test'
import assert from 'node:assert/strict'

import { createInitialWatchlistItem, resolveWatchlistName } from './watchlistIdentity.ts'

test('initial watchlist item uses the fund directory name and type', () => {
  assert.deepEqual(createInitialWatchlistItem('008888', {
    name: ' 华夏国证半导体芯片ETF联接C ',
    type: ' 指数型-股票 '
  }), {
    code: '008888',
    name: '华夏国证半导体芯片ETF联接C',
    type: '指数型-股票',
    loading: true
  })
})

test('an empty estimate name cannot overwrite a known watchlist name', () => {
  assert.equal(resolveWatchlistName('', '华夏国证半导体芯片ETF联接C'), '华夏国证半导体芯片ETF联接C')
  assert.equal(resolveWatchlistName('  ', '华夏国证半导体芯片ETF联接C'), '华夏国证半导体芯片ETF联接C')
  assert.equal(resolveWatchlistName('新名称', '旧名称'), '新名称')
})
