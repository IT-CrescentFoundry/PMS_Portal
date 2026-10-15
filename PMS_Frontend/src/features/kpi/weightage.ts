/**
 * Weightage arithmetic in whole hundredths, so 33.33 + 33.33 + 33.34 is
 * exactly 100 (floating point would give 99.99999…). Mirrors the API rule:
 * up to two decimals, more than 0 and at most 100 each, total exactly 100.00
 * to publish.
 */

const WEIGHTAGE = /^\d{1,3}(\.\d{1,2})?$/

/** Hundredths for a valid entry ("12.5" -> 1250), else null. */
export function toCents(value: string): number | null {
        const text = value.trim()
        if (!WEIGHTAGE.test(text)) return null
        const [whole, fraction = ''] = text.split('.')
        const cents = Number(whole) * 100 + Number(fraction.padEnd(2, '0'))
        return cents > 0 && cents <= 10_000 ? cents : null
}

/** Problem with one weightage entry, or null when it is valid. */
export function weightageError(value: string): string | null {
        const text = value.trim()
        if (text === '') return 'Enter a weightage.'
        if (!/^\d+(\.\d+)?$/.test(text)) return 'Enter a number, e.g. 25 or 12.5.'
        if (/\.\d{3,}$/.test(text)) return 'Use at most two decimal places.'
        return toCents(text) === null ? 'Enter more than 0 and at most 100.' : null
}

export interface WeightSummary {
        /** Sum of the valid entries, in hundredths. */
        totalCents: number
        /** Every entry is valid and the total is exactly 100.00. */
        complete: boolean
        invalidCount: number
}

export function summarizeWeights(values: string[]): WeightSummary {
        let totalCents = 0
        let invalidCount = 0
        for (const value of values) {
                const cents = toCents(value)
                if (cents === null) invalidCount += 1
                else totalCents += cents
        }
        return {
                totalCents,
                complete: values.length > 0 && invalidCount === 0 && totalCents === 10_000,
                invalidCount,
        }
}

/** 9999 -> "99.99" */
export function formatCents(cents: number): string {
        return (cents / 100).toFixed(2)
}

/** API number -> editable text without float noise (33.33 -> "33.33", 40 -> "40"). */
export function weightageText(value: number): string {
        return String(Math.round(value * 100) / 100)
}

/** Advice on the total, in the words the KPI sheet shows. */
export function totalMessage(summary: WeightSummary): string {
        const diff = 10_000 - summary.totalCents
        if (summary.invalidCount > 0) return 'Fix the highlighted weightages.'
        if (diff === 0) return 'Weightages total 100%.'
        return diff > 0
                ? `${formatCents(diff)}% still to allocate.`
                : `${formatCents(-diff)}% over 100%.`
}
