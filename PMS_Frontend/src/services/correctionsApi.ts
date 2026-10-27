import type {
        Correction,
        CorrectionPreview,
        CorrectionRequest,
        CorrectionStatus,
        CorrectionSummary,
        QuarterVersion,
} from '../types/api'
import { apiRequest } from './apiClient'

/** Check a correction of a published quarter and project its effect; saves nothing. */
export function previewCorrection(
        quarterId: number,
        body: CorrectionRequest,
): Promise<CorrectionPreview> {
        return apiRequest<CorrectionPreview>(`/api/kpi/quarters/${quarterId}/corrections/preview`, {
                method: 'POST',
                body,
                timeoutMs: 60_000,
        })
}

/** An HR Head requests the correction; the CHRO decides. */
export function requestCorrection(quarterId: number, body: CorrectionRequest): Promise<Correction> {
        return apiRequest<Correction>(`/api/kpi/quarters/${quarterId}/corrections`, {
                method: 'POST',
                body,
                timeoutMs: 60_000,
        })
}

export function listCorrections(
        params: { quarterId?: number; status?: CorrectionStatus },
        signal?: AbortSignal,
): Promise<CorrectionSummary[]> {
        return apiRequest<CorrectionSummary[]>('/api/kpi/corrections', {
                query: { quarter_id: params.quarterId, status: params.status },
                signal,
        })
}

export function getCorrection(correctionId: number, signal?: AbortSignal): Promise<Correction> {
        return apiRequest<Correction>(`/api/kpi/corrections/${correctionId}`, { signal })
}

export function decideCorrection(
        correctionId: number,
        decision: 'approve' | 'reject',
        reason: string,
): Promise<Correction> {
        return apiRequest<Correction>(`/api/kpi/corrections/${correctionId}/${decision}`, {
                method: 'POST',
                body: { reason },
                timeoutMs: 60_000,
        })
}

/** One review step forward (gated) or back (a reason is required). */
export function transitionCorrection(
        correctionId: number,
        to: CorrectionStatus,
        reason?: string,
): Promise<Correction> {
        return apiRequest<Correction>(`/api/kpi/corrections/${correctionId}/transition`, {
                method: 'POST',
                body: { to, reason: reason ?? null },
                timeoutMs: 60_000,
        })
}

/** Makes the corrected version current, in one transaction. */
export function publishCorrection(correctionId: number): Promise<Correction> {
        return apiRequest<Correction>(`/api/kpi/corrections/${correctionId}/publish`, {
                method: 'POST',
                timeoutMs: 60_000,
        })
}

export function listQuarterVersions(
        quarterId: number,
        signal?: AbortSignal,
): Promise<QuarterVersion[]> {
        return apiRequest<QuarterVersion[]>(`/api/kpi/quarters/${quarterId}/versions`, { signal })
}
