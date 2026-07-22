import { createRequire } from 'node:module'
import { createReadStream } from 'node:fs'
import { createHash } from 'node:crypto'
import { readFile, readdir, stat } from 'node:fs/promises'
import { dirname, extname, join, posix, relative } from 'node:path'

const require = createRequire(import.meta.url)
const { Client } = require('C:\\tmp\\codex-ssh-deploy\\node_modules\\ssh2')

const host = process.env.DEPLOY_SSH_HOST
const password = process.env.DEPLOY_SSH_PASSWORD
const privateKeyPath = process.env.DEPLOY_SSH_PRIVATE_KEY
const sourceRoot = process.cwd()
const webRoot = '/opt/fund-app'
const proxyRoot = '/opt/fund-proxy'
const downloadRoot = '/opt/fund-downloads'
const builderRoot = '/opt/fund-app-builder'
const builderNext = `${builderRoot}.next`
const npmRegistry = 'https://registry.npmmirror.com'
const apkPath = process.env.DEPLOY_APK_PATH
const backendOnly = process.env.DEPLOY_BACKEND_ONLY === 'true'

async function readEnvironmentValue(name) {
  for (const file of ['.env.production.local', '.env.local']) {
    const source = await readFile(join(sourceRoot, file), 'utf8').catch(() => '')
    const match = source.match(new RegExp(`^${name}=(.*)$`, 'm'))
    if (match?.[1]) return match[1].trim().replace(/^['"]|['"]$/g, '')
  }
  return ''
}

const supabaseAnonKey = process.env.SUPABASE_ANON_KEY || process.env.VITE_SUPABASE_ANON_KEY || await readEnvironmentValue('VITE_SUPABASE_ANON_KEY')
const zhipuApiKey = process.env.ZHIPU_API_KEY || await readEnvironmentValue('ZHIPU_API_KEY')

if (!host || (!password && !privateKeyPath)) {
  throw new Error('DEPLOY_SSH_HOST and either DEPLOY_SSH_PASSWORD or DEPLOY_SSH_PRIVATE_KEY are required')
}

const privateKey = privateKeyPath ? await readFile(privateKeyPath) : null

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

function getSftp(client) {
  return new Promise((resolve, reject) => client.sftp((error, sftp) => error ? reject(error) : resolve(sftp)))
}

function upload(sftp, localPath, remotePath) {
  return new Promise((resolve, reject) => sftp.fastPut(localPath, remotePath, (error) => error ? reject(error) : resolve()))
}

function sha256(filePath) {
  return new Promise((resolve, reject) => {
    const hash = createHash('sha256')
    const stream = createReadStream(filePath)
    stream.on('data', chunk => hash.update(chunk))
    stream.on('error', reject)
    stream.on('end', () => resolve(hash.digest('hex')))
  })
}

async function prepareApkRelease() {
  if (!apkPath) return null
  if (extname(apkPath).toLowerCase() !== '.apk') throw new Error('DEPLOY_APK_PATH must point to an .apk file')
  const apkStats = await stat(apkPath)
  if (!apkStats.isFile() || apkStats.size === 0) throw new Error('DEPLOY_APK_PATH is not a valid file')
  const packageJson = JSON.parse(await readFile(join(sourceRoot, 'package.json'), 'utf8'))
  const gradle = await readFile(join(sourceRoot, 'android', 'app', 'build.gradle'), 'utf8').catch(() => '')
  const version = process.env.DEPLOY_APP_VERSION || packageJson.version || '1.0.0'
  const versionCode = Number(process.env.DEPLOY_APP_VERSION_CODE || gradle.match(/versionCode\s+(\d+)/)?.[1] || 1)
  const safeVersion = String(version).replace(/[^0-9A-Za-z._-]/g, '-')
  const apkFileName = `fund-app-${safeVersion}-${versionCode}.apk`
  return {
    localPath: apkPath,
    apkFileName,
    sizeBytes: apkStats.size,
    manifest: {
      version: String(version),
      versionCode,
      minimumVersion: process.env.DEPLOY_MINIMUM_VERSION || String(version),
      forceUpdate: process.env.DEPLOY_FORCE_UPDATE === 'true',
      title: process.env.DEPLOY_RELEASE_TITLE || '基金宝更新',
      releaseNotes: String(process.env.DEPLOY_RELEASE_NOTES || '').split(/\r?\n|\|\|/).map(line => line.trim()).filter(Boolean),
      apkFileName,
      sha256: await sha256(apkPath),
      sizeBytes: apkStats.size,
      publishedAt: new Date().toISOString()
    }
  }
}

async function collectFiles(directory, excludedNames = new Set()) {
  const files = []
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (excludedNames.has(entry.name)) continue
    const fullPath = join(directory, entry.name)
    if (entry.isDirectory()) files.push(...await collectFiles(fullPath, excludedNames))
    else if (entry.isFile()) files.push(fullPath)
  }
  return files
}

async function uploadTree(client, sftp, localRoot, remoteRoot, excludedNames) {
  const files = await collectFiles(localRoot, excludedNames)
  const directories = [...new Set(files.map((file) => dirname(relative(localRoot, file))))]
    .filter((directory) => directory !== '.')
    .map((directory) => posix.join(remoteRoot, directory.replaceAll('\\', '/')))
  if (directories.length) await exec(client, `mkdir -p ${directories.join(' ')}`)

  for (const file of files) {
    await upload(sftp, file, posix.join(remoteRoot, relative(localRoot, file).replaceAll('\\', '/')))
  }
}

async function syncApkBuilderSource(client, sftp) {
  const rootFiles = [
    'capacitor.config.ts', 'components.d.ts', 'index.html', 'package-lock.json',
    'package.json', 'tsconfig.app.json', 'tsconfig.json', 'tsconfig.node.json',
    'vite.config.ts'
  ]
  const files = rootFiles.map((name) => join(sourceRoot, name))
  const exclusions = new Set(['.git', '.gradle', '.idea', 'build', 'dist', 'node_modules', 'local.properties', 'google-services.json'])
  for (const directory of ['android', 'public', 'src']) {
    files.push(...await collectFiles(join(sourceRoot, directory), exclusions))
  }

  await exec(client, `rm -rf ${builderNext}; install -d -m 0755 ${builderNext}`)
  const directories = [...new Set(files.map((file) => dirname(relative(sourceRoot, file))))]
    .filter((directory) => directory !== '.')
    .map((directory) => posix.join(builderNext, directory.replaceAll('\\', '/')))
  if (directories.length) await exec(client, `mkdir -p ${directories.join(' ')}`)
  for (const file of files) {
    await upload(sftp, file, posix.join(builderNext, relative(sourceRoot, file).replaceAll('\\', '/')))
  }
  await exec(client, `test -s ${builderNext}/package.json; test -s ${builderNext}/android/gradlew; chmod 0755 ${builderNext}/android/gradlew; rm -rf ${builderRoot}.previous; if [ -d ${builderRoot} ]; then mv ${builderRoot} ${builderRoot}.previous; fi; mv ${builderNext} ${builderRoot}`)
}

async function waitForHealth(client, attempts = 20, intervalMs = 3000) {
  let lastError
  for (let attempt = 0; attempt < attempts; attempt++) {
    try {
      const api = await exec(client, 'curl --fail --silent --show-error http://127.0.0.1/api/health')
      await exec(client, 'curl --fail --silent --show-error http://127.0.0.1/ >/dev/null')
      return api
    } catch (error) {
      lastError = error
      if (attempt < attempts - 1) await new Promise((resolve) => setTimeout(resolve, intervalMs))
    }
  }
  throw lastError
}

async function configureMarketDatabase(client) {
  const script = `set -eu
market_env=/etc/fund-market-db.env
tenant=$(docker inspect supabase-pooler --format '{{range .Config.Env}}{{println .}}{{end}}' | sed -n 's/^POOLER_TENANT_ID=//p')
if test -z "$tenant"; then
  echo 'Supabase pooler tenant is unavailable' >&2
  exit 1
fi

db_password=''
if test -f "$market_env"; then
  set -a
  . "$market_env"
  set +a
  db_password="\${PGPASSWORD:-}"
fi
if test -z "$db_password"; then
  db_password=$(openssl rand -hex 24)
fi

role_exists=$(docker exec supabase-db psql -U postgres -d postgres -Atqc "select 1 from pg_roles where rolname='fund_market_app'")
if test "$role_exists" != '1'; then
  printf "CREATE ROLE fund_market_app LOGIN PASSWORD '%s';\n" "$db_password" | docker exec -i supabase-db psql -v ON_ERROR_STOP=1 -U postgres -d postgres >/dev/null
elif test ! -f "$market_env"; then
  printf "ALTER ROLE fund_market_app PASSWORD '%s';\n" "$db_password" | docker exec -i supabase-db psql -v ON_ERROR_STOP=1 -U postgres -d postgres >/dev/null
fi

umask 077
{
  printf 'PGHOST=127.0.0.1\n'
  printf 'PGPORT=5432\n'
  printf 'PGDATABASE=postgres\n'
  printf 'PGUSER=fund_market_app.%s\n' "$tenant"
  printf 'PGPASSWORD=%s\n' "$db_password"
  printf 'PGPOOL_MAX=5\n'
} > "$market_env"

docker exec -i supabase-db psql -v ON_ERROR_STOP=1 -U postgres -d postgres < /opt/fund-proxy/migrations/001_market_holdings.sql >/dev/null
docker exec -i supabase-db psql -v ON_ERROR_STOP=1 -U postgres -d postgres < /opt/fund-proxy/migrations/002_market_sector_quotes.sql >/dev/null
docker exec -i supabase-db psql -v ON_ERROR_STOP=1 -U postgres -d postgres < /opt/fund-proxy/migrations/003_fund_chart_cache.sql >/dev/null
`
  await exec(client, `printf %s ${base64(script)} | base64 -d | bash`)
}

const fundProxyUnit = `[Unit]
Description=Fund App market-data proxy
After=network-online.target
Wants=network-online.target

[Service]
User=fundproxy
Group=fundproxy
WorkingDirectory=/opt/fund-proxy
Environment=NODE_ENV=production
Environment=PORT=3000
Environment=APP_DOWNLOAD_DIR=/opt/fund-downloads
EnvironmentFile=-/etc/fund-proxy.env
EnvironmentFile=-/etc/fund-market-db.env
${supabaseAnonKey ? `Environment=SUPABASE_ANON_KEY=${supabaseAnonKey}` : ''}
ExecStart=/usr/bin/node /opt/fund-proxy/server.mjs
Restart=always
RestartSec=3

[Install]
WantedBy=multi-user.target
`

const nginxSite = `server {
    listen 80;
    listen [::]:80;
    server_name tyingfund.com www.tyingfund.com;

    root /opt/fund-app;
    index index.html;

    location = /grid {
        return 301 /grid/;
    }

    location /grid/ {
        proxy_pass http://127.0.0.1:8000/;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }

    location /v1/ {
        proxy_pass http://127.0.0.1:8000;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }

    location = /health {
        proxy_pass http://127.0.0.1:8000;
    }

    # Keep the versioned health contract used by existing clients while the
    # upstream service continues to expose its canonical endpoint at /health.
    location = /v1/health {
        proxy_pass http://127.0.0.1:8000/health;
    }

    location /api/ {
        proxy_pass http://127.0.0.1:3000;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }

    location = /supabase {
        return 301 /supabase/;
    }

    # Public Supabase REST/Auth endpoints. APKs carry only the anon key; row
    # level security and RPC grants continue to enforce database access.
    location /supabase/ {
        proxy_pass http://127.0.0.1:18000/;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto https;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection $connection_upgrade;
        proxy_read_timeout 3600s;
        proxy_send_timeout 3600s;
        proxy_buffering off;
    }

    location ~ ^/(tiantian|eastmoney|push2|fundmobapi|np|fundgz|fundf10)/ {
        proxy_pass http://127.0.0.1:3000;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_connect_timeout 10s;
        proxy_read_timeout 30s;
    }

    location /assets/ {
        try_files $uri =404;
        expires 30d;
        add_header Cache-Control "public, immutable";
    }

    location /downloads/ {
        alias /opt/fund-downloads/;
        autoindex off;
        default_type application/vnd.android.package-archive;
        add_header Cache-Control "public, max-age=60, must-revalidate" always;
        add_header X-Content-Type-Options "nosniff" always;
    }

    location / {
        try_files $uri $uri/ /index.html;
    }
}
`

const base64 = (value) => Buffer.from(value).toString('base64')
const apkRelease = await prepareApkRelease()
const client = await connect()
try {
  await exec(client, 'export DEBIAN_FRONTEND=noninteractive; apt-get update; apt-get install -y --no-install-recommends nodejs nginx; command -v npm >/dev/null')
  await exec(client, `id -u fundproxy >/dev/null 2>&1 || useradd --system --home ${proxyRoot} --shell /usr/sbin/nologin fundproxy; install -d -m 0755 -o fundproxy -g fundproxy ${webRoot} ${proxyRoot} ${proxyRoot}/data ${proxyRoot}/logs ${downloadRoot}`)

  const sftp = await getSftp(client)
  const autoReleaseInstalled = (await exec(client, 'if [ -x /usr/local/sbin/fund-app-auto-release ]; then printf 1; else printf 0; fi')).trim() === '1'
  if (autoReleaseInstalled) await syncApkBuilderSource(client, sftp)
  if (!backendOnly) await uploadTree(client, sftp, join(sourceRoot, 'dist'), webRoot, new Set())
  // Runtime cache and release metadata are managed on the host. Uploading the
  // local data directory here would overwrite live snapshots during a web-only
  // deployment.
  await uploadTree(client, sftp, join(sourceRoot, 'server'), proxyRoot, new Set(['node_modules', 'logs', 'data', '.env', '.env.local', '.env.production.local']))
  // This is a curated fallback, not a runtime snapshot. Keep the default index
  // watchlist available when an upstream quote provider is temporarily down.
  await upload(sftp, join(sourceRoot, 'server', 'data', 'market-indices.json'), posix.join(proxyRoot, 'data', 'market-indices.json'))
  await configureMarketDatabase(client)
  if (zhipuApiKey) {
    await exec(client, `printf %s ${base64(`ZHIPU_API_KEY=${zhipuApiKey}\n`)} | base64 -d > /etc/fund-proxy.env; chmod 600 /etc/fund-proxy.env`)
  }

  if (apkRelease) {
    const remoteApk = posix.join(downloadRoot, apkRelease.apkFileName)
    const remoteTemp = `${remoteApk}.uploading`
    await upload(sftp, apkRelease.localPath, remoteTemp)
    await exec(client, `mv ${remoteTemp} ${remoteApk}; ln -sfn ${apkRelease.apkFileName} ${downloadRoot}/fund-app-latest.apk; printf %s ${base64(JSON.stringify(apkRelease.manifest))} | base64 -d > ${proxyRoot}/data/app-version.json`)
  }

  await exec(client, `chown -R fundproxy:fundproxy ${webRoot} ${proxyRoot} ${downloadRoot} && chmod -R a+rX ${downloadRoot} && cd ${proxyRoot} && npm ci --omit=dev --no-audit --no-fund --registry=${npmRegistry}`)
  await exec(client, `printf %s ${base64(fundProxyUnit)} | base64 -d > /etc/systemd/system/fund-proxy.service; printf %s ${base64(nginxSite)} | base64 -d > /etc/nginx/sites-available/fund-app; ln -sf /etc/nginx/sites-available/fund-app /etc/nginx/sites-enabled/fund-app; systemctl daemon-reload; systemctl enable fund-proxy; systemctl restart fund-proxy; nginx -t; systemctl enable --now nginx; systemctl reload nginx`)

  const health = (await waitForHealth(client)).trim()
  if (apkRelease) {
    const version = (await exec(client, 'curl --fail --silent --show-error http://127.0.0.1/api/app/version')).trim()
    await exec(client, 'curl --fail --silent --show-error --head http://127.0.0.1/downloads/fund-app-latest.apk >/dev/null')
    console.log(`APK published: ${version}`)
  }
  console.log(`Deployment complete: ${health}`)
} finally {
  client.end()
}
