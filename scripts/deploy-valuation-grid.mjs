import { createRequire } from 'node:module'
import { createHash } from 'node:crypto'
import { readFile, readdir } from 'node:fs/promises'
import { join, relative, dirname, posix } from 'node:path'

const require = createRequire(import.meta.url)
const { Client } = require('C:\\tmp\\codex-ssh-deploy\\node_modules\\ssh2')

const host = process.env.DEPLOY_SSH_HOST
const password = process.env.DEPLOY_SSH_PASSWORD
const privateKeyPath = process.env.DEPLOY_SSH_PRIVATE_KEY
const sourceRoot = process.env.DEPLOY_SOURCE_ROOT || join(process.cwd(), 'vendor', 'valuation_grid')
const remoteRoot = '/opt/valuation-grid'
const remoteVenv = `${remoteRoot}/.venv`
const remoteVenvNext = `${remoteRoot}/.venv-next`
const remoteVenvPrevious = `${remoteRoot}/.venv-previous`
// The Debian host is on a domestic network path. Keep package resolution on
// domestic mirrors rather than allowing an environment override to fall back
// to PyPI or Debian's public overseas mirrors.
const pipIndexUrl = 'https://mirrors.aliyun.com/pypi/simple/'
const aptMirrorScript = `set -eu
find /etc/apt -maxdepth 2 -type f \\( -name 'sources.list' -o -name '*.list' -o -name '*.sources' \\) -print0 | xargs -0r sed -i \\
  -e 's#https\\?://deb\\.debian\\.org/debian-security#http://mirrors.aliyun.com/debian-security#g' \\
  -e 's#https\\?://security\\.debian\\.org/debian-security#http://mirrors.aliyun.com/debian-security#g' \\
  -e 's#https\\?://mirrors\\.tuna\\.tsinghua\\.edu\\.cn/debian-security#http://mirrors.aliyun.com/debian-security#g' \\
  -e 's#https\\?://deb\\.debian\\.org/debian#http://mirrors.aliyun.com/debian#g' \\
  -e 's#https\\?://mirrors\\.tuna\\.tsinghua\\.edu\\.cn/debian#http://mirrors.aliyun.com/debian#g'
printf '%s\\n' 'Acquire::Retries "2";' 'Acquire::http::Timeout "20";' 'Acquire::https::Timeout "20";' > /etc/apt/apt.conf.d/99-fund-app-network
export DEBIAN_FRONTEND=noninteractive
apt-get update
apt-get install -y --no-install-recommends python3-venv nginx ca-certificates`

if (!host || (!password && !privateKeyPath)) {
  throw new Error('DEPLOY_SSH_HOST and either DEPLOY_SSH_PRIVATE_KEY or DEPLOY_SSH_PASSWORD are required')
}

async function connect() {
  const privateKey = privateKeyPath ? await readFile(privateKeyPath) : undefined
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

function getSftp(client) {
  return new Promise((resolve, reject) => client.sftp((error, sftp) => error ? reject(error) : resolve(sftp)))
}

async function waitForHealth(client, attempts = 20, intervalMs = 3000) {
  let lastError
  for (let attempt = 0; attempt < attempts; attempt++) {
    try {
      return await exec(client, 'curl --fail --silent --show-error http://127.0.0.1:8000/health')
    } catch (error) {
      lastError = error
      if (attempt < attempts - 1) await new Promise((resolve) => setTimeout(resolve, intervalMs))
    }
  }
  throw lastError
}

function upload(sftp, localPath, remotePath) {
  return new Promise((resolve, reject) => sftp.fastPut(localPath, remotePath, (error) => error ? reject(error) : resolve()))
}

async function collectFiles(directory) {
  const files = []
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (['.git', '__pycache__', 'data', 'cache'].includes(entry.name)) continue
    const fullPath = join(directory, entry.name)
    if (entry.isDirectory()) files.push(...await collectFiles(fullPath))
    else if (entry.isFile()) files.push(fullPath)
  }
  return files
}

async function verifyRemoteSource(client, sourceRoot) {
  const criticalFiles = ['app.py', 'valuation/core.py', 'grid/engine.py', 'grid/helpers.py']
  for (const relativePath of criticalFiles) {
    const localHash = createHash('sha256').update(await readFile(join(sourceRoot, relativePath))).digest('hex')
    const remoteHash = (await exec(client, `sha256sum ${posix.join(remoteRoot, relativePath)} | awk '{print $1}'`)).trim()
    if (remoteHash !== localHash) {
      throw new Error(`Remote source verification failed for ${relativePath}`)
    }
  }
}

