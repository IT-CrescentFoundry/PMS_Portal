import type {
        AllocationCycle,
        AllocationOverview,
        AllocationProposal,
        AllocationReportLine,
        AllocationStatus,
        CompensationCycleDetail,
        DiscretionMode,
        DiscretionPolicy,
        Distribution,
        DistributionWrite,
} from '../types/api'
import { apiRequest } from './apiClient'

// --- cycles, overview and policy -------------------------------------------------------------

export function listAllocationCycles(signal?: AbortSignal): Promise<AllocationCycle[]> {
        return apiRequest<AllocationCycle[]>('/api/allocations/cycles', { signal })
}

export interface OverviewFilters {
        plantId?: number
        departmentId?: number
        status?: AllocationStatus | 'NOT_STARTED'
        staleOnly?: boolean
}

export function getAllocationOverview(
        cycleId: number,
        filters: OverviewFilters = {},
        signal?: AbortSignal,
): Promise<AllocationOverview> {
        return apiRequest<AllocationOverview>(`/api/allocations/cycles/${cycleId}`, {
                query: {
                        plant_id: filters.plantId,
                        department_id: filters.departmentId,
                        status: filters.status,
                        stale_only: filters.staleOnly || undefined,
                },
                signal,
        })
}

export function setDiscretionPolicy(
        cycleId: number,
        body: {
                mode: DiscretionMode
                max_increase_points: string | null
                max_decrease_points: string | null
        },
): Promise<DiscretionPolicy> {
        return apiRequest<DiscretionPolicy>(`/api/allocations/cycles/${cycleId}/policy`, {
                method: 'PUT',
                body,
        })
}

export function getAllocationReport(
        cycleId: number,
        filters: { plantId?: number; departmentId?: number; search?: string; status?: string },
        signal?: AbortSignal,
): Promise<AllocationReportLine[]> {
        return apiRequest<AllocationReportLine[]>(`/api/allocations/cycles/${cycleId}/employees`, {
                query: {
                        plant_id: filters.plantId,
                        department_id: filters.departmentId,
                        search: filters.search || undefined,
                        status: filters.status || undefined,
                },
                signal,
        })
}

/** The CHRO explicitly reopens a finalized company budget for revision. */
export function reopenBudget(cycleId: number, reason: string): Promise<CompensationCycleDetail> {
        return apiRequest<CompensationCycleDetail>(`/api/compensation/cycles/${cycleId}/reopen`, {
                method: 'POST',
                body: { reason },
        })
}

// --- distribution ------------------------------------------------------------------------------

export function startDistribution(
        cycleId: number,
        revisionReason: string | null,
): Promise<Distribution> {
        return apiRequest<Distribution>(`/api/allocations/cycles/${cycleId}/distributions`, {
                method: 'POST',
                body: { revision_reason: revisionReason },
        })
}

export function getDistribution(
        distributionId: number,
        signal?: AbortSignal,
): Promise<Distribution> {
        return apiRequest<Distribution>(`/api/allocations/distributions/${distributionId}`, {
                signal,
        })
}

export function saveDistribution(
        distributionId: number,
        body: DistributionWrite,
): Promise<Distribution> {
        return apiRequest<Distribution>(`/api/allocations/distributions/${distributionId}`, {
                method: 'PUT',
                body,
        })
}

export function publishDistribution(distributionId: number): Promise<Distribution> {
        return apiRequest<Distribution>(
                `/api/allocations/distributions/${distributionId}/publish`,
                {
                        method: 'POST',
                },
        )
}

// --- proposals ---------------------------------------------------------------------------------

export function startProposal(
        cycleId: number,
        plantId: number,
        departmentId: number,
): Promise<AllocationProposal> {
        return apiRequest<AllocationProposal>(`/api/allocations/cycles/${cycleId}/proposals`, {
                method: 'POST',
                body: { plant_id: plantId, department_id: departmentId },
        })
}

export function getProposal(proposalId: number, signal?: AbortSignal): Promise<AllocationProposal> {
        return apiRequest<AllocationProposal>(`/api/allocations/proposals/${proposalId}`, {
                signal,
        })
}

export function saveProposal(
        proposalId: number,
        body: {
                lines: { employee_id: number; proposed_percent: string; reason: string | null }[]
                note: string | null
        },
): Promise<AllocationProposal> {
        return apiRequest<AllocationProposal>(`/api/allocations/proposals/${proposalId}`, {
                method: 'PUT',
                body,
        })
}

export type ProposalAction = 'refresh' | 'submit' | 'forward' | 'return' | 'approve' | 'reject'

/** Workflow steps; return/approve/reject need a reason, forward takes an optional note. */
export function proposalAction(
        proposalId: number,
        action: ProposalAction,
        text?: string,
): Promise<AllocationProposal> {
        const body =
                action === 'forward'
                        ? { note: text || null }
                        : action === 'return' || action === 'approve' || action === 'reject'
                          ? { reason: text ?? '' }
                          : undefined
        return apiRequest<AllocationProposal>(
                `/api/allocations/proposals/${proposalId}/${action}`,
                {
                        method: 'POST',
                        body,
                },
        )
}
