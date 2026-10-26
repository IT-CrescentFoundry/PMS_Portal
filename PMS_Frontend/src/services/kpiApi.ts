import type {
        ApproverSide,
        Deviation,
        DeviationStatus,
        Kpi,
        KpiSheet,
        KpiWrite,
        PolicyPreview,
        Quarter,
        ScoringPolicy,
        SheetItemInput,
        SheetList,
        SheetSaved,
        StartScoringResult,
        UploadConfirmed,
        UploadPreview,
} from '../types/api'
import { apiDownload, apiRequest } from './apiClient'

// --- scoring policies ------------------------------------------------------------------

export function listPolicies(signal?: AbortSignal): Promise<ScoringPolicy[]> {
        return apiRequest<ScoringPolicy[]>('/api/kpi/policies', { signal })
}

/** Score for an achievement % (or, for zero tolerance, an actual value), and the
 *  matrix version that gave it. */
export function previewPolicyScore(
        policyId: number,
        input: { achievement_percent?: number; actual?: number },
): Promise<PolicyPreview> {
        return apiRequest<PolicyPreview>(`/api/kpi/policies/${policyId}/preview`, {
                method: 'POST',
                body: input,
        })
}

// --- KPI library -----------------------------------------------------------------------

export interface KpiListParams {
        /** Only KPIs usable at this plant/department. */
        plantId?: number
        departmentId?: number
        search?: string
        includeInactive?: boolean
}

export function listKpis(params: KpiListParams, signal?: AbortSignal): Promise<Kpi[]> {
        return apiRequest<Kpi[]>('/api/kpi/library', {
                query: {
                        plant_id: params.plantId,
                        department_id: params.departmentId,
                        search: params.search,
                        include_inactive: params.includeInactive,
                },
                signal,
        })
}

export function getKpi(kpiId: number, signal?: AbortSignal): Promise<Kpi> {
        return apiRequest<Kpi>(`/api/kpi/library/${kpiId}`, { signal })
}

export function createKpi(body: KpiWrite): Promise<Kpi> {
        return apiRequest<Kpi>('/api/kpi/library', { method: 'POST', body })
}

export function updateKpi(kpiId: number, body: KpiWrite): Promise<Kpi> {
        return apiRequest<Kpi>(`/api/kpi/library/${kpiId}`, {
                method: 'PUT',
                body,
        })
}

// --- quarters --------------------------------------------------------------------------

export function listQuarters(signal?: AbortSignal): Promise<Quarter[]> {
        return apiRequest<Quarter[]>('/api/kpi/quarters', { signal })
}

/** Locks every published sheet of the quarter (HR Head / CHRO, company-wide). */
export function startScoring(quarterId: number): Promise<StartScoringResult> {
        return apiRequest<StartScoringResult>(`/api/kpi/quarters/${quarterId}/start-scoring`, {
                method: 'POST',
        })
}

// --- sheets ----------------------------------------------------------------------------

export interface SheetListParams {
        quarterId: number
        plantId?: number
        departmentId?: number
        search?: string
}

export function listSheets(params: SheetListParams, signal?: AbortSignal): Promise<SheetList> {
        return apiRequest<SheetList>('/api/kpi/sheets', {
                query: {
                        quarter_id: params.quarterId,
                        plant_id: params.plantId,
                        department_id: params.departmentId,
                        search: params.search,
                },
                signal,
        })
}

export function getSheet(sheetId: number, signal?: AbortSignal): Promise<KpiSheet> {
        return apiRequest<KpiSheet>(`/api/kpi/sheets/${sheetId}`, { signal })
}

export function createSheet(body: {
        assignment_id: number
        quarter_id: number
        job_description_id?: number | null
}): Promise<KpiSheet> {
        return apiRequest<KpiSheet>('/api/kpi/sheets', {
                method: 'POST',
                body,
        })
}

export function saveSheet(
        sheetId: number,
        body: {
                items: SheetItemInput[]
                notes: string | null
                job_description_id: number | null
        },
): Promise<SheetSaved> {
        return apiRequest<SheetSaved>(`/api/kpi/sheets/${sheetId}`, {
                method: 'PUT',
                body,
        })
}

export function publishSheet(sheetId: number): Promise<KpiSheet> {
        return apiRequest<KpiSheet>(`/api/kpi/sheets/${sheetId}/publish`, {
                method: 'POST',
        })
}

export function reopenSheet(sheetId: number, reason: string): Promise<KpiSheet> {
        return apiRequest<KpiSheet>(`/api/kpi/sheets/${sheetId}/reopen`, {
                method: 'POST',
                body: { reason },
        })
}

export function copySheet(sheetId: number, targetQuarterId: number): Promise<KpiSheet> {
        return apiRequest<KpiSheet>(`/api/kpi/sheets/${sheetId}/copy`, {
                method: 'POST',
                body: { target_quarter_id: targetQuarterId },
        })
}

// --- Excel upload ----------------------------------------------------------------------

export const UPLOAD_TEMPLATE_NAME = 'kpi-upload-template.xlsx'

export function downloadUploadTemplate(): Promise<Blob> {
        return apiDownload('/api/kpi/uploads/template')
}

function uploadForm(quarterId: number, file: File): FormData {
        const form = new FormData()
        form.append('quarter_id', String(quarterId))
        form.append('file', file)
        return form
}

/** Validates the file; nothing is saved. */
export function previewUpload(quarterId: number, file: File): Promise<UploadPreview> {
        return apiRequest<UploadPreview>('/api/kpi/uploads/preview', {
                method: 'POST',
                body: uploadForm(quarterId, file),
                timeoutMs: 60_000,
        })
}

/** Re-validates and saves every sheet in the file as DRAFT, all or nothing. */
export function confirmUpload(quarterId: number, file: File): Promise<UploadConfirmed> {
        return apiRequest<UploadConfirmed>('/api/kpi/uploads/confirm', {
                method: 'POST',
                body: uploadForm(quarterId, file),
                timeoutMs: 60_000,
        })
}

// --- deviations ------------------------------------------------------------------------

export function listDeviations(
        status: DeviationStatus | undefined,
        signal?: AbortSignal,
): Promise<Deviation[]> {
        return apiRequest<Deviation[]>('/api/kpi/deviations', {
                query: { status },
                signal,
        })
}

export function getDeviation(deviationId: number, signal?: AbortSignal): Promise<Deviation> {
        return apiRequest<Deviation>(`/api/kpi/deviations/${deviationId}`, {
                signal,
        })
}

export function requestDeviation(body: {
        sheet_id: number
        reason: string
        items: SheetItemInput[]
}): Promise<Deviation> {
        return apiRequest<Deviation>('/api/kpi/deviations', {
                method: 'POST',
                body,
        })
}

export function approveDeviation(deviationId: number, side: ApproverSide): Promise<Deviation> {
        return apiRequest<Deviation>(`/api/kpi/deviations/${deviationId}/approve`, {
                method: 'POST',
                body: { as: side },
        })
}

export function rejectDeviation(deviationId: number, reason: string): Promise<Deviation> {
        return apiRequest<Deviation>(`/api/kpi/deviations/${deviationId}/reject`, {
                method: 'POST',
                body: { reason },
        })
}
