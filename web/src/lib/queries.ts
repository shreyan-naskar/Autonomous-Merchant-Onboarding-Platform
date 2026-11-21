import type { ApplicationListDto, ChaosConfig, DeadJobListDto, MerchantServiceConfig, MetricsDto, ReviewQueueDto } from '@app/shared'
import { keepPreviousData, useQuery } from '@tanstack/react-query'
import { api, mockApi } from './api.ts'

/* One cache entry each, shared by badges, search, banners and pages. Previous data is kept while refetching, so polls never flash. */

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

export const useApplications = () =>
  useQuery({ queryKey: qk.applications, queryFn: () => api.get<ApplicationListDto>('/applications?limit=500'), placeholderData: keepPreviousData })

export const useOpenTasks = () =>
  useQuery({ queryKey: qk.openTasks, queryFn: () => api.get<ReviewQueueDto>('/review-tasks?status=OPEN'), placeholderData: keepPreviousData })

export const useDeadJobs = () =>
  useQuery({ queryKey: qk.deadJobs, queryFn: () => api.get<DeadJobListDto>('/jobs?status=dead'), placeholderData: keepPreviousData })

export const useMetrics = () => useQuery({ queryKey: qk.metrics, queryFn: () => api.get<MetricsDto>('/metrics'), placeholderData: keepPreviousData })

/** Never retried, so an outage shows quickly. */
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