const serviceUnit = `[Unit]
Description=Valuation Grid API
After=network.target

[Service]
User=valuationgrid
Group=valuationgrid
WorkingDirectory=/opt/valuation-grid
Environment=PYTHONUNBUFFERED=1
ExecStart=/opt/valuation-grid/.venv/bin/python -m uvicorn app:app --host 127.0.0.1 --port 8000
Restart=always
RestartSec=3

[Install]
WantedBy=multi-user.target
`

const nginxSite = `server {
    listen 8080;
    server_name _;

    location / {
        allow 10.0.10.0/24;
        allow 127.0.0.1;
        deny all;

        proxy_pass http://127.0.0.1:8000;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
}
`

const base64 = (value) => Buffer.from(value).toString('base64')

const client = await connect()
try {
  await exec(client, `printf %s ${base64(aptMirrorScript)} | base64 -d | bash`)
  await exec(client, `id -u valuationgrid >/dev/null 2>&1 || useradd --system --home ${remoteRoot} --shell /usr/sbin/nologin valuationgrid; install -d -o valuationgrid -g valuationgrid ${remoteRoot} ${remoteRoot}/data ${remoteRoot}/cache`)

  const files = await collectFiles(sourceRoot)
  const directories = [...new Set(files.map((file) => dirname(relative(sourceRoot, file))))]
    .filter((directory) => directory !== '.')
    .map((directory) => posix.join(remoteRoot, directory.replaceAll('\\', '/')))
  if (directories.length > 0) await exec(client, `mkdir -p ${directories.join(' ')}`)

  const sftp = await getSftp(client)
  for (const file of files) {
    const remotePath = posix.join(remoteRoot, relative(sourceRoot, file).replaceAll('\\', '/'))
    await upload(sftp, file, remotePath)
  }
  await verifyRemoteSource(client, sourceRoot)

  // Build and validate dependencies away from the live environment. The
  // service keeps running from the current process until the validated venv
  // is moved into place and systemd restarts it.
  await exec(client, `rm -rf ${remoteVenvNext} && python3 -m venv ${remoteVenvNext} && ${remoteVenvNext}/bin/python -m pip install --disable-pip-version-check --no-input --retries 2 --timeout 20 --index-url ${pipIndexUrl} fastapi uvicorn pydantic requests pillow akshare && cd ${remoteRoot} && ${remoteVenvNext}/bin/python -c "import fastapi, uvicorn, pydantic, requests, PIL, akshare; import app" && ${remoteVenvNext}/bin/python -m compileall -q app.py valuation grid`)
  await exec(client, `rm -rf ${remoteVenvPrevious}; if [ -x ${remoteVenv}/bin/python ] && cd ${remoteRoot} && ${remoteVenv}/bin/python -c "import fastapi, uvicorn, app" >/dev/null 2>&1; then mv ${remoteVenv} ${remoteVenvPrevious}; else rm -rf ${remoteVenv}; fi; mv ${remoteVenvNext} ${remoteVenv}; chown -R valuationgrid:valuationgrid ${remoteRoot}; cd ${remoteRoot}; ${remoteVenv}/bin/python -c "import fastapi, uvicorn, pydantic, requests, PIL, akshare; import app"`)
  await exec(client, `printf %s ${base64(serviceUnit)} | base64 -d > /etc/systemd/system/valuation-grid.service; printf %s ${base64(nginxSite)} | base64 -d > /etc/nginx/sites-available/valuation-grid; ln -sf /etc/nginx/sites-available/valuation-grid /etc/nginx/sites-enabled/valuation-grid; rm -f /etc/nginx/sites-enabled/default; systemctl daemon-reload; systemctl enable valuation-grid; systemctl restart valuation-grid; nginx -t; systemctl enable --now nginx; systemctl restart nginx`)
  try {
    const health = await waitForHealth(client)
    await exec(client, `rm -rf ${remoteVenvPrevious}`)
    console.log(`Deployment complete: ${health.trim()}`)
  } catch (error) {
    const diagnostics = await exec(client, 'systemctl status valuation-grid --no-pager -l || true; journalctl -u valuation-grid -n 60 --no-pager || true')
    await exec(client, `if [ -d ${remoteVenvPrevious} ]; then rm -rf ${remoteVenv}; mv ${remoteVenvPrevious} ${remoteVenv}; systemctl restart valuation-grid; fi`).catch(() => {})
    throw new Error(`${error.message}\n${diagnostics}`)
  }
} finally {
  client.end()
}
