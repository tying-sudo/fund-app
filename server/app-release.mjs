import { existsSync, readFileSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const releaseFile = process.env.APP_RELEASE_FILE || join(__dirname, 'data', 'app-version.json')
const downloadDir = process.env.APP_DOWNLOAD_DIR || '/opt/fund-downloads'

const defaultManifest = {
  version: '1.0.0',
  versionCode: 1,
  minimumVersion: '1.0.0',
  forceUpdate: false,
  title: '基金宝',
  releaseNotes: [],
  apkFileName: 'fund-app-latest.apk',
  sha256: null,
  sizeBytes: null,
  publishedAt: null
}

export function buildAppRelease(manifest = {}, fileInfo = null, origin = '') {
  const normalized = { ...defaultManifest, ...manifest }
  const apkFileName = normalized.apkFileName || defaultManifest.apkFileName
  const available = Boolean(fileInfo?.isFile && normalized.sha256)
  const base = String(origin || '').replace(/\/$/, '')
  return {
    version: String(normalized.version),
    versionCode: Number(normalized.versionCode) || 1,
    minimumVersion: String(normalized.minimumVersion || normalized.version),
    forceUpdate: Boolean(normalized.forceUpdate),
    title: String(normalized.title || '基金宝'),
    releaseNotes: Array.isArray(normalized.releaseNotes) ? normalized.releaseNotes.map(String) : [],
    available,
    apkUrl: available ? `${base}/downloads/fund-app-latest.apk` : null,
    apkFileName,
    sha256: available ? normalized.sha256 : null,
    sizeBytes: available ? Number(fileInfo.size) : null,
    publishedAt: normalized.publishedAt || null
  }
}

export function getAppRelease(origin = '') {
  let manifest = defaultManifest
  try {
    if (existsSync(releaseFile)) {
      manifest = { ...defaultManifest, ...JSON.parse(readFileSync(releaseFile, 'utf8')) }
    }
  } catch {
    manifest = defaultManifest
  }

  const apkPath = join(downloadDir, manifest.apkFileName || defaultManifest.apkFileName)
  let fileInfo = null
  try {
    const stats = statSync(apkPath)
    fileInfo = { isFile: stats.isFile(), size: stats.size }
  } catch {
    fileInfo = null
  }
  return buildAppRelease(manifest, fileInfo, origin)
}
