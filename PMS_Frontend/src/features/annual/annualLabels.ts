import type { BadgeTone } from '../../components/common/Badge'
import type {
        AnnualDeviationStatus,
        AnnualResultStatus,
        AnnualRow,
        AnnualRule,
        CorrectionStatus,
} from '../../types/api'

export const ANNUAL_STATUS: Record<AnnualResultStatus, { label: string; tone: BadgeTone }> = {
        CALCULATED: { label: 'Calculated · awaiting CHRO approval', tone: 'warning' },
        PUBLISHED: { label: 'Approved (final)', tone: 'success' },
        SUPERSEDED: { label: 'Superseded by a later version', tone: 'neutral' },
        DISCARDED: { label: 'Replaced before approval', tone: 'neutral' },
}

export const DEVIATION_STATUS: Record<AnnualDeviationStatus, { label: string; tone: BadgeTone }> = {
        PENDING: { label: 'Awaiting the CHRO', tone: 'warning' },
        APPROVED: { label: 'Approved', tone: 'success' },
        REJECTED: { label: 'Rejected', tone: 'danger' },
        VOIDED: { label: 'Voided (recalculated)', tone: 'neutral' },
}

export const CORRECTION_STATUS: Record<CorrectionStatus, { label: string; tone: BadgeTone }> = {
        REQUESTED: { label: 'Awaiting the CHRO', tone: 'warning' },
        REJECTED: { label: 'Rejected', tone: 'danger' },
        DEPARTMENT_REVIEW: { label: 'Approved · department review', tone: 'info' },
        NORMALIZATION: { label: 'Approved · normalization', tone: 'info' },
        READY: { label: 'Ready for publication', tone: 'info' },
        PUBLISHED: { label: 'Published', tone: 'success' },
}

/** Where an employee's annual result stands, in one badge. */
export function standing(row: AnnualRow): { label: string; tone: BadgeTone } {
        if (row.published?.recalculation_required && !row.draft)
                return { label: 'Recalculation required', tone: 'warning' }
        if (row.draft?.recalculation_required)
                return { label: 'Recalculation required', tone: 'warning' }
        if (row.draft && row.published)
                return { label: 'Recalculated · awaiting CHRO approval', tone: 'warning' }
        if (row.draft) return { label: 'Calculated · awaiting CHRO approval', tone: 'warning' }
        if (row.published) return { label: 'Approved (final)', tone: 'success' }
        if (!row.complete) return { label: 'Quarters missing', tone: 'neutral' }
        return { label: 'Not calculated yet', tone: 'neutral' }
}

/** "Q1 25 % · Q2 25 % · Q3 25 % · Q4 25 %" */
export function ruleText(rule: AnnualRule): string {
        return Object.entries(rule.quarter_weights)
                .sort(([a], [b]) => Number(a) - Number(b))
                .map(([n, w]) => `Q${n} ${w} %`)
                .join(' · ')
}
