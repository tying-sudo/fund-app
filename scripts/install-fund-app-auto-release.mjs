import { createRequire } from 'node:module'
import { readFileSync } from 'node:fs'
import { readFile, readdir } from 'node:fs/promises'
import { basename, dirname, join, posix, relative } from 'node:path'

const require = createRequire(import.meta.url)
const { Client } = require('C:\\tmp\\codex-ssh-deploy\\node_modules\\ssh2')

const host = process.env.DEPLOY_SSH_HOST
const privateKeyPath = process.env.DEPLOY_SSH_PRIVATE_KEY
const sourceRoot = process.cwd()
const debugKeystorePath = process.env.ANDROID_DEBUG_KEYSTORE_PATH
  || join(process.env.USERPROFILE || '', '.android', 'debug.keystore')
const builderRoot = '/opt/fund-app-builder'
const builderNext = `${builderRoot}.next`
const signingRoot = '/etc/fund-app-builder'
const skipBuildCheck = process.env.SKIP_AUTO_RELEASE_BUILD_CHECK === 'true'

if (!host || !privateKeyPath) {
  throw new Error('DEPLOY_SSH_HOST and DEPLOY_SSH_PRIVATE_KEY are required')
}

function connect() {
  return new Promise((resolve, reject) => {
    const client = new Client()
    client.on('ready', () => resolve(client)).on('error', reject).connect({
      host,
      username: 'root',
      privateKey: readFileSync(privateKeyPath),
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

function getSftp(client) {
  return new Promise((resolve, reject) => client.sftp((error, sftp) => error ? reject(error) : resolve(sftp)))
}

function upload(sftp, localPath, remotePath) {
  return new Promise((resolve, reject) => sftp.fastPut(localPath, remotePath, (error) => error ? reject(error) : resolve()))
}

const excludedDirectories = new Set(['.git', '.gradle', '.idea', 'build', 'dist', 'node_modules'])
const excludedFiles = new Set(['local.properties', 'google-services.json'])

async function collectDirectory(directory) {
  const files = []
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (excludedDirectories.has(entry.name) || excludedFiles.has(entry.name)) continue
    const fullPath = join(directory, entry.name)
    if (entry.isDirectory()) files.push(...await collectDirectory(fullPath))
    else if (entry.isFile()) files.push(fullPath)
  }
  return files
}

async function collectBuilderFiles() {
  const rootFiles = [
    'capacitor.config.ts',
    'components.d.ts',
    'index.html',
    'package-lock.json',
    'package.json',
    'tsconfig.app.json',
    'tsconfig.json',
    'tsconfig.node.json',
    'vite.config.ts'
  ]
  const files = []
  for (const name of rootFiles) {
    await readFile(join(sourceRoot, name))
    files.push(join(sourceRoot, name))
  }
  for (const name of ['android', 'public', 'src']) {
    files.push(...await collectDirectory(join(sourceRoot, name)))
  }
  return files
}

const helperScript = await readFile(join(sourceRoot, 'scripts', 'remote', 'fund-app-auto-release-helper.mjs'), 'utf8')
const autoReleaseScript = await readFile(join(sourceRoot, 'scripts', 'remote', 'fund-app-auto-release.sh'), 'utf8')
const provisionScript = await readFile(join(sourceRoot, 'scripts', 'remote', 'provision-fund-app-builder.sh'), 'utf8')

const base64 = (value) => Buffer.from(value).toString('base64')
const client = await connect()

try {
  await exec(client, `printf %s ${base64(provisionScript)} | base64 -d | bash`)
  await exec(client, `rm -rf ${builderNext}; install -d -m 0755 ${builderNext} ${signingRoot} /var/lib/fund-app-auto-release/android-home`)
  const sftp = await getSftp(client)
  const files = await collectBuilderFiles()
  const directories = [...new Set(files.map((file) => dirname(relative(sourceRoot, file))))]
    .filter((directory) => directory !== '.')
    .map((directory) => posix.join(builderNext, directory.replaceAll('\\', '/')))
  if (directories.length) await exec(client, `mkdir -p ${directories.join(' ')}`)
  for (const file of files) {
    await upload(sftp, file, posix.join(builderNext, relative(sourceRoot, file).replaceAll('\\', '/')))
  }
  await upload(sftp, debugKeystorePath, `${signingRoot}/debug.keystore.uploading`)
  await exec(client, `test -s ${builderNext}/package.json; test -s ${builderNext}/android/gradlew; chmod 0755 ${builderNext}/android/gradlew; rm -rf ${builderRoot}.previous; if [ -d ${builderRoot} ]; then mv ${builderRoot} ${builderRoot}.previous; fi; mv ${builderNext} ${builderRoot}`)
  await exec(client, `install -o root -g root -m 0600 ${signingRoot}/debug.keystore.uploading ${signingRoot}/debug.keystore; rm -f ${signingRoot}/debug.keystore.uploading; install -o root -g root -m 0600 ${signingRoot}/debug.keystore /var/lib/fund-app-auto-release/android-home/debug.keystore`)
  await exec(client, `printf %s ${base64(helperScript)} | base64 -d > /usr/local/lib/fund-app-auto-release.mjs; chmod 0644 /usr/local/lib/fund-app-auto-release.mjs`)
  await exec(client, `printf %s ${base64(autoReleaseScript)} | base64 -d > /usr/local/sbin/fund-app-auto-release; bash -n /usr/local/sbin/fund-app-auto-release; chmod 0750 /usr/local/sbin/fund-app-auto-release`)
  if (!skipBuildCheck) {
    const check = await exec(client, '/usr/local/sbin/fund-app-auto-release --check-only')
    console.log(check.trim())
  }
  console.log(`Builder source installed from ${basename(sourceRoot)} with ${files.length} files.`)
} finally {
  client.end()
}
