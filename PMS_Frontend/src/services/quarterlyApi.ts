import type {
        Cohort,
        CohortSummary,
        EmployeeResult,
        OwnSheet,
        QuarterOverview,
        QuarterStatus,
        SheetComment,
        SheetCommentKind,
} from '../types/api'
import { apiRequest } from './apiClient'

// --- quarter lifecycle ------------------------------------------------------------------

export function getQuarterOverview(
        quarterId: number,
        signal?: AbortSignal,
): Promise<QuarterOverview> {
        return apiRequest<QuarterOverview>(`/api/kpi/quarters/${quarterId}/overview`, { signal })
}

/** One step forward (the API checks the gate) or back (a reason is required). */
export function transitionQuarter(
        quarterId: number,
        to: QuarterStatus,
        reason?: string,
): Promise<QuarterOverview> {
        return apiRequest<QuarterOverview>(`/api/kpi/quarters/${quarterId}/transition`, {
                method: 'POST',
                body: { to, reason: reason ?? null },
                timeoutMs: 60_000,
        })
}

/** Publishes every result of a quarter ready for publication, in one transaction. */
export function publishQuarter(quarterId: number): Promise<QuarterOverview> {
        return apiRequest<QuarterOverview>(`/api/kpi/quarters/${quarterId}/publish`, {
                method: 'POST',
                timeoutMs: 60_000,
        })
}

// --- employee results -------------------------------------------------------------------

export interface EmployeeResultParams {
        quarterId: number
        plantId?: number
        departmentId?: number
        search?: string
}

export function listEmployeeResults(
        params: EmployeeResultParams,
        signal?: AbortSignal,
): Promise<EmployeeResult[]> {
        return apiRequest<EmployeeResult[]>(`/api/kpi/quarters/${params.quarterId}/employees`, {
                query: {
                        plant_id: params.plantId,
                        department_id: params.departmentId,
                        search: params.search,
                },
                signal,
        })
}

export function getEmployeeResult(
        quarterId: number,
        employeeId: number,
        signal?: AbortSignal,
): Promise<EmployeeResult> {
        return apiRequest<EmployeeResult>(
                `/api/kpi/quarters/${quarterId}/employees/${employeeId}`,
                { signal },
        )
}

/** Contribution weights of a cross-plant employee's scored assignments (total 100 %). */
export function setContributionWeights(
        quarterId: number,
        employeeId: number,
        weights: { assignment_id: number; weight: string }[],
): Promise<EmployeeResult> {
        return apiRequest<EmployeeResult>(
                `/api/kpi/quarters/${quarterId}/employees/${employeeId}/weights`,
                { method: 'PUT', body: { weights } },
        )
}

// --- normalization ----------------------------------------------------------------------

export function listCohorts(quarterId: number, signal?: AbortSignal): Promise<CohortSummary[]> {
        return apiRequest<CohortSummary[]>(`/api/kpi/quarters/${quarterId}/normalization`, {
                signal,
        })
}

export function getCohort(runId: number, signal?: AbortSignal): Promise<Cohort> {
        return apiRequest<Cohort>(`/api/kpi/normalization-runs/${runId}`, { signal })
}

/** Place a tied employee, or a member of a small cohort, with a reason. */
export function placeMember(
        runId: number,
        body: { employee_id: number; group: string; reason: string },
): Promise<Cohort> {
        return apiRequest<Cohort>(`/api/kpi/normalization-runs/${runId}/placements`, {
                method: 'POST',
                body,
        })
}

export function approveCohort(runId: number, note: string | null): Promise<Cohort> {
        return apiRequest<Cohort>(`/api/kpi/normalization-runs/${runId}/approve`, {
                method: 'POST',
                body: { note },
        })
}

export function reopenCohort(runId: number, reason: string): Promise<Cohort> {
        return apiRequest<Cohort>(`/api/kpi/normalization-runs/${runId}/reopen`, {
                method: 'POST',
                body: { reason },
        })
}

// --- comments, feedback and the employee's own sheets ----------------------------------

export function listComments(
        sheetId: number,
        signal?: AbortSignal,
): Promise<{ comments: SheetComment[]; can_comment: boolean }> {
        return apiRequest(`/api/kpi/sheets/${sheetId}/comments`, { signal })
}

/** Optional: never required for review, normalization or publication. */
export function addComment(
        sheetId: number,
        kind: SheetCommentKind,
        body: string,
): Promise<SheetComment> {
        return apiRequest<SheetComment>(`/api/kpi/sheets/${sheetId}/comments`, {
                method: 'POST',
                body: { kind, body },
        })
}

export function listMySheets(signal?: AbortSignal): Promise<OwnSheet[]> {
        return apiRequest<OwnSheet[]>('/api/kpi/my/kpi-sheets', { signal })
}
