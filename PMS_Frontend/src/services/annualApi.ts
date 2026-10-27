import type {
        AnnualCalculated,
        AnnualCycle,
        AnnualDetail,
        AnnualDeviation,
        AnnualDeviationStatus,
        AnnualRow,
        OwnAnnual,
} from '../types/api'
import { apiRequest } from './apiClient'

// --- cycles and the annual rule -----------------------------------------------------------

export function listAnnualCycles(signal?: AbortSignal): Promise<AnnualCycle[]> {
        return apiRequest<AnnualCycle[]>('/api/annual/cycles', { signal })
}

/** Quarter weights of the annual score (the CHRO, before any result is approved). */
export function setAnnualRule(
        cycleId: number,
        weights: { quarter_number: number; weight: string }[],
): Promise<AnnualCycle> {
        return apiRequest<AnnualCycle>(`/api/annual/cycles/${cycleId}/rule`, {
                method: 'PUT',
                body: { weights },
        })
}

// --- annual results ------------------------------------------------------------------------

export interface AnnualRowParams {
        cycleId: number
        plantId?: number
        departmentId?: number
        search?: string
}

export function listAnnualRows(
        params: AnnualRowParams,
        signal?: AbortSignal,
): Promise<AnnualRow[]> {
        return apiRequest<AnnualRow[]>(`/api/annual/cycles/${params.cycleId}/employees`, {
                query: {
                        plant_id: params.plantId,
                        department_id: params.departmentId,
                        search: params.search,
                },
                signal,
        })
}

export function getAnnualDetail(
        cycleId: number,
        employeeId: number,
        signal?: AbortSignal,
): Promise<AnnualDetail> {
        return apiRequest<AnnualDetail>(`/api/annual/cycles/${cycleId}/employees/${employeeId}`, {
                signal,
        })
}

/** Calculate from the published quarters; all employees in scope, or the ones given. */
export function calculateAnnual(
        cycleId: number,
        employeeIds?: number[],
): Promise<AnnualCalculated> {
        return apiRequest<AnnualCalculated>(`/api/annual/cycles/${cycleId}/calculate`, {
                method: 'POST',
                body: { employee_ids: employeeIds ?? null },
                timeoutMs: 60_000,
        })
}

/** The CHRO approves a calculated version: it becomes the published annual result. */
export function finalizeAnnual(resultId: number, note: string | null): Promise<AnnualDetail> {
        return apiRequest<AnnualDetail>(`/api/annual/results/${resultId}/finalize`, {
                method: 'POST',
                body: { note },
        })
}

// --- deviations -----------------------------------------------------------------------------

export function requestAnnualDeviation(
        resultId: number,
        body: { original_score: string; proposed_score: string; reason: string },
): Promise<AnnualDeviation> {
        return apiRequest<AnnualDeviation>(`/api/annual/results/${resultId}/deviations`, {
                method: 'POST',
                body,
        })
}

export function listAnnualDeviations(
        params: { status?: AnnualDeviationStatus; cycleId?: number },
        signal?: AbortSignal,
): Promise<AnnualDeviation[]> {
        return apiRequest<AnnualDeviation[]>('/api/annual/deviations', {
                query: { status: params.status, cycle_id: params.cycleId },
                signal,
        })
}

export function decideAnnualDeviation(
        deviationId: number,
        decision: 'approve' | 'reject',
        reason: string,
): Promise<AnnualDeviation> {
        return apiRequest<AnnualDeviation>(`/api/annual/deviations/${deviationId}/${decision}`, {
                method: 'POST',
                body: { reason },
        })
}

export function listMyAnnual(signal?: AbortSignal): Promise<OwnAnnual[]> {
        return apiRequest<OwnAnnual[]>('/api/annual/my', { signal })
}
