#!/usr/bin/env bash
set -eu -o pipefail

for command_name in curl git node npm rsync tar; do
  command -v "${command_name}" >/dev/null
done

tools_root=/opt/fund-app-build-tools
jdk_root="${tools_root}/jdk-21"
sdk_root="${tools_root}/android-sdk"
mkdir -p "${tools_root}" /var/cache/fund-app-gradle /var/cache/fund-app-npm

if [ ! -x "${jdk_root}/bin/java" ]; then
  rm -rf "${jdk_root}" /tmp/fund-app-jdk
  mkdir -p /tmp/fund-app-jdk
  curl --location --fail --show-error --retry 2 --connect-timeout 15 --max-time 900 \
    https://aka.ms/download-jdk/microsoft-jdk-21-linux-x64.tar.gz \
    --output /tmp/fund-app-jdk.tar.gz
  tar -xzf /tmp/fund-app-jdk.tar.gz -C /tmp/fund-app-jdk
  extracted_jdk=$(find /tmp/fund-app-jdk -mindepth 1 -maxdepth 1 -type d | head -n 1)
  test -n "${extracted_jdk}"
  mv "${extracted_jdk}" "${jdk_root}"
  rm -rf /tmp/fund-app-jdk /tmp/fund-app-jdk.tar.gz
fi
"${jdk_root}/bin/java" -version 2>&1 | grep -q 'version "21\.'

if [ ! -f "${sdk_root}/cmdline-tools/latest/bin/sdkmanager" ]; then
  rm -rf "${sdk_root}/cmdline-tools" /tmp/fund-app-android-tools
  mkdir -p "${sdk_root}/cmdline-tools" /tmp/fund-app-android-tools
  curl --location --fail --show-error --retry 2 --connect-timeout 15 --max-time 900 \
    https://dl.google.com/android/repository/commandlinetools-linux-11076708_latest.zip \
    --output /tmp/fund-app-commandline-tools.zip
  cd /tmp/fund-app-android-tools
  "${jdk_root}/bin/jar" xf /tmp/fund-app-commandline-tools.zip
  mv /tmp/fund-app-android-tools/cmdline-tools "${sdk_root}/cmdline-tools/latest"
  rm -rf /tmp/fund-app-android-tools /tmp/fund-app-commandline-tools.zip
fi
chmod 0755 "${sdk_root}/cmdline-tools/latest/bin/"*
export JAVA_HOME="${jdk_root}"
export ANDROID_HOME="${sdk_root}"
yes | "${sdk_root}/cmdline-tools/latest/bin/sdkmanager" --sdk_root="${sdk_root}" --licenses >/dev/null || true
"${sdk_root}/cmdline-tools/latest/bin/sdkmanager" --sdk_root="${sdk_root}" \
  'platform-tools' 'platforms;android-35' 'build-tools;35.0.0'
