import type { FundInfo, WatchlistItem } from '@/types/fund'

function cleanText(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

export function createInitialWatchlistItem(
  code: string,
  directoryEntry?: Pick<FundInfo, 'name' | 'type'>
): WatchlistItem {
  return {
    code,
    name: cleanText(directoryEntry?.name),
    type: cleanText(directoryEntry?.type),
    loading: true
  }
}

export function resolveWatchlistName(incomingName: unknown, currentName: unknown): string {
  return cleanText(incomingName) || cleanText(currentName)
}
