import { MutationCache, QueryCache, QueryClient } from '@tanstack/react-query'
import { toastFor } from '../components/errors.tsx'
import { emitToast } from '../components/toast.tsx'
import { isApiError } from './api.ts'

/*
 * One place for error policy (no ad-hoc handling in pages):
 *  - Queries poll every 3s and are not retried on 4xx (a 404 is final);
 *    network / 5xx errors retry once, then the next poll tries again.
 *    Query errors never toast (polling would spam); pages render them with
 *    <PageError> and the offline banner covers "server unreachable".
 *  - Every failed mutation (approve, submit, PATCH, ...) shows an error
 *    toast; forms also show the error inline. A mutation can opt out with
 *    `meta: { toast: false }`.
 */
export function createQueryClient() {
  return new QueryClient({
    queryCache: new QueryCache(),
    mutationCache: new MutationCache({
      onError: (error, _vars, _ctx, mutation) => {
        if (mutation.meta?.toast === false) return
        emitToast({ tone: 'error', ...toastFor(error) })
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
