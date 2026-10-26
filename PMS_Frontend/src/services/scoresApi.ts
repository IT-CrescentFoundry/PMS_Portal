import type {
        ApproverSide,
        CalculateResult,
        DataImport,
        DataImportConfirmed,
        DataImportPreview,
        MonthlyValue,
        ResultDetail,
        ResultList,
        ScoreOverride,
        ScoreOverrideStatus,
} from '../types/api'
import { apiDownload, apiRequest } from './apiClient'

// --- monthly KPI data -------------------------------------------------------------------

/** A workbook pre-filled with the KPIs that need data for the month ("2026-10"). */
export function downloadDataTemplate(quarterId: number, period: string): Promise<Blob> {
        return apiDownload('/api/kpi/data/template', {
                query: { quarter_id: quarterId, period },
                timeoutMs: 60_000,
        })
}

export interface DataImportRequest {
        quarterId: number
        /** "2026-10" */
        period: string
        file: File
        /** Contract field key -> file column; omitted: the columns are matched by name. */
        mapping?: Record<string, string | null>
        /** Allow values already stored for the month to be replaced. */
        replaceExisting: boolean
}

function dataForm(request: DataImportRequest): FormData {
        const form = new FormData()
        form.append('quarter_id', String(request.quarterId))
        form.append('period', request.period)
        form.append('file', request.file)
        if (request.mapping) form.append('mapping', JSON.stringify(request.mapping))
        form.append('replace_existing', request.replaceExisting ? 'true' : 'false')
        return form
}

/** Validates a CSV or Excel file of monthly values; nothing is saved. */
export function previewDataImport(request: DataImportRequest): Promise<DataImportPreview> {
        return apiRequest<DataImportPreview>('/api/kpi/data/preview', {
                method: 'POST',
                body: dataForm(request),
                timeoutMs: 60_000,
        })
}

/** Re-validates and stores every value of the file, or none. */
export function confirmDataImport(request: DataImportRequest): Promise<DataImportConfirmed> {
        return apiRequest<DataImportConfirmed>('/api/kpi/data/confirm', {
                method: 'POST',
                body: dataForm(request),
                timeoutMs: 60_000,
        })
}

export function listDataImports(quarterId: number, signal?: AbortSignal): Promise<DataImport[]> {
        return apiRequest<DataImport[]>('/api/kpi/data/imports', {
                query: { quarter_id: quarterId },
                signal,
        })
}

/** The imported source values of one sheet. */
export function getSheetValues(sheetId: number, signal?: AbortSignal): Promise<MonthlyValue[]> {
        return apiRequest<MonthlyValue[]>(`/api/kpi/sheets/${sheetId}/values`, { signal })
}

// --- quarterly results ------------------------------------------------------------------

/** (Re)calculate scores for published or locked sheets in your scope. */
export function calculateResults(quarterId: number, sheetIds?: number[]): Promise<CalculateResult> {
        return apiRequest<CalculateResult>('/api/kpi/results/calculate', {
                method: 'POST',
                body: { quarter_id: quarterId, sheet_ids: sheetIds ?? null },
                timeoutMs: 60_000,
        })
}

export interface ResultListParams {
        quarterId: number
        plantId?: number
        departmentId?: number
        search?: string
}

export function listResults(params: ResultListParams, signal?: AbortSignal): Promise<ResultList> {
        return apiRequest<ResultList>('/api/kpi/results', {
                query: {
                        quarter_id: params.quarterId,
                        plant_id: params.plantId,
                        department_id: params.departmentId,
                        search: params.search,
                },
                signal,
        })
}

export function getResult(sheetId: number, signal?: AbortSignal): Promise<ResultDetail> {
        return apiRequest<ResultDetail>(`/api/kpi/results/${sheetId}`, { signal })
}

export function reviewResult(sheetId: number): Promise<ResultDetail> {
        return apiRequest<ResultDetail>(`/api/kpi/results/${sheetId}/review`, { method: 'POST' })
}

/** Final and immutable (HR Head or CHRO). */
export function publishResult(sheetId: number): Promise<ResultDetail> {
        return apiRequest<ResultDetail>(`/api/kpi/results/${sheetId}/publish`, { method: 'POST' })
}

// --- manual overrides (a separate, dual-approved deviation) -----------------------------

export function requestOverride(
        sheetId: number,
        body: { proposed_score: string; reason: string },
): Promise<ScoreOverride> {
        return apiRequest<ScoreOverride>(`/api/kpi/results/${sheetId}/overrides`, {
                method: 'POST',
                body,
        })
}

export function listOverrides(
        status: ScoreOverrideStatus | undefined,
        signal?: AbortSignal,
): Promise<ScoreOverride[]> {
        return apiRequest<ScoreOverride[]>('/api/kpi/overrides', { query: { status }, signal })
}

export function approveOverride(overrideId: number, side: ApproverSide): Promise<ScoreOverride> {
        return apiRequest<ScoreOverride>(`/api/kpi/overrides/${overrideId}/approve`, {
                method: 'POST',
                body: { as: side },
        })
}

export function rejectOverride(overrideId: number, reason: string): Promise<ScoreOverride> {
        return apiRequest<ScoreOverride>(`/api/kpi/overrides/${overrideId}/reject`, {
                method: 'POST',
                body: { reason },
        })
}
