#!/usr/bin/env bash
set -eu -o pipefail

readonly BUILDER_ROOT=/opt/fund-app-builder
readonly WORK_ROOT=/var/lib/fund-app-auto-release
readonly WORK_TREE="${WORK_ROOT}/work"
readonly BUILD_STATE="${WORK_ROOT}/build.json"
readonly PUBLIC_MANIFEST=/opt/fund-proxy/data/app-version.json
readonly DOWNLOAD_ROOT=/opt/fund-downloads
readonly TOOLS_ROOT=/opt/fund-app-build-tools
readonly JAVA_HOME="${TOOLS_ROOT}/jdk-21"
readonly ANDROID_HOME="${TOOLS_ROOT}/android-sdk"
readonly ANDROID_SDK_ROOT="${ANDROID_HOME}"
readonly ANDROID_USER_HOME="${WORK_ROOT}/android-home"
readonly GRADLE_USER_HOME=/var/cache/fund-app-gradle
readonly NPM_CONFIG_CACHE=/var/cache/fund-app-npm
readonly EXPECTED_SIGNER_SHA256=f7d19030cbde61f821b445b79c1adfc812aa01bca1c51061870f6cfd7e33a00b
readonly LOG_TAG=fund-app-auto-release

log() { logger -t "${LOG_TAG}" -- "$*"; printf '%s\n' "$*"; }

publish=1
if [ "${1:-}" = '--check-only' ]; then
  publish=0
  shift
fi

commit="${1:-check-only}"
changed="${2:-0}"
conflicts="${3:-0}"
if ! printf '%s' "${commit}" | grep -Eq '^(check-only|[0-9a-f]{40})$'; then
  log 'invalid upstream commit argument'
  exit 2
fi
if ! printf '%s' "${changed}:${conflicts}" | grep -Eq '^[0-9]+:[0-9]+$'; then
  log 'invalid upstream change counts'
  exit 2
fi

mkdir -p "${WORK_ROOT}" "${ANDROID_USER_HOME}" "${GRADLE_USER_HOME}" "${NPM_CONFIG_CACHE}"
exec 9>"${WORK_ROOT}/release.lock"
if ! flock -n 9; then
  log 'another APK build is already running'
  exit 75
fi

for required in \
  "${BUILDER_ROOT}/package.json" \
  "${BUILDER_ROOT}/android/gradlew" \
  "${PUBLIC_MANIFEST}" \
  "${JAVA_HOME}/bin/java" \
  "${ANDROID_HOME}/build-tools/35.0.0/apksigner" \
  "${ANDROID_USER_HOME}/debug.keystore"; do
  if [ ! -e "${required}" ]; then
    log "required APK build input is missing: ${required}"
    exit 1
  fi
done

if [ "${publish}" -eq 1 ] && node -e "
  const crypto = require('crypto');
  const fs = require('fs');
  const path = require('path');
  const manifest = JSON.parse(fs.readFileSync(process.argv[1], 'utf8'));
  const apkPath = path.join(process.argv[2], manifest.apkFileName || '');
  if (manifest.upstreamCommit !== process.argv[3] || !fs.existsSync(apkPath)) process.exit(1);
  const hash = crypto.createHash('sha256').update(fs.readFileSync(apkPath)).digest('hex');
  if (hash !== manifest.sha256 || fs.statSync(apkPath).size !== Number(manifest.sizeBytes)) process.exit(1);
" "${PUBLIC_MANIFEST}" "${DOWNLOAD_ROOT}" "${commit}"; then
  apk_name=$(node -p "JSON.parse(require('fs').readFileSync('${PUBLIC_MANIFEST}','utf8')).apkFileName")
  ln -sfn "${apk_name}" "${DOWNLOAD_ROOT}/fund-app-latest.apk.next"
  mv -Tf "${DOWNLOAD_ROOT}/fund-app-latest.apk.next" "${DOWNLOAD_ROOT}/fund-app-latest.apk"
  log "APK release already published for upstream ${commit}"
  exit 0
fi

rm -rf "${WORK_TREE}"
mkdir -p "${WORK_TREE}"
rsync -a --delete \
  --exclude node_modules/ --exclude dist/ --exclude android/.gradle/ --exclude android/app/build/ \
  "${BUILDER_ROOT}/" "${WORK_TREE}/"

node /usr/local/lib/fund-app-auto-release.mjs prepare \
  "${WORK_TREE}" "${PUBLIC_MANIFEST}" "${BUILD_STATE}"
