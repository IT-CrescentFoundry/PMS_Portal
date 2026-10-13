import type { HeadcountReport } from '../types/api'
import { apiRequest } from './apiClient'

export interface HeadcountParams {
  /** Omit for all accessible plants. */
  plantId?: number
  /** Omit for all accessible departments. */
  departmentId?: number
  asOf?: string
}

/** Authoritative headcount: each person counted once, by primary assignment. */
export function getHeadcount(params: HeadcountParams, signal?: AbortSignal): Promise<HeadcountReport> {
  return apiRequest<HeadcountReport>('/api/reports/headcount', {
    query: {
      plant_id: params.plantId,
      department_id: params.departmentId,
      as_of: params.asOf,
    },
    signal,
  })
}
