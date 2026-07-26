import { createRequire } from 'node:module'
import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { readFile, stat } from 'node:fs/promises'
import { extname } from 'node:path'

const require = createRequire(import.meta.url)
const { Client } = require('C:\\tmp\\codex-ssh-deploy\\node_modules\\ssh2')

const host = process.env.DEPLOY_SSH_HOST
const password = process.env.DEPLOY_SSH_PASSWORD
const privateKeyPath = process.env.DEPLOY_SSH_PRIVATE_KEY
const apkPath = process.env.DEPLOY_APK_PATH
const version = process.env.DEPLOY_APP_VERSION
const versionCode = Number(process.env.DEPLOY_APP_VERSION_CODE)
const minimumVersion = process.env.DEPLOY_MINIMUM_VERSION || version
const title = process.env.DEPLOY_RELEASE_TITLE || 'Fund App update'
const releaseNotes = String(process.env.DEPLOY_RELEASE_NOTES || '')
  .split(/\r?\n|\|\|/)
  .map((line) => line.trim())
  .filter(Boolean)

if (!host || (!password && !privateKeyPath)) {
  throw new Error('DEPLOY_SSH_HOST and either DEPLOY_SSH_PASSWORD or DEPLOY_SSH_PRIVATE_KEY are required')
}
if (!apkPath || extname(apkPath).toLowerCase() !== '.apk') {
  throw new Error('DEPLOY_APK_PATH must point to an APK')
}
if (!version || !Number.isInteger(versionCode) || versionCode < 1) {
  throw new Error('DEPLOY_APP_VERSION and positive DEPLOY_APP_VERSION_CODE are required')
}

const apkStats = await stat(apkPath)
if (!apkStats.isFile() || apkStats.size === 0) throw new Error('DEPLOY_APK_PATH is not a valid file')
const privateKey = privateKeyPath ? await readFile(privateKeyPath) : null
const safeVersion = version.replace(/[^0-9A-Za-z._-]/g, '-')
const apkFileName = `fund-app-${safeVersion}-${versionCode}.apk`
const manifest = {
  version,
  versionCode,
  minimumVersion,
  forceUpdate: process.env.DEPLOY_FORCE_UPDATE === 'true',
  title,
  releaseNotes,
  apkFileName,
  sha256: await sha256(apkPath),
  sizeBytes: apkStats.size,
  publishedAt: new Date().toISOString()
}

function sha256(filePath) {
  return new Promise((resolve, reject) => {
    const hash = createHash('sha256')
    const stream = createReadStream(filePath)
    stream.on('data', (chunk) => hash.update(chunk))
    stream.on('error', reject)
    stream.on('end', () => resolve(hash.digest('hex')))
  })
}

function connect() {
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
      stream.on('close', (code) => code === 0 ? resolve(output) : reject(new Error(output || `Remote command failed (${code})`)))
    })
  })
}

function sftpFor(client) {
  return new Promise((resolve, reject) => client.sftp((error, sftp) => error ? reject(error) : resolve(sftp)))
}

function upload(sftp, localPath, remotePath) {
  return new Promise((resolve, reject) => sftp.fastPut(localPath, remotePath, (error) => error ? reject(error) : resolve()))
}

const downloadRoot = '/opt/fund-downloads'
const manifestPath = '/opt/fund-proxy/data/app-version.json'
const releaseStamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\..+$/, '')
const remoteApk = `${downloadRoot}/${apkFileName}`
const remoteTemp = `${remoteApk}.uploading`
const encodedManifest = Buffer.from(JSON.stringify(manifest)).toString('base64')
const client = await connect()

try {
  const sftp = await sftpFor(client)
  await exec(client, `install -d -m 0755 ${downloadRoot} /opt/fund-proxy/data; test -d /opt/fund-proxy`)
  await upload(sftp, apkPath, remoteTemp)
  await exec(client, `test -s ${remoteTemp}; cp -p ${manifestPath} ${manifestPath}.previous-${releaseStamp}; mv ${remoteTemp} ${remoteApk}; ln -sfn ${apkFileName} ${downloadRoot}/fund-app-latest.apk; printf %s ${encodedManifest} | base64 -d > ${manifestPath}; chown fundproxy:fundproxy ${remoteApk} ${manifestPath}; chmod a+r ${remoteApk} ${manifestPath}; curl --fail --silent --show-error http://127.0.0.1/api/app/version; curl --fail --silent --show-error --head http://127.0.0.1/downloads/fund-app-latest.apk >/dev/null`)
  console.log(JSON.stringify({ published: true, ...manifest, rollbackManifest: `${manifestPath}.previous-${releaseStamp}` }))
} finally {
  client.end()
}
