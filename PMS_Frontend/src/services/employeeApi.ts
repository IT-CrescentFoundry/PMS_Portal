import type { EmployeeDetail, EmployeeList } from '../types/api'
import { apiRequest } from './apiClient'

/** Exactly the query parameters GET /api/employees supports. */
export interface EmployeeListParams {
        plantId?: number
        departmentId?: number
        /** Only employees whose primary assignment is in the plant/department filter. */
        primaryOnly?: boolean
        includeInactive?: boolean
        /** Employee code or name contains (server-side, case-insensitive). */
        search?: string
        /** ISO date; omitted means "today" on the server. */
        asOf?: string
        limit: number
        offset: number
}

export function listEmployees(
        params: EmployeeListParams,
        signal?: AbortSignal,
): Promise<EmployeeList> {
        return apiRequest<EmployeeList>('/api/employees', {
                query: {
                        plant_id: params.plantId,
                        department_id: params.departmentId,
                        primary_only: params.primaryOnly,
                        include_inactive: params.includeInactive,
                        search: params.search?.trim(),
                        as_of: params.asOf,
                        limit: params.limit,
                        offset: params.offset,
                },
                signal,
        })
}

export function getEmployee(
        employeeId: number,
        asOf: string | undefined,
        signal?: AbortSignal,
): Promise<EmployeeDetail> {
        return apiRequest<EmployeeDetail>(`/api/employees/${employeeId}`, {
                query: { as_of: asOf },
                signal,
        })
}
