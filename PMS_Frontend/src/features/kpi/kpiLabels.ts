import type { BadgeTone } from '../../components/common/Badge'
import type {
        DeviationStatus,
        KpiAggregation,
        KpiDirection,
        KpiSheetStatus,
        Quarter,
        QuarterStatus,
        ReportingFrequency,
        ScoringPolicy,
} from '../../types/api'
import { formatDate } from '../../utils/format'

/** The quarter to show when none is chosen: the first one still in KPI setup. */
export function defaultQuarter(quarters: Quarter[]): Quarter | undefined {
        return quarters.find((q) => q.status === 'DRAFT') ?? quarters[0]
}

export function quarterLabel(quarter: Quarter): string {
        return `${quarter.name} · ${quarter.cycle_name} (${formatDate(quarter.start_date)} – ${formatDate(quarter.end_date)})`
}

export const DIRECTION_LABELS: Record<KpiDirection, string> = {
        HIGHER_IS_BETTER: 'Higher is better',
        LOWER_IS_BETTER: 'Lower is better',
        ZERO_TOLERANCE: 'Zero tolerance',
        TARGET_RANGE: 'Within a target range',
        CATEGORICAL: 'Categorical result',
        COMPOSITE: 'Composite of several inputs',
}

/** How a KPI's monthly values combine into the quarterly actual. */
export const AGGREGATION_LABELS: Record<KpiAggregation, string> = {
        SUM: 'Sum of the months',
        AVERAGE: 'Average of the months',
        LAST: 'Latest month',
        MIN: 'Lowest month',
        MAX: 'Highest month',
}

export const FREQUENCY_LABELS: Record<ReportingFrequency, string> = {
        MONTHLY: 'Monthly',
        QUARTERLY: 'Quarterly (one value)',
}

export const SHEET_STATUS: Record<KpiSheetStatus, { label: string; tone: BadgeTone }> = {
        DRAFT: { label: 'Draft', tone: 'warning' },
        PUBLISHED: { label: 'Published', tone: 'success' },
        LOCKED: { label: 'Locked', tone: 'neutral' },
}

export const QUARTER_STATUS: Record<QuarterStatus, { label: string; tone: BadgeTone }> = {
        DRAFT: { label: 'KPI setup open', tone: 'info' },
        OPEN: { label: 'Scoring started · KPIs locked', tone: 'neutral' },
        CLOSED: { label: 'Closed', tone: 'neutral' },
}

export const DEVIATION_STATUS: Record<DeviationStatus, { label: string; tone: BadgeTone }> = {
        PENDING: { label: 'Awaiting approval', tone: 'warning' },
        APPLIED: { label: 'Approved and applied', tone: 'success' },
        REJECTED: { label: 'Rejected', tone: 'danger' },
}

/** Plain-language rule, e.g. "above 100% → 5, above 90% → 4, otherwise 1". For a
 *  policy configured as a matrix, the version in force (the matrix holds the rules). */
export function describePolicy(policy: ScoringPolicy): string {
        if (policy.matrix) {
                const v = policy.matrix.in_force
                return v
                        ? `Matrix ${policy.matrix.code} version ${v.version_no}, in force since ${formatDate(v.effective_from)}`
                        : `Matrix ${policy.matrix.code}: no approved version in force yet`
        }
        if (policy.direction === 'ZERO_TOLERANCE') {
                return `No incident → ${policy.met_score ?? '—'}; any incident → ${policy.breached_score ?? '—'}`
        }
        const word = policy.direction === 'HIGHER_IS_BETTER' ? 'above' : 'below'
        const bands = policy.bands.map((b) => `${word} ${b.threshold}% → ${b.score}`)
        return [...bands, `otherwise ${policy.fallback_score}`].join(', ')
}
