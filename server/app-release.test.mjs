import test from 'node:test'
import assert from 'node:assert/strict'

import { buildAppRelease } from './app-release.mjs'

test('does not advertise an APK before a verified artifact exists', () => {
  const release = buildAppRelease({ version: '1.2.3', sha256: 'abc' }, null, 'https://tyingfund.com')
  assert.equal(release.available, false)
  assert.equal(release.apkUrl, null)
  assert.equal(release.sha256, null)
})

test('publishes same-origin APK metadata with integrity fields', () => {
  const release = buildAppRelease({
    version: '1.2.3', versionCode: 123, minimumVersion: '1.1.0', forceUpdate: true,
    releaseNotes: ['修复数据源'], sha256: 'deadbeef', apkFileName: 'fund-app-1.2.3.apk'
  }, { isFile: true, size: 456 }, 'https://www.tyingfund.com/')
  assert.deepEqual(release, {
    version: '1.2.3', versionCode: 123, minimumVersion: '1.1.0', forceUpdate: true,
    title: '基金宝', releaseNotes: ['修复数据源'], available: true,
    apkUrl: 'https://www.tyingfund.com/downloads/fund-app-latest.apk',
    apkFileName: 'fund-app-1.2.3.apk', sha256: 'deadbeef', sizeBytes: 456, publishedAt: null
  })
})
