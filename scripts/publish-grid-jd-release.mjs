import { createRequire } from 'node:module'
import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { readFile, readdir, stat } from 'node:fs/promises'
import { dirname, join, posix, relative } from 'node:path'

const require = createRequire(import.meta.url)
const { Client } = require('C:\\tmp\\codex-ssh-deploy\\node_modules\\ssh2')
const root = process.cwd()
const gridRoot = join(root, 'vendor', 'valuation_grid')
const apkPath = join(root, 'android', 'app', 'build', 'outputs', 'apk', 'debug', 'app-debug.apk')
const version = JSON.parse(await readFile(join(root, 'package.json'), 'utf8')).version
const versionCode = Number((await readFile(join(root, 'android', 'app', 'build.gradle'), 'utf8')).match(/versionCode\s+(\d+)/)?.[1])
const releaseStamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\..+$/, '')
const gridRemote = '/opt/valuation-grid'
const webRoot = '/opt/fund-app'
const webNext = `${webRoot}.next`
const webPrevious = `${webRoot}.previous-${releaseStamp}`
const proxyRoot = '/opt/fund-proxy'
const downloadRoot = '/opt/fund-downloads'

async function envValue(name) {
  for (const file of ['.env.production.local', '.env.local']) {
    const content = await readFile(join(root, file), 'utf8').catch(() => '')
    const match = content.match(new RegExp(`^${name}=(.*)$`, 'm'))
    if (match?.[1]) return match[1].trim().replace(/^['"]|['"]$/g, '')
  }
  return process.env[name] || ''
}

const host = await envValue('DEPLOY_SSH_HOST')
const privateKeyPath = await envValue('DEPLOY_SSH_PRIVATE_KEY')
const password = await envValue('DEPLOY_SSH_PASSWORD')
if (!host || (!privateKeyPath && !password)) throw new Error('deployment credentials are unavailable')

function connect(privateKey) {
  return new Promise((resolve, reject) => {
    const client = new Client()
    client.on('ready', () => resolve(client)).on('error', reject).connect({
      host,
      username: 'root',
      ...(privateKey ? { privateKey } : { password }),
      readyTimeout: 20_000
    })
  })
}

function exec(client, command) {
  return new Promise((resolve, reject) => {
    client.exec(command, (error, stream) => {
      if (error) return reject(error)
      let output = ''
      stream.on('data', (data) => { output += data })
      stream.stderr.on('data', (data) => { output += data })
      stream.on('close', (code) => code === 0 ? resolve(output) : reject(new Error(output || `remote command failed (${code})`)))
    })
  })
}

async function waitForHealth(client, command, attempts = 20) {
  let lastError
  for (let attempt = 0; attempt < attempts; attempt++) {
    try {
      return await exec(client, command)
    } catch (error) {
      lastError = error
      if (attempt < attempts - 1) await new Promise((resolve) => setTimeout(resolve, 1_000))
    }
  }
  throw lastError
}

function sftpFor(client) {
  return new Promise((resolve, reject) => client.sftp((error, sftp) => error ? reject(error) : resolve(sftp)))
}

function upload(sftp, local, remote) {
  return new Promise((resolve, reject) => sftp.fastPut(local, remote, (error) => error ? reject(error) : resolve()))
}

async function collect(directory) {
  const files = []
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const full = join(directory, entry.name)
    if (entry.isDirectory()) files.push(...await collect(full))
    else if (entry.isFile()) files.push(full)
  }
  return files
}

function sha256(file) {
  return new Promise((resolve, reject) => {
    const hash = createHash('sha256')
    const stream = createReadStream(file)
    stream.on('data', (chunk) => hash.update(chunk))
    stream.on('error', reject)
    stream.on('end', () => resolve(hash.digest('hex')))
  })
}

function base64(value) {
  return Buffer.from(value).toString('base64')
}

const apkInfo = await stat(apkPath)
if (!apkInfo.isFile() || apkInfo.size <= 0) throw new Error('signed APK is missing')
const apkName = `fund-app-${version}-${versionCode}.apk`
const manifest = {
  version,
  versionCode,
  minimumVersion: '1.0.71',
  forceUpdate: false,
  title: '京东网格持仓导入修复',
  releaseNotes: [
    '京东近30天没有买卖流水时，会以当前仍持有基金的份额和成本净值建立网格基准批次',
    '仅导入京东当前仍持有基金的流水，避免已清仓基金重新出现',
    '京东流水去重后原子写入网格批次，重复同步不会重复生成记录'
  ],
  apkFileName: apkName,
  sha256: await sha256(apkPath),
  sizeBytes: apkInfo.size,
  publishedAt: new Date().toISOString()
}
manifest.title = '京东本轮建仓交易导入与确认规则'
manifest.releaseNotes = [
  '只导入当前持仓基金最近一次清仓后的真实买入、卖出和转换记录',
  '交易列表持续分页读取；中间页面没有可识别记录也不会停止',
  '调仓标签按京东确认窗口自动消失：15点前次日12点、15点后次日15点；后者收益从再下一交易日计算'
]

manifest.title = '京东交易金额时间确认净值导入'
manifest.releaseNotes = [
  '修复网格历史净值遇到上游空数据时返回空曲线的问题，自动回退到持仓净值服务',
  '历史净值按 500 条分页补全，旧买入记录可从公开完整净值序列取得确认日净值并推算份额',
  '完整导入京东交易记录页的买入、卖出和转换，后端继续核对当前持仓与完整时间线'
]

const privateKey = privateKeyPath ? await readFile(privateKeyPath) : null
const client = await connect(privateKey)
try {
  const sftp = await sftpFor(client)
  const gridFiles = ['app.py', 'positions.py', 'valuation/providers.py']
  const gridBackup = `${gridRemote}/.jd-import-backup-${releaseStamp}`
  const proxyFiles = ['server.mjs', 'fund-data-service.mjs']
  const proxyBackup = `${proxyRoot}/.history-nav-backup-${releaseStamp}`
  await exec(client, `install -d -m 0755 ${gridBackup}`)
  for (const file of gridFiles) {
    const backupFile = `${gridBackup}/${file}`
    await exec(client, `install -d -m 0755 $(dirname ${backupFile})`)
    await exec(client, `cp -p ${gridRemote}/${file} ${backupFile}`)
    await upload(sftp, join(gridRoot, file), `${gridRemote}/${file}.uploading`)
    await exec(client, `mv ${gridRemote}/${file}.uploading ${gridRemote}/${file}`)
  }
  try {
    await exec(client, `cd ${gridRemote} && .venv/bin/python -m py_compile app.py positions.py valuation/providers.py && .venv/bin/python -c "import app" && systemctl restart valuation-grid`)
    await waitForHealth(client, 'curl --fail --silent --show-error http://127.0.0.1:8000/v1/health >/dev/null')
  } catch (error) {
    for (const file of gridFiles) await exec(client, `cp -p ${gridBackup}/${file} ${gridRemote}/${file}`)
    await exec(client, 'systemctl restart valuation-grid').catch(() => {})
    throw error
  }

  await exec(client, `install -d -m 0755 ${proxyBackup}`)
  for (const file of proxyFiles) {
    await exec(client, `cp -p ${proxyRoot}/${file} ${proxyBackup}/${file}`)
    await upload(sftp, join(root, 'server', file), `${proxyRoot}/${file}.uploading`)
    await exec(client, `mv ${proxyRoot}/${file}.uploading ${proxyRoot}/${file}`)
  }
  try {
    await exec(client, `cd ${proxyRoot} && node --check server.mjs && node --check fund-data-service.mjs && systemctl restart fund-proxy`)
    await waitForHealth(client, 'curl --fail --silent --show-error http://127.0.0.1:3000/api/health >/dev/null')
  } catch (error) {
    for (const file of proxyFiles) await exec(client, `cp -p ${proxyBackup}/${file} ${proxyRoot}/${file}`)
    await exec(client, 'systemctl restart fund-proxy').catch(() => {})
    throw error
  }

  await exec(client, `rm -rf ${webNext}; install -d -m 0755 ${webNext}`)
  const webFiles = await collect(join(root, 'dist'))
  const webDirs = [...new Set(webFiles.map((file) => dirname(relative(join(root, 'dist'), file))))]
    .filter((path) => path !== '.')
    .map((path) => posix.join(webNext, path.replaceAll('\\', '/')))
  if (webDirs.length) await exec(client, `mkdir -p ${webDirs.join(' ')}`)
  for (const file of webFiles) await upload(sftp, file, posix.join(webNext, relative(join(root, 'dist'), file).replaceAll('\\', '/')))
  await exec(client, `test -s ${webNext}/index.html`)

  const remoteApk = `${downloadRoot}/${apkName}`
  await upload(sftp, apkPath, `${remoteApk}.uploading`)
  await exec(client, `cp -p ${proxyRoot}/data/app-version.json ${proxyRoot}/data/app-version.json.previous-${releaseStamp} && mv ${remoteApk}.uploading ${remoteApk} && ln -sfn ${apkName} ${downloadRoot}/fund-app-latest.apk && printf %s ${base64(JSON.stringify(manifest))} | base64 -d > ${proxyRoot}/data/app-version.json && chown -R fundproxy:fundproxy ${webNext} ${downloadRoot} ${proxyRoot}/data && chmod -R a+rX ${downloadRoot}`)
  await exec(client, `if [ -d ${webRoot} ]; then mv ${webRoot} ${webPrevious}; fi; mv ${webNext} ${webRoot}`)
  await exec(client, `curl --fail --silent --show-error http://127.0.0.1:8000/v1/health >/dev/null && curl --fail --silent --show-error http://127.0.0.1/api/app/version >/dev/null && curl --fail --silent --show-error --head http://127.0.0.1/downloads/fund-app-latest.apk >/dev/null`)
  console.log(JSON.stringify({ success: true, version, versionCode, apkName, sha256: manifest.sha256, sizeBytes: manifest.sizeBytes, webPrevious, gridBackup, proxyBackup }))
} finally {
  client.end()
}
