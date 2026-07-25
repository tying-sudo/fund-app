import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { readFile, readdir, stat } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { dirname, join, posix, relative } from 'node:path'

const require = createRequire(import.meta.url)
const { Client } = require('C:\\tmp\\codex-ssh-deploy\\node_modules\\ssh2')
const root = process.cwd()
const packageJson = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'))
const version = packageJson.version
const versionCode = Number((await readFile(join(root, 'android', 'app', 'build.gradle'), 'utf8')).match(/versionCode\s+(\d+)/)?.[1])
const apkPath = join(root, 'android', 'app', 'build', 'outputs', 'apk', 'debug', 'app-debug.apk')
const releaseStamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\..+$/, '')
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
if (!host || !privateKeyPath) throw new Error('DEPLOY_SSH_HOST and DEPLOY_SSH_PRIVATE_KEY are required')

function connect(privateKey) {
  return new Promise((resolve, reject) => {
    const client = new Client()
    client.on('ready', () => resolve(client)).on('error', reject).connect({ host, username: 'root', privateKey, readyTimeout: 20_000 })
  })
}

function exec(client, command) {
  return new Promise((resolve, reject) => {
    client.exec(command, (error, stream) => {
      if (error) return reject(error)
      let output = ''
      stream.on('data', data => { output += data })
      stream.stderr.on('data', data => { output += data })
      stream.on('close', code => code === 0 ? resolve(output) : reject(new Error(output || `remote command failed (${code})`)))
    })
  })
}

function sftpFor(client) { return new Promise((resolve, reject) => client.sftp((error, sftp) => error ? reject(error) : resolve(sftp))) }
function upload(sftp, local, remote) { return new Promise((resolve, reject) => sftp.fastPut(local, remote, error => error ? reject(error) : resolve())) }
function sha256(file) {
  return new Promise((resolve, reject) => {
    const hash = createHash('sha256')
    const stream = createReadStream(file)
    stream.on('data', chunk => hash.update(chunk)).on('error', reject).on('end', () => resolve(hash.digest('hex')))
  })
}
async function collect(directory) {
  const files = []
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const file = join(directory, entry.name)
    if (entry.isDirectory()) files.push(...await collect(file))
    else if (entry.isFile()) files.push(file)
  }
  return files
}
async function waitFor(client, command, attempts = 20) {
  let error
  for (let index = 0; index < attempts; index++) {
    try { return await exec(client, command) } catch (caught) { error = caught; await new Promise(resolve => setTimeout(resolve, 1_000)) }
  }
  throw error
}

const apkInfo = await stat(apkPath)
if (!versionCode || !apkInfo.isFile() || apkInfo.size <= 0) throw new Error('A signed APK and valid versionCode are required')
const apkName = `fund-app-${version}-${versionCode}.apk`
const manifest = {
  version,
  versionCode,
  minimumVersion: '1.0.71',
  forceUpdate: false,
  title: '三源估值切换',
  releaseNotes: [
    '自选基金的估值位置支持紧凑入口和三源切换弹窗',
    '天天基金、新浪财经和东方财富数据统一展示时间与可用状态',
    '最新已公布净值与盘中估值分开标识，避免将净值误作实时估值'
  ],
  apkFileName: apkName,
  sha256: await sha256(apkPath),
  sizeBytes: apkInfo.size,
  publishedAt: new Date().toISOString()
}

const privateKey = await readFile(privateKeyPath)
const client = await connect(privateKey)
try {
  const sftp = await sftpFor(client)
  const backendFiles = ['fund-data-service.mjs', 'valuation_source_scraper.py']
  const backendBackup = `${proxyRoot}/.valuation-source-backup-${releaseStamp}`
  await exec(client, `install -d -m 0755 ${backendBackup}`)
  for (const file of backendFiles) {
    const remote = `${proxyRoot}/${file}`
    await exec(client, `test ! -e ${remote} || cp -p ${remote} ${backendBackup}/${file}`)
    await upload(sftp, join(root, 'server', file), `${remote}.uploading`)
    await exec(client, `mv ${remote}.uploading ${remote}`)
  }
  try {
    await exec(client, `cd ${proxyRoot} && node --check fund-data-service.mjs && python3 -m py_compile valuation_source_scraper.py && systemctl restart fund-proxy`)
    await waitFor(client, "curl --fail --silent --show-error 'http://127.0.0.1/api/fund-estimate-sources?code=000001' >/dev/null")
  } catch (error) {
    for (const file of backendFiles) await exec(client, `test ! -e ${backendBackup}/${file} || cp -p ${backendBackup}/${file} ${proxyRoot}/${file}`)
    await exec(client, 'systemctl restart fund-proxy').catch(() => {})
    throw error
  }

  await exec(client, `rm -rf ${webNext}; install -d -m 0755 ${webNext}`)
  const distRoot = join(root, 'dist')
  const webFiles = await collect(distRoot)
  const directories = [...new Set(webFiles.map(file => dirname(relative(distRoot, file))))]
    .filter(directory => directory !== '.')
    .map(directory => posix.join(webNext, directory.replaceAll('\\', '/')))
  if (directories.length) await exec(client, `mkdir -p ${directories.join(' ')}`)
  for (const file of webFiles) await upload(sftp, file, posix.join(webNext, relative(distRoot, file).replaceAll('\\', '/')))
  await exec(client, `test -s ${webNext}/index.html`)

  const remoteApk = `${downloadRoot}/${apkName}`
  await upload(sftp, apkPath, `${remoteApk}.uploading`)
  await exec(client, `cp -p ${proxyRoot}/data/app-version.json ${proxyRoot}/data/app-version.json.previous-${releaseStamp} && mv ${remoteApk}.uploading ${remoteApk} && ln -sfn ${apkName} ${downloadRoot}/fund-app-latest.apk && printf %s ${Buffer.from(JSON.stringify(manifest)).toString('base64')} | base64 -d > ${proxyRoot}/data/app-version.json && chown -R fundproxy:fundproxy ${webNext} ${downloadRoot} ${proxyRoot}/data && chmod -R a+rX ${downloadRoot}`)
  await exec(client, `if [ -d ${webRoot} ]; then mv ${webRoot} ${webPrevious}; fi; mv ${webNext} ${webRoot}`)
  await exec(client, "curl --fail --silent --show-error http://127.0.0.1/api/health >/dev/null && curl --fail --silent --show-error http://127.0.0.1/api/app/version >/dev/null")
  console.log(JSON.stringify({ success: true, version, versionCode, apkName, sha256: manifest.sha256, sizeBytes: manifest.sizeBytes, webPrevious, backendBackup }))
} finally {
  client.end()
}
