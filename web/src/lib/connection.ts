import { useSyncExternalStore } from 'react'

/* Any HTTP answer means reachable; only a fetch that throws (or a proxy 502/504) means unreachable. */

let reachable = true
const listeners = new Set<() => void>()

export function reportReachable(ok: boolean) {
  if (ok === reachable) return
  reachable = ok
  for (const l of listeners) l()
}

export function useServerReachable(): boolean {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l)
      return () => listeners.delete(l)
    },
    () => reachable,
    () => true,
  )
}
