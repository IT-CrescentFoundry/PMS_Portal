import type { BadgeTone } from '../../components/common/Badge'
import type {
        GroupDistribution,
        NormalizationPlacement,
        NormalizationRunStatus,
        QuarterStatus,
} from '../../types/api'

/** The quarter's review steps, in order, with what happens in each. */
export const PHASES: { status: QuarterStatus; label: string; detail: string }[] = [
        { status: 'DRAFT', label: 'KPI setup', detail: 'KPI sheets are prepared and published.' },
        {
                status: 'OPEN',
                label: 'Data collection',
                detail: 'Monthly data is imported and scores are calculated.',
        },
        {
                status: 'DEPARTMENT_REVIEW',
                label: 'Department review',
                detail: 'Data is frozen; departments review each result.',
        },
        {
                status: 'NORMALIZATION',
                label: 'Normalization',
                detail: 'Employee scores are frozen and placed in groups.',
        },
        {
                status: 'READY',
                label: 'Ready',
                detail: 'Every cohort is approved; publication can follow.',
        },
        {
                status: 'PUBLISHED',
                label: 'Published',
                detail: 'Scores are final and the quarter is locked.',
        },
]

export function phaseLabel(status: QuarterStatus | null): string {
        if (status === 'CLOSED') return 'Closed'
        return PHASES.find((p) => p.status === status)?.label ?? '—'
}

export const PLACEMENT_LABELS: Record<NormalizationPlacement, string> = {
        AUTO: 'By ranking',
        TIE_RULE: 'Tie: policy rule',
        TIE_RESOLVED: 'Tie: placed by a reviewer',
        SMALL_COHORT_DEFAULT: 'Small cohort: policy rule',
        SMALL_COHORT_RESOLVED: 'Small cohort: placed by a reviewer',
        NEEDS_RESOLUTION: 'Needs a reviewer',
        NOT_ELIGIBLE: 'Not eligible',
}

export const COHORT_STATUS: Record<NormalizationRunStatus, { label: string; tone: BadgeTone }> = {
        DRAFT: { label: 'Awaiting approval', tone: 'warning' },
        APPROVED: { label: 'Approved', tone: 'success' },
        PUBLISHED: { label: 'Published', tone: 'success' },
        DISCARDED: { label: 'Discarded', tone: 'neutral' },
}

export const WEIGHTS_SOURCE: Record<string, string> = {
        SINGLE: 'One scored assignment (100 %)',
        CONFIGURED: 'Contribution weights set',
        MISSING: 'Contribution weights missing',
        INVALID: 'Contribution weights invalid',
}

export const EMPLOYEE_STATUS: Record<string, { label: string; tone: BadgeTone }> = {
        LIVE: { label: 'Live (before normalization)', tone: 'neutral' },
        DRAFT: { label: 'Frozen for normalization', tone: 'info' },
        PUBLISHED: { label: 'Published', tone: 'success' },
}

/** "2 (25 %) · target 2 (20 %)" */
export function distributionText(d: GroupDistribution): string {
        const share = d.actual_percent !== null ? ` (${d.actual_percent} %)` : ''
        return `${d.actual_count}${share} · target ${d.target_count} (${d.target_percent} %)`
}
