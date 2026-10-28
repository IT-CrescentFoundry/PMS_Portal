import type { BadgeTone } from '../../components/common/Badge'
import type {
        AllocationStatus,
        DiscretionMode,
        DiscretionPolicy,
        DistributionMethod,
        DistributionStatus,
} from '../../types/api'

export const ALLOCATION_STATUS: Record<
        AllocationStatus | 'NOT_STARTED',
        { label: string; tone: BadgeTone }
> = {
        NOT_STARTED: { label: 'Not started', tone: 'neutral' },
        DRAFT: { label: 'Draft', tone: 'neutral' },
        ADMIN_REVIEW: { label: 'Awaiting Admin review', tone: 'warning' },
        CHRO_REVIEW: { label: 'Awaiting the CHRO', tone: 'warning' },
        APPROVED: { label: 'Approved', tone: 'success' },
        REJECTED: { label: 'Rejected', tone: 'danger' },
        RETURNED: { label: 'Returned for revision', tone: 'info' },
        SUPERSEDED: { label: 'Superseded', tone: 'neutral' },
}

export const DISTRIBUTION_STATUS: Record<DistributionStatus, { label: string; tone: BadgeTone }> = {
        DRAFT: { label: 'Draft', tone: 'neutral' },
        PUBLISHED: { label: 'Published', tone: 'success' },
        SUPERSEDED: { label: 'Superseded', tone: 'neutral' },
}

export const METHOD: Record<DistributionMethod, string> = {
        PERCENT: '% of parent',
        AMOUNT: 'Fixed amount',
}

export const DISCRETION: Record<DiscretionMode, { label: string; detail: string }> = {
        RECOMMENDATION_ONLY: {
                label: 'Recommendation only',
                detail: 'Departments confirm the matrix recommendation; no changes.',
        },
        WITH_REASON: {
                label: 'Changes with a reason',
                detail: 'Departments may change an increment %, giving a reason for each change.',
        },
        WITHIN_LIMITS: {
                label: 'Changes with a reason, within limits',
                detail: 'Changes stay within the set percentage points of the recommendation.',
        },
}

/** One line describing the discretion policy in force. */
export function policyText(policy: DiscretionPolicy): string {
        if (!policy.configured) return 'Recommendation only (no policy set yet)'
        const base = DISCRETION[policy.mode].label
        if (policy.mode !== 'WITHIN_LIMITS') return base
        return `${base}: up to +${policy.max_increase_points} / −${policy.max_decrease_points} percentage points`
}
