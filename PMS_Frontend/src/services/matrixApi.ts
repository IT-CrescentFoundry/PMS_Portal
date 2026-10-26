import type {
        MatrixCheckResponse,
        MatrixCreate,
        MatrixDefinition,
        MatrixDetail,
        MatrixDraftSave,
        MatrixEvaluation,
        MatrixSummary,
        MatrixTypeMeta,
        MatrixUploadConfirmed,
        MatrixUploadPreview,
        MatrixValue,
        MatrixVersion,
        MatrixVersionStatus,
} from '../types/api'
import { apiDownload, apiRequest } from './apiClient'

// --- types ------------------------------------------------------------------------------

/** The matrix types the caller may read, with the metadata that drives every form. */
export function listMatrixTypes(signal?: AbortSignal): Promise<MatrixTypeMeta[]> {
        return apiRequest<MatrixTypeMeta[]>('/api/matrix-types', { signal })
}

/** A blank generated workbook for creating a matrix of this type (HR Head). */
export function downloadTypeTemplate(typeCode: string): Promise<Blob> {
        return apiDownload(`/api/matrix-types/${encodeURIComponent(typeCode)}/template`)
}

/** Validate (and optionally preview) unsaved content; nothing is stored. */
export function checkDefinition(
        typeCode: string,
        body: {
                definition: MatrixDefinition
                attributes: Record<string, string>
                inputs?: Record<string, MatrixValue>
        },
): Promise<MatrixCheckResponse> {
        return apiRequest<MatrixCheckResponse>(
                `/api/matrix-types/${encodeURIComponent(typeCode)}/check`,
                { method: 'POST', body },
        )
}

// --- matrices and versions --------------------------------------------------------------

export interface MatrixListParams {
        matrixType?: string
        status?: MatrixVersionStatus
        search?: string
}

export function listMatrices(
        params: MatrixListParams,
        signal?: AbortSignal,
): Promise<MatrixSummary[]> {
        return apiRequest<MatrixSummary[]>('/api/matrices', {
                query: {
                        matrix_type: params.matrixType,
                        status: params.status,
                        search: params.search,
                },
                signal,
        })
}

export function getMatrix(matrixId: number, signal?: AbortSignal): Promise<MatrixDetail> {
        return apiRequest<MatrixDetail>(`/api/matrices/${matrixId}`, { signal })
}

/** Creates the matrix with an empty draft version 1. */
export function createMatrix(body: MatrixCreate): Promise<MatrixDetail> {
        return apiRequest<MatrixDetail>('/api/matrices', { method: 'POST', body })
}

/** A new draft copied from the latest version (published versions are never edited). */
export function reviseMatrix(matrixId: number): Promise<MatrixVersion> {
        return apiRequest<MatrixVersion>(`/api/matrices/${matrixId}/revisions`, {
                method: 'POST',
        })
}

export function getMatrixVersion(
        matrixId: number,
        versionId: number,
        signal?: AbortSignal,
): Promise<MatrixVersion> {
        return apiRequest<MatrixVersion>(`/api/matrices/${matrixId}/versions/${versionId}`, {
                signal,
        })
}

/** Saves a draft even with errors; the response's `check` lists them. */
export function saveMatrixDraft(
        matrixId: number,
        versionId: number,
        body: MatrixDraftSave,
): Promise<MatrixVersion> {
        return apiRequest<MatrixVersion>(`/api/matrices/${matrixId}/versions/${versionId}`, {
                method: 'PUT',
                body,
        })
}

export function previewMatrixVersion(
        matrixId: number,
        versionId: number,
        inputs: Record<string, MatrixValue>,
): Promise<MatrixEvaluation> {
        return apiRequest<MatrixEvaluation>(
                `/api/matrices/${matrixId}/versions/${versionId}/preview`,
                { method: 'POST', body: { inputs } },
        )
}

export type MatrixStep = 'submit' | 'withdraw' | 'publish'

export function matrixVersionStep(
        matrixId: number,
        versionId: number,
        step: MatrixStep,
): Promise<MatrixVersion> {
        return apiRequest<MatrixVersion>(
                `/api/matrices/${matrixId}/versions/${versionId}/${step}`,
                { method: 'POST' },
        )
}

/** CHRO approval; the approver must not be the author or submitter. */
export function approveMatrixVersion(
        matrixId: number,
        versionId: number,
        note: string | null,
): Promise<MatrixVersion> {
        return apiRequest<MatrixVersion>(
                `/api/matrices/${matrixId}/versions/${versionId}/approve`,
                { method: 'POST', body: { note } },
        )
}

export function rejectMatrixVersion(
        matrixId: number,
        versionId: number,
        reason: string,
): Promise<MatrixVersion> {
        return apiRequest<MatrixVersion>(`/api/matrices/${matrixId}/versions/${versionId}/reject`, {
                method: 'POST',
                body: { reason },
        })
}

/** The version's content as a workbook, to edit in Excel and upload again. */
export function downloadVersionTemplate(matrixId: number, versionId: number): Promise<Blob> {
        return apiDownload(`/api/matrices/${matrixId}/versions/${versionId}/template`)
}

// --- Excel uploads ----------------------------------------------------------------------

function uploadForm(file: File): FormData {
        const form = new FormData()
        form.append('file', file)
        return form
}

/** Validates a filled-in template; nothing is saved. */
export function previewMatrixUpload(file: File): Promise<MatrixUploadPreview> {
        return apiRequest<MatrixUploadPreview>('/api/matrices/uploads/preview', {
                method: 'POST',
                body: uploadForm(file),
                timeoutMs: 60_000,
        })
}

/** Re-validates and saves the workbook as a draft version, all or nothing. */
export function confirmMatrixUpload(file: File): Promise<MatrixUploadConfirmed> {
        return apiRequest<MatrixUploadConfirmed>('/api/matrices/uploads/confirm', {
                method: 'POST',
                body: uploadForm(file),
                timeoutMs: 60_000,
        })
}
