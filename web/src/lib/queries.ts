import type { ApplicationListDto, ChaosConfig, DeadJobListDto, MerchantServiceConfig, MetricsDto, ReviewQueueDto } from '@app/shared'
import { keepPreviousData, useQuery } from '@tanstack/react-query'
import { api, mockApi } from './api.ts'

/*
 * Shared queries: one cache entry each, reused by the sidebar badges, the
 * global search, the banners and the pages. All poll (3s default, see
 * main.tsx) and keep the previous data while refetching, so nothing flashes.
 */

export const qk = {
  applications: ['applications'] as const,
  application: (id: string) => ['application', id] as const,
  openTasks: ['review-tasks', 'OPEN'] as const,
  deadJobs: ['jobs', 'dead'] as const,
  metrics: ['metrics'] as const,
  health: ['health'] as const,
  chaos: ['mock-config'] as const,
  merchantService: ['merchant-service'] as const,
}

/** Every application (newest first, up to 500); pages filter client-side. */
export const useApplications = () =>
  useQuery({ queryKey: qk.applications, queryFn: () => api.get<ApplicationListDto>('/applications?limit=500'), placeholderData: keepPreviousData })

export const useOpenTasks = () =>
  useQuery({ queryKey: qk.openTasks, queryFn: () => api.get<ReviewQueueDto>('/review-tasks?status=OPEN'), placeholderData: keepPreviousData })

export const useDeadJobs = () =>
  useQuery({ queryKey: qk.deadJobs, queryFn: () => api.get<DeadJobListDto>('/jobs?status=dead'), placeholderData: keepPreviousData })

export const useMetrics = () => useQuery({ queryKey: qk.metrics, queryFn: () => api.get<MetricsDto>('/metrics'), placeholderData: keepPreviousData })

/** API liveness for the top bar dot (5s; never retried, so a failure shows quickly). */
export const useHealth = () =>
  useQuery({ queryKey: qk.health, queryFn: () => api.get<{ status: string }>('/health'), refetchInterval: 5000, retry: false, meta: { silent: true } })

export const useChaos = () =>
  useQuery({ queryKey: qk.chaos, queryFn: () => mockApi.get<ChaosConfig>('/admin/config'), placeholderData: keepPreviousData, meta: { silent: true } })

export const useMerchantService = () =>
  useQuery({
    queryKey: qk.merchantService,
    queryFn: () => api.get<MerchantServiceConfig>('/admin/merchant-service'),
    placeholderData: keepPreviousData,
    meta: { silent: true },
  })
