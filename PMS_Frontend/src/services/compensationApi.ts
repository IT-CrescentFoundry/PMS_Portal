import type {
        BaselinePreview,
        BaselineRows,
        BaselineSummary,
        BudgetLine,
        BudgetScenario,
        CompensationCycle,
        CompensationCycleDetail,
        CompensationCycleWrite,
} from '../types/api'
import { apiDownload, apiRequest } from './apiClient'

// --- cycles --------------------------------------------------------------------------------

export function listCompensationCycles(signal?: AbortSignal): Promise<CompensationCycle[]> {
        return apiRequest<CompensationCycle[]>('/api/compensation/cycles', { signal })
}

export function getCompensationCycle(
        cycleId: number,
        signal?: AbortSignal,
): Promise<CompensationCycleDetail> {
        return apiRequest<CompensationCycleDetail>(`/api/compensation/cycles/${cycleId}`, {
                signal,
        })
}

export function createCompensationCycle(
        body: CompensationCycleWrite,
): Promise<CompensationCycleDetail> {
        return apiRequest<CompensationCycleDetail>('/api/compensation/cycles', {
                method: 'POST',
                body,
        })
}

export function updateCompensationCycle(
        cycleId: number,
        body: CompensationCycleWrite,
): Promise<CompensationCycleDetail> {
        return apiRequest<CompensationCycleDetail>(`/api/compensation/cycles/${cycleId}`, {
                method: 'PUT',
                body,
        })
}

// --- salary baselines ------------------------------------------------------------------------

export function downloadBaselineTemplate(cycleId: number): Promise<Blob> {
        return apiDownload(`/api/compensation/cycles/${cycleId}/baseline/template`)
}

function baselineForm(file: File): FormData {
        const form = new FormData()
        form.append('file', file)
        return form
}

/** Validates a salary baseline file; nothing is saved. */
export function previewBaseline(cycleId: number, file: File): Promise<BaselinePreview> {
        return apiRequest<BaselinePreview>(`/api/compensation/cycles/${cycleId}/baseline/preview`, {
                method: 'POST',
                body: baselineForm(file),
                timeoutMs: 60_000,
        })
}

/** Re-validates and stores the whole file as a new baseline version, or nothing. */
export function confirmBaseline(cycleId: number, file: File): Promise<BaselineSummary> {
        return apiRequest<BaselineSummary>(`/api/compensation/cycles/${cycleId}/baseline/confirm`, {
                method: 'POST',
                body: baselineForm(file),
                timeoutMs: 60_000,
        })
}

export function getBaselineRows(
        cycleId: number,
        baselineId: number,
        signal?: AbortSignal,
): Promise<BaselineRows> {
        return apiRequest<BaselineRows>(
                `/api/compensation/cycles/${cycleId}/baselines/${baselineId}`,
                { signal },
        )
}

// --- budget decisions and scenarios ---------------------------------------------------------

/** The budget owner records the company-approved budget amount. */
export function recordBudgetDecision(
        cycleId: number,
        amount: string,
        reason: string,
): Promise<CompensationCycleDetail> {
        return apiRequest<CompensationCycleDetail>(
                `/api/compensation/cycles/${cycleId}/budget-decisions`,
                { method: 'POST', body: { amount, reason } },
        )
}

export interface ScenarioRequest {
        name: string
        baseline_id?: number | null
        /** {matrix type: version id}: an analysis-only scenario. */
        overrides?: Record<string, number> | null
        note?: string | null
}

export function calculateScenario(cycleId: number, body: ScenarioRequest): Promise<BudgetScenario> {
        return apiRequest<BudgetScenario>(`/api/compensation/cycles/${cycleId}/scenarios`, {
                method: 'POST',
                body,
                timeoutMs: 120_000,
        })
}

export function getScenario(scenarioId: number, signal?: AbortSignal): Promise<BudgetScenario> {
        return apiRequest<BudgetScenario>(`/api/compensation/scenarios/${scenarioId}`, { signal })
}

export function submitScenario(scenarioId: number): Promise<BudgetScenario> {
        return apiRequest<BudgetScenario>(`/api/compensation/scenarios/${scenarioId}/submit`, {
                method: 'POST',
        })
}

export function decideScenario(
        scenarioId: number,
        decision: 'approve' | 'reject',
        reason: string,
): Promise<BudgetScenario> {
        return apiRequest<BudgetScenario>(`/api/compensation/scenarios/${scenarioId}/${decision}`, {
                method: 'POST',
                body: { reason },
        })
}

/** One employee's proposal as it would be calculated now; nothing is saved. */
export function previewProposal(
        cycleId: number,
        body: {
                employee_id: number
                baseline_id?: number | null
                overrides?: Record<string, number> | null
        },
): Promise<BudgetLine> {
        return apiRequest<BudgetLine>(`/api/compensation/cycles/${cycleId}/preview`, {
                method: 'POST',
                body,
        })
}
