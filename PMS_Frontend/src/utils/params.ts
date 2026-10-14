import { isIsoDate } from './format'

/** A positive integer id from a URL segment or query value, else undefined. */
export function parseId(value: string | null | undefined): number | undefined {
        if (!value || !/^\d+$/.test(value)) return undefined
        const id = Number(value)
        return Number.isSafeInteger(id) && id > 0 ? id : undefined
}

/** A valid ISO date from the URL, else undefined (the server then uses today). */
export function parseIsoDate(value: string | null | undefined): string | undefined {
        return isIsoDate(value) ? value : undefined
}

export function parsePage(value: string | null | undefined): number {
        return parseId(value) ?? 1
}

/** Copy of `params` with the given keys set (or removed when empty). */
export function withParams(
        params: URLSearchParams,
        updates: Record<string, string | number | boolean | undefined | null>,
): URLSearchParams {
        const next = new URLSearchParams(params)
        for (const [key, value] of Object.entries(updates)) {
                if (value === undefined || value === null || value === '' || value === false)
                        next.delete(key)
                else next.set(key, String(value))
        }
        return next
}
