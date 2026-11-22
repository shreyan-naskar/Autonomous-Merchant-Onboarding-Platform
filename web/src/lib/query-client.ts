import { MutationCache, QueryCache, QueryClient } from '@tanstack/react-query'
import { emitToast } from './toast.ts'
import { friendlyError, isApiError } from './api.ts'

/*
 * The one error policy: a 4xx is final (no retry); query errors never toast
 * because polling would repeat them; every failed mutation toasts (opt out
 * with `meta: { toast: false }`).
 */
export function createQueryClient() {
  return new QueryClient({
    queryCache: new QueryCache(),
    mutationCache: new MutationCache({
      onError: (error, _vars, _ctx, mutation) => {
        if (mutation.meta?.toast === false) return
        const f = friendlyError(error)
        emitToast({ tone: 'error', title: f.title, message: f.message })
      },
    }),
    defaultOptions: {
      queries: {
        refetchInterval: 3000,
        retry: (count, error) => !(isApiError(error) && error.status >= 400 && error.status < 500) && count < 1,
      },
    },
  })
}