version=$(node -p "JSON.parse(require('fs').readFileSync('${BUILD_STATE}','utf8')).version")
version_code=$(node -p "JSON.parse(require('fs').readFileSync('${BUILD_STATE}','utf8')).versionCode")

export JAVA_HOME ANDROID_HOME ANDROID_SDK_ROOT ANDROID_USER_HOME GRADLE_USER_HOME NPM_CONFIG_CACHE
export PATH="${JAVA_HOME}/bin:${ANDROID_HOME}/platform-tools:${ANDROID_HOME}/build-tools/35.0.0:${PATH}"
printf 'sdk.dir=%s\n' "${ANDROID_HOME}" > "${WORK_TREE}/android/local.properties"

cd "${WORK_TREE}"
npm ci --no-audit --no-fund --prefer-offline --registry=https://registry.npmmirror.com
npm run build
npx cap sync android
cd android
./gradlew :app:assembleDebug --no-daemon --stacktrace

apk_path="${WORK_TREE}/android/app/build/outputs/apk/debug/app-debug.apk"
test -s "${apk_path}"
badging=$("${ANDROID_HOME}/build-tools/35.0.0/aapt" dump badging "${apk_path}")
printf '%s\n' "${badging}" | grep -Fq "versionCode='${version_code}'"
printf '%s\n' "${badging}" | grep -Fq "versionName='${version}'"
signing=$("${ANDROID_HOME}/build-tools/35.0.0/apksigner" verify --verbose --print-certs "${apk_path}")
printf '%s\n' "${signing}" | grep -Fq 'Verified using v1 scheme (JAR signing): true'
printf '%s\n' "${signing}" | grep -Fq 'Verified using v2 scheme (APK Signature Scheme v2): true'
signer=$(printf '%s\n' "${signing}" | sed -n 's/^Signer #1 certificate SHA-256 digest: //p' | head -n 1)
if [ "${signer}" != "${EXPECTED_SIGNER_SHA256}" ]; then
  log "APK signer mismatch: ${signer}"
  exit 1
fi

if [ "${publish}" -eq 0 ]; then
  log "APK build check passed: ${version} (${version_code})"
  exit 0
fi

manifest_next="${WORK_ROOT}/app-version.json.next"
node /usr/local/lib/fund-app-auto-release.mjs manifest \
  "${apk_path}" "${BUILD_STATE}" "${PUBLIC_MANIFEST}" \
  "${commit}" "${changed}" "${conflicts}" "${manifest_next}"
apk_name=$(node -p "JSON.parse(require('fs').readFileSync('${manifest_next}','utf8')).apkFileName")
expected_hash=$(node -p "JSON.parse(require('fs').readFileSync('${manifest_next}','utf8')).sha256")
expected_size=$(node -p "JSON.parse(require('fs').readFileSync('${manifest_next}','utf8')).sizeBytes")

install -o fundproxy -g fundproxy -m 0644 "${apk_path}" "${DOWNLOAD_ROOT}/${apk_name}.uploading"
mv "${DOWNLOAD_ROOT}/${apk_name}.uploading" "${DOWNLOAD_ROOT}/${apk_name}"
ln -sfn "${apk_name}" "${DOWNLOAD_ROOT}/fund-app-latest.apk.next"
mv -Tf "${DOWNLOAD_ROOT}/fund-app-latest.apk.next" "${DOWNLOAD_ROOT}/fund-app-latest.apk"
install -o fundproxy -g fundproxy -m 0644 "${manifest_next}" "${PUBLIC_MANIFEST}.next"
mv "${PUBLIC_MANIFEST}.next" "${PUBLIC_MANIFEST}"

actual_hash=$(sha256sum "${DOWNLOAD_ROOT}/fund-app-latest.apk" | awk '{print $1}')
actual_size=$(stat -Lc '%s' "${DOWNLOAD_ROOT}/fund-app-latest.apk")
test "${actual_hash}" = "${expected_hash}"
test "${actual_size}" = "${expected_size}"
curl --fail --silent --show-error --max-time 15 http://127.0.0.1/api/app/version > "${WORK_ROOT}/published-version.json"
node -e "const v=JSON.parse(require('fs').readFileSync(process.argv[1])).data; if(v.version!==process.argv[2]||Number(v.versionCode)!==Number(process.argv[3])||v.sha256!==process.argv[4]) process.exit(1)" \
  "${WORK_ROOT}/published-version.json" "${version}" "${version_code}" "${expected_hash}"
cp "${PUBLIC_MANIFEST}" "${WORK_ROOT}/last-release.json"
log "APK auto release completed: ${version} (${version_code}), upstream ${commit}"
