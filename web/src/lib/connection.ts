import { useSyncExternalStore } from 'react'

/*
 * Whether the API is reachable, as seen by the browser. Set by lib/api.ts on
 * every request (a fetch that throws = unreachable; any HTTP answer =
 * reachable) and by the shell's /api/health poll. Drives the non-blocking
 * "Can't reach the server" banner.
 */

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
