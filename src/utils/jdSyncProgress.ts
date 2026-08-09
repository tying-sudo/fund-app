export interface JdSyncProgressViewState {
  message: string
  percentage: number
}

/**
 * Keep progress monotonic while one import is running. A caller must opt in to
 * resetting the percentage when it starts a separate import task.
 */
export function mergeJdSyncProgress(
  current: JdSyncProgressViewState,
  next: JdSyncProgressViewState,
  reset = false
): JdSyncProgressViewState {
  return {
    message: next.message,
    percentage: reset ? next.percentage : Math.max(current.percentage, next.percentage)
  }
}
