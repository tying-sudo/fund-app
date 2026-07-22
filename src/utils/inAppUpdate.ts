import { Capacitor, registerPlugin } from '@capacitor/core'

interface NativeUpdateResult {
  needsPermission?: boolean
  bytes?: number
}

interface NativeUpdatePlugin {
  downloadAndInstall(options: { url: string }): Promise<NativeUpdateResult>
}

const InAppUpdate = registerPlugin<NativeUpdatePlugin>('InAppUpdate')

export async function downloadAndInstallAppUpdate(url: string): Promise<NativeUpdateResult> {
  if (Capacitor.getPlatform() === 'android') return InAppUpdate.downloadAndInstall({ url })
  window.location.assign(url)
  return {}
}
