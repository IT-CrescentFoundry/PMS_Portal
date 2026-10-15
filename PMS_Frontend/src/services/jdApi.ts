import type { JDCreate, JDDetail, JDSummary, JDUpdate, JDVersion } from '../types/api'
import { apiRequest } from './apiClient'

export interface JDListParams {
        departmentId?: number
        plantId?: number
        search?: string
        includeInactive?: boolean
}

export function listJDs(params: JDListParams, signal?: AbortSignal): Promise<JDSummary[]> {
        return apiRequest<JDSummary[]>('/api/jds', {
                query: {
                        department_id: params.departmentId,
                        plant_id: params.plantId,
                        search: params.search,
                        include_inactive: params.includeInactive,
                },
                signal,
        })
}

export function getJD(jdId: number, signal?: AbortSignal): Promise<JDDetail> {
        return apiRequest<JDDetail>(`/api/jds/${jdId}`, { signal })
}

export function getJDVersion(
        jdId: number,
        versionId: number,
        signal?: AbortSignal,
): Promise<JDVersion> {
        return apiRequest<JDVersion>(`/api/jds/${jdId}/versions/${versionId}`, {
                signal,
        })
}

export function createJD(body: JDCreate): Promise<JDDetail> {
        return apiRequest<JDDetail>('/api/jds', { method: 'POST', body })
}

export function updateJDVersion(
        jdId: number,
        versionId: number,
        body: JDUpdate,
): Promise<JDVersion> {
        return apiRequest<JDVersion>(`/api/jds/${jdId}/versions/${versionId}`, {
                method: 'PUT',
                body,
        })
}

export type SignOffStep = 'propose' | 'authorise' | 'approve'

export function signOffJDVersion(
        jdId: number,
        versionId: number,
        step: SignOffStep,
): Promise<JDVersion> {
        return apiRequest<JDVersion>(`/api/jds/${jdId}/versions/${versionId}/${step}`, {
                method: 'POST',
        })
}

export function returnJDVersion(
        jdId: number,
        versionId: number,
        reason: string,
): Promise<JDVersion> {
        return apiRequest<JDVersion>(`/api/jds/${jdId}/versions/${versionId}/return`, {
                method: 'POST',
                body: { reason },
        })
}

export function startJDRevision(jdId: number): Promise<JDVersion> {
        return apiRequest<JDVersion>(`/api/jds/${jdId}/revisions`, {
                method: 'POST',
        })
}
