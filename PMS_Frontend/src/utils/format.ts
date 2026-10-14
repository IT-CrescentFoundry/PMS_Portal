const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})$/

/** True for a real calendar date in YYYY-MM-DD form. */
export function isIsoDate(value: string | null | undefined): value is string {
        const match = ISO_DATE.exec(value ?? '')
        if (!match) return false
        const [, y, m, d] = match.map(Number)
        const date = new Date(Date.UTC(y, m - 1, d))
        return (
                date.getUTCFullYear() === y &&
                date.getUTCMonth() === m - 1 &&
                date.getUTCDate() === d
        )
}

const dateFormatter = new Intl.DateTimeFormat('en-GB', {
        day: 'numeric',
        month: 'short',
        year: 'numeric',
        timeZone: 'UTC', // ISO dates are calendar dates; never shift them by time zone
})

/** "2026-04-01" -> "1 Apr 2026"; empty input -> the fallback. */
export function formatDate(value: string | null | undefined, fallback = '—'): string {
        if (!value) return fallback
        const iso = value.slice(0, 10)
        if (!isIsoDate(iso)) return value
        const [y, m, d] = iso.split('-').map(Number)
        return dateFormatter.format(new Date(Date.UTC(y, m - 1, d)))
}

/** Today's date in the user's local time zone, as YYYY-MM-DD. */
export function todayIso(now: Date = new Date()): string {
        const pad = (n: number) => String(n).padStart(2, '0')
        return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`
}

const numberFormatter = new Intl.NumberFormat('en-IN')

export function formatNumber(value: number): string {
        return numberFormatter.format(value)
}

/** "1 employee" / "3 employees" */
export function plural(count: number, singular: string, pluralForm = `${singular}s`): string {
        return `${formatNumber(count)} ${count === 1 ? singular : pluralForm}`
}
