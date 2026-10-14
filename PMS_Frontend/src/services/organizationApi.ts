import type { Department, DepartmentDetail, OrgUnit, Plant, PlantDetail } from '../types/api'
import { apiRequest } from './apiClient'

export function listPlants(includeInactive: boolean, signal?: AbortSignal): Promise<Plant[]> {
        return apiRequest<Plant[]>('/api/plants', {
                query: { include_inactive: includeInactive },
                signal,
        })
}

export function getPlant(plantId: number, signal?: AbortSignal): Promise<PlantDetail> {
        return apiRequest<PlantDetail>(`/api/plants/${plantId}`, { signal })
}

export function listDepartments(
        includeInactive: boolean,
        signal?: AbortSignal,
): Promise<Department[]> {
        return apiRequest<Department[]>('/api/departments', {
                query: { include_inactive: includeInactive },
                signal,
        })
}

export function getDepartment(
        departmentId: number,
        signal?: AbortSignal,
): Promise<DepartmentDetail> {
        return apiRequest<DepartmentDetail>(`/api/departments/${departmentId}`, { signal })
}

/** Every plant-department unit the caller may see, in one request. */
export function listOrgUnits(
        params: { includeInactive?: boolean } = {},
        signal?: AbortSignal,
): Promise<OrgUnit[]> {
        return apiRequest<OrgUnit[]>('/api/org-units', {
                query: { include_inactive: params.includeInactive },
                signal,
        })
}
