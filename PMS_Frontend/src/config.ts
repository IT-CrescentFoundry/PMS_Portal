export const APP_NAME = 'PMS Portal'
const DEFAULT_API_BASE_URL = 'http://localhost:8000'

/**
 * Normalize the backend origin: trims whitespace and trailing slashes, and
 * drops a trailing "/api" so endpoint paths ("/api/...") are never doubled.
 */
export function normalizeBaseUrl(raw: string | undefined): string {
        const value = (raw ?? '').trim() || DEFAULT_API_BASE_URL
        return value.replace(/\/+$/, '').replace(/\/api$/i, '')
}

export const API_BASE_URL = normalizeBaseUrl(import.meta.env.VITE_API_BASE_URL)