import { createHash } from 'node:crypto'
import { readFile, stat, writeFile } from 'node:fs/promises'

const [, , command, ...args] = process.argv

function parseVersion(value) {
  const match = String(value || '').match(/^(\d+)\.(\d+)\.(\d+)$/)
  if (!match) throw new Error('version must use MAJOR.MINOR.PATCH')
  return match.slice(1).map(Number)
}

function compareVersion(left, right) {
  for (let index = 0; index < 3; index += 1) {
    if (left[index] !== right[index]) return left[index] - right[index]
  }
  return 0
}

if (command === 'prepare') {
  const [root, publicManifestPath, outputPath] = args
  const packagePath = `${root}/package.json`
  const versionPath = `${root}/src/config/version.ts`
  const gradlePath = `${root}/android/app/build.gradle`
  const packageJson = JSON.parse(await readFile(packagePath, 'utf8'))
  const versionSource = await readFile(versionPath, 'utf8')
  const gradleSource = await readFile(gradlePath, 'utf8')
  const publicManifest = JSON.parse(await readFile(publicManifestPath, 'utf8'))
  const sourceVersion = parseVersion(packageJson.version)
  const publicVersion = parseVersion(publicManifest.version)
  const baseVersion = compareVersion(sourceVersion, publicVersion) > 0 ? sourceVersion : publicVersion
  const version = [baseVersion[0], baseVersion[1], baseVersion[2] + 1].join('.')
  const sourceVersionCode = Number(gradleSource.match(/versionCode\s+(\d+)/)?.[1] || 0)
  const versionCode = Math.max(sourceVersionCode, Number(publicManifest.versionCode) || 0) + 1

  packageJson.version = version
  await writeFile(packagePath, `${JSON.stringify(packageJson, null, 2)}\n`)
  await writeFile(versionPath, versionSource.replace(/APP_VERSION\s*=\s*'[^']+'/, `APP_VERSION = '${version}'`))
  await writeFile(gradlePath, gradleSource
    .replace(/versionCode\s+\d+/, `versionCode ${versionCode}`)
    .replace(/versionName\s+"[^"]+"/, `versionName "${version}"`))
  await writeFile(outputPath, `${JSON.stringify({ version, versionCode })}\n`)
} else if (command === 'manifest') {
  const [apkPath, buildStatePath, publicManifestPath, commit, changed, conflicts, outputPath] = args
  const apk = await readFile(apkPath)
  const apkStats = await stat(apkPath)
  const buildState = JSON.parse(await readFile(buildStatePath, 'utf8'))
  const publicManifest = JSON.parse(await readFile(publicManifestPath, 'utf8'))
  const shortCommit = commit.slice(0, 12)
  const manifest = {
    version: buildState.version,
    versionCode: buildState.versionCode,
    minimumVersion: publicManifest.minimumVersion || publicManifest.version,
    forceUpdate: false,
    title: '低频网格自动同步更新',
    releaseNotes: [
      `自动同步上游提交 ${shortCommit}`,
      `检测 ${changed} 个项目变更，其中 ${conflicts} 个冲突采用上游版本`,
      '保留基金宝前端界面和图片导入功能'
    ],
    apkFileName: `fund-app-${buildState.version}-${buildState.versionCode}.apk`,
    sha256: createHash('sha256').update(apk).digest('hex'),
    sizeBytes: apkStats.size,
    publishedAt: new Date().toISOString(),
    upstreamCommit: commit
  }
  await writeFile(outputPath, `${JSON.stringify(manifest)}\n`)
} else {
  throw new Error(`unknown command: ${command}`)
}
