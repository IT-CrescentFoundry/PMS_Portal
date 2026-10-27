import type { BadgeTone } from '../../components/common/Badge'
import type {
        Quarter,
        QuarterStatus,
        ResultBrief,
        ResultItemStatus,
        ScoreOverrideStatus,
        ScoreResultStatus,
} from '../../types/api'
import { todayIso } from '../../utils/format'

/** Quarters whose scores are being collected, reviewed or normalized. */
export const IN_SCORING: QuarterStatus[] = ['OPEN', 'DEPARTMENT_REVIEW', 'NORMALIZATION', 'READY']

function latest(quarters: Quarter[]): Quarter | undefined {
        return [...quarters].sort((a, b) => b.start_date.localeCompare(a.start_date))[0]
}

/** The quarter to show when none is chosen: the most recent one in one of
 *  `statuses` (by default, being scored), else the most recently published,
 *  else the first. */
export function scoringQuarter(
        quarters: Quarter[],
        statuses: QuarterStatus[] = IN_SCORING,
): Quarter | undefined {
        return (
                latest(quarters.filter((q) => statuses.includes(q.status))) ??
                latest(quarters.filter((q) => q.status === 'PUBLISHED')) ??
                quarters[0]
        )
}

/** "2026-10", "2026-11", "2026-12" for a quarter. */
export function quarterMonths(quarter: Quarter): string[] {
        const months: string[] = []
        let [year, month] = quarter.start_date.split('-').map(Number)
        const [endYear, endMonth] = quarter.end_date.split('-').map(Number)
        while (year < endYear || (year === endYear && month <= endMonth)) {
                months.push(`${year}-${String(month).padStart(2, '0')}`)
                month += 1
                if (month > 12) {
                        month = 1
                        year += 1
                }
        }
        return months
}

/** Months of the quarter that have started (data can only be imported for those). */
export function startedMonths(quarter: Quarter, today = todayIso()): string[] {
        return quarterMonths(quarter).filter((m) => m <= today.slice(0, 7))
}

const monthFormatter = new Intl.DateTimeFormat('en-GB', {
        month: 'long',
        year: 'numeric',
        timeZone: 'UTC',
})

/** "2026-10" -> "October 2026" */
export function monthLabel(period: string): string {
        const [year, month] = period.split('-').map(Number)
        if (!year || !month) return period
        return monthFormatter.format(new Date(Date.UTC(year, month - 1, 1)))
}

/** Exact decimal text, trimmed for display: "3.4000" -> "3.40", "3.4567" -> "3.4567". */
export function scoreText(value: string | null | undefined): string {
        if (value === null || value === undefined || value === '') return '—'
        const [whole, fraction = ''] = value.split('.')
        const trimmed = fraction.replace(/0+$/, '')
        return `${whole}.${trimmed.padEnd(2, '0')}`
}

/** The score that counts at this stage, and how firm it is. */
export function currentScore(result: ResultBrief): { text: string; note: string } {
        if (result.published_score !== null)
                return { text: scoreText(result.published_score), note: 'Final' }
        if (result.override_score !== null)
                return { text: scoreText(result.override_score), note: 'Approved override' }
        if (result.final_score !== null)
                return { text: scoreText(result.final_score), note: 'Calculated' }
        return { text: scoreText(result.calculated_score), note: 'Provisional (data missing)' }
}

export const RESULT_STATUS: Record<ScoreResultStatus, { label: string; tone: BadgeTone }> = {
        CALCULATED: { label: 'Calculated · awaiting review', tone: 'warning' },
        REVIEWED: { label: 'Reviewed · awaiting publication', tone: 'info' },
        PUBLISHED: { label: 'Published (final)', tone: 'success' },
        SUPERSEDED: { label: 'Superseded by a correction', tone: 'neutral' },
}

export const ITEM_STATUS: Record<ResultItemStatus, { label: string; tone: BadgeTone }> = {
        scored: { label: 'Scored', tone: 'success' },
        provisional: { label: 'Provisional', tone: 'warning' },
        no_data: { label: 'No data yet', tone: 'neutral' },
        error: { label: 'Cannot be scored', tone: 'danger' },
}

export const OVERRIDE_STATUS: Record<ScoreOverrideStatus, { label: string; tone: BadgeTone }> = {
        PENDING: { label: 'Awaiting approval', tone: 'warning' },
        APPLIED: { label: 'Approved and applied', tone: 'success' },
        REJECTED: { label: 'Rejected', tone: 'danger' },
        VOIDED: { label: 'Void (the data changed)', tone: 'neutral' },
}
