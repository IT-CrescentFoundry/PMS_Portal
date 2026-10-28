import type { BadgeTone } from '../../components/common/Badge'
import type { BudgetScenarioStatus, BudgetVariance, CompaRatioMethod } from '../../types/api'

export const CR_METHOD: Record<CompaRatioMethod, { label: string; detail: string }> = {
        MATRIX_INPUT: {
                label: 'Compa-ratio is an input of the increment matrix',
                detail: 'The increment matrix reads the rating and the compa-ratio directly.',
        },
        IMPACT_MULTIPLIER: {
                label: 'Increment × compa-ratio impact multiplier',
                detail: 'The increment matrix gives a base increment; a compa-ratio impact matrix gives the multiplier (output "increment_multiplier").',
        },
}

export const SCENARIO_STATUS: Record<BudgetScenarioStatus, { label: string; tone: BadgeTone }> = {
        CALCULATED: { label: 'Calculated', tone: 'neutral' },
        SUBMITTED: { label: 'Awaiting the CHRO', tone: 'warning' },
        FINALIZED: { label: 'Final budget', tone: 'success' },
        REJECTED: { label: 'Rejected', tone: 'danger' },
        SUPERSEDED: { label: 'Superseded', tone: 'neutral' },
}

export const VARIANCE_STATE: Record<BudgetVariance['state'], { label: string; tone: BadgeTone }> = {
        UNDER_BUDGET: { label: 'Within budget', tone: 'success' },
        ON_BUDGET: { label: 'Exactly on budget', tone: 'success' },
        OVER_BUDGET: { label: 'Over budget', tone: 'danger' },
}

export const EXCLUSIONS: Record<string, string> = {
        NO_ANNUAL_RESULT: 'No approved annual result',
        ANNUAL_UNDER_RECALCULATION: 'Annual result being recalculated',
        NOT_IN_BASELINE: 'Not in the salary baseline',
        NOT_ELIGIBLE: 'Not eligible',
        NO_SALARY: 'No current salary',
        NO_KRA_PERFORMANCE: 'No approved KRA performance matrix',
        NO_INCREMENT: 'No approved increment matrix',
        NO_CR_IMPACT: 'No approved compa-ratio impact matrix',
        MATRIX_CONFLICT: 'More than one matrix applies',
        MATRIX_UNREADABLE: 'Matrix content cannot be verified',
        MATRIX_INPUT_MISSING: 'A matrix input is missing',
        MATRIX_NO_RESULT: 'No matrix rule matched',
        NO_MULTIPLIER_OUTPUT: 'Impact matrix lacks the multiplier output',
}

export const MATRIX_TYPE_LABELS: Record<string, string> = {
        KRA_PERFORMANCE: 'KRA performance matrix',
        INCREMENT: 'Increment matrix',
        CR_IMPACT: 'Compa-ratio impact matrix',
}

/** {type: version id} for the explicitly chosen matrix versions, or null when none is chosen. */
export function chosenVersions(value: Record<string, string>): Record<string, number> | null {
        const chosen = Object.entries(value).filter(([, v]) => v)
        return chosen.length ? Object.fromEntries(chosen.map(([k, v]) => [k, Number(v)])) : null
}

/** "1234567.5" -> "1,234,567.50" (exact text, never via floating point). */
export function money(value: string | null | undefined, currency?: string): string {
        if (value === null || value === undefined || value === '') return '—'
        const negative = value.startsWith('-')
        const [whole, fraction = ''] = (negative ? value.slice(1) : value).split('.')
        const grouped = whole.replace(/\B(?=(\d{3})+(?!\d))/g, ',')
        const text = `${negative ? '−' : ''}${grouped}.${fraction.padEnd(2, '0').slice(0, Math.max(2, fraction.length))}`
        return currency ? `${currency} ${text}` : text
}

/** "7.5" -> "7.50 %" */
export function percent(value: string | null | undefined): string {
        if (value === null || value === undefined || value === '') return '—'
        const [whole, fraction = ''] = value.split('.')
        return `${whole}.${fraction.padEnd(2, '0')} %`
}
