/**
 * The single HTTP client for the PMS API.
 *
 * - Every request sends credentials ("include") so the browser attaches the
 *   HttpOnly session cookie. JavaScript never reads or stores the token, and
 *   no Authorization header is ever sent from the browser.
 * - Every failure becomes an ApiError with a safe, user-facing message.
 *   Server-side (5xx) details are never shown.
 * - A 401 on a protected request notifies the registered handler (the
 *   session provider), except for requests that handle 401 themselves.
 */
import { API_BASE_URL } from '../config'

export type QueryValue = string | number | boolean | null | undefined
export type Query = Record<string, QueryValue>

export interface FieldError {
        field: string
        message: string
}

/** One business-rule problem from a 422 {detail, issues} body, e.g. a weightage total. */
export interface Issue {
        message: string
        field: string | null
        /** Spreadsheet row, for Excel uploads. */
        row: number | null
}

export type ApiErrorKind = 'http' | 'network' | 'timeout' | 'invalid-response'

export class ApiError extends Error {
        readonly kind: ApiErrorKind
        /** HTTP status, or null when no response was received. */
        readonly status: number | null
        readonly fieldErrors: FieldError[]
        readonly issues: Issue[]

        constructor(
                kind: ApiErrorKind,
                status: number | null,
                message: string,
                fieldErrors: FieldError[] = [],
                issues: Issue[] = [],
        ) {
                super(message)
                this.name = 'ApiError'
                this.kind = kind
                this.status = status
                this.fieldErrors = fieldErrors
                this.issues = issues
        }

        /** Worth retrying: the server was unreachable, slow or failing. */
        get isRetryable(): boolean {
                return (
                        this.kind === 'network' ||
                        this.kind === 'timeout' ||
                        (this.status !== null && (this.status >= 500 || this.status === 429))
                )
        }
}

export const DEFAULT_TIMEOUT_MS = 15_000

const STATUS_MESSAGES: Record<number, string> = {
        400: 'The request could not be processed.',
        401: 'Your session has expired. Please sign in again.',
        403: 'You do not have permission to view this information.',
        404: 'This record was not found, or you do not have access to it.',
        422: 'Some of the information provided is not valid.',
        429: 'Too many requests. Please wait a moment and try again.',
}
const SERVER_ERROR_MESSAGE =
        'The PMS server could not complete the request. Please try again later.'
const NETWORK_ERROR_MESSAGE =
        'Cannot reach the PMS server. Check your connection, or ask an administrator whether the service is running.'
const TIMEOUT_MESSAGE = 'The PMS server took too long to respond. Please try again.'

let unauthorizedHandler: (() => void) | null = null

/**
 * CSRF token for the current session (from GET /api/auth/me), kept only in
 * memory. Sent as X-CSRF-Token on every state-changing request; the API
 * rejects cookie-authenticated writes without it.
 */
let csrfToken: string | null = null
export const CSRF_HEADER = 'X-CSRF-Token'

export function setCsrfToken(token: string | null): void {
        csrfToken = token
}

/** Register the session-expiry handler; returns an unregister function. */
export function setUnauthorizedHandler(handler: () => void): () => void {
        unauthorizedHandler = handler
        return () => {
                if (unauthorizedHandler === handler) unauthorizedHandler = null
        }
}

/** Build an absolute API URL. Empty, null, undefined and false values are omitted. */
export function buildUrl(path: string, query?: Query): string {
        if (!path.startsWith('/api/')) {
                throw new Error(`API paths must start with /api/ (got "${path}")`)
        }
        const url = new URL(API_BASE_URL + path)
        for (const [key, value] of Object.entries(query ?? {})) {
                if (value === undefined || value === null || value === '' || value === false)
                        continue
                url.searchParams.set(key, String(value))
        }
        return url.toString()
}

export function isAbortError(error: unknown): boolean {
        return error instanceof DOMException && error.name === 'AbortError'
}

interface RequestOptions {
        method?: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE'
        query?: Query
        /** Serialized as JSON; FormData is sent as multipart (file uploads). */
        body?: unknown
        signal?: AbortSignal
        timeoutMs?: number
        /** Do not trigger the global session-expiry handler on 401 (login, session check). */
        skipUnauthorizedHandler?: boolean
}

function isRecord(value: unknown): value is Record<string, unknown> {
        return typeof value === 'object' && value !== null
}

/** Pull a field-level list out of FastAPI's 422 body: {detail: [{loc, msg}]}. */
function parseFieldErrors(payload: unknown): FieldError[] {
        if (!isRecord(payload) || !Array.isArray(payload.detail)) return []
        return payload.detail.flatMap((item): FieldError[] => {
                if (!isRecord(item) || typeof item.msg !== 'string') return []
                const loc = Array.isArray(item.loc) ? item.loc : []
                const field = loc
                        .filter((part) => part !== 'body' && part !== 'query' && part !== 'path')
                        .join('.')
                return [{ field, message: item.msg }]
        })
}

/** Business-rule problems from the API's 422 body: {detail, issues: [{message, field, row}]}. */
function parseIssues(payload: unknown): Issue[] {
        if (!isRecord(payload) || !Array.isArray(payload.issues)) return []
        return payload.issues.flatMap((item): Issue[] => {
                if (!isRecord(item) || typeof item.message !== 'string') return []
                return [
                        {
                                message: item.message,
                                field: typeof item.field === 'string' ? item.field : null,
                                row: typeof item.row === 'number' ? item.row : null,
                        },
                ]
        })
}

async function toApiError(response: Response, isWrite: boolean): Promise<ApiError> {
        const status = response.status
        if (status >= 500) {
                // Never surface server internals; the body is ignored on purpose.
                return new ApiError('http', status, SERVER_ERROR_MESSAGE)
        }

        let payload: unknown = null
        if ((response.headers.get('content-type') ?? '').includes('application/json')) {
                try {
                        payload = await response.json()
                } catch {
                        payload = null
                }
        }
        const detail =
                isRecord(payload) && typeof payload.detail === 'string' ? payload.detail : null
        const issues = status === 422 ? parseIssues(payload) : []

        // 400/401 details from this API are short, user-facing sentences
        // (e.g. "Invalid username or password."). So are the reasons a change is
        // refused (403/409, e.g. "Only a draft sheet can be edited; reopen it
        // first.") and the summary above a list of issues. Other cases use fixed text.
        const explainsRefusal = isWrite && (status === 403 || status === 409)
        const useDetail =
                (status === 400 || status === 401 || explainsRefusal || issues.length > 0) &&
                detail !== null &&
                detail.length <= 300
        const message = useDetail
                ? detail
                : (STATUS_MESSAGES[status] ??
                  `Unexpected response from the server (status ${status}).`)
        return new ApiError(
                'http',
                status,
                message,
                status === 422 ? parseFieldErrors(payload) : [],
                issues,
        )
}

async function send(
        path: string,
        options: RequestOptions,
        accept: string,
): Promise<{ response: Response; signal?: AbortSignal }> {
        const {
                method = 'GET',
                query,
                body,
                signal,
                timeoutMs = DEFAULT_TIMEOUT_MS,
                skipUnauthorizedHandler = false,
        } = options

        const url = buildUrl(path, query)
        const controller = new AbortController()
        let timedOut = false
        const timer = setTimeout(() => {
                timedOut = true
                controller.abort()
        }, timeoutMs)
        const forwardAbort = () => controller.abort()
        if (signal?.aborted) controller.abort()
        signal?.addEventListener('abort', forwardAbort)

        // The browser sets the multipart boundary itself for FormData.
        const isForm = body instanceof FormData
        let response: Response
        try {
                response = await fetch(url, {
                        method,
                        credentials: 'include',
                        headers: {
                                Accept: accept,
                                ...(body !== undefined && !isForm
                                        ? { 'Content-Type': 'application/json' }
                                        : {}),
                                ...(method !== 'GET' && csrfToken
                                        ? { [CSRF_HEADER]: csrfToken }
                                        : {}),
                        },
                        body: isForm ? body : body !== undefined ? JSON.stringify(body) : undefined,
                        signal: controller.signal,
                })
        } catch (error) {
                if (timedOut) throw new ApiError('timeout', null, TIMEOUT_MESSAGE)
                if (signal?.aborted)
                        throw new DOMException('The request was cancelled.', 'AbortError')
                if (isAbortError(error)) throw error
                throw new ApiError('network', null, NETWORK_ERROR_MESSAGE)
        } finally {
                clearTimeout(timer)
                signal?.removeEventListener('abort', forwardAbort)
        }

        if (!response.ok) {
                const error = await toApiError(response, method !== 'GET')
                if (response.status === 401 && !skipUnauthorizedHandler) unauthorizedHandler?.()
                throw error
        }
        return { response, signal }
}

function unreadable(status: number, signal?: AbortSignal): Error {
        if (signal?.aborted) return new DOMException('The request was cancelled.', 'AbortError')
        return new ApiError(
                'invalid-response',
                status,
                'The PMS server sent a response that could not be read.',
        )
}

export async function apiRequest<T>(path: string, options: RequestOptions = {}): Promise<T> {
        const { response, signal } = await send(path, options, 'application/json')
        if (response.status === 204) return undefined as T
        try {
                return (await response.json()) as T
        } catch {
                throw unreadable(response.status, signal)
        }
}

/** Download a file (e.g. an Excel template) with the session cookie. */
export async function apiDownload(path: string, options: RequestOptions = {}): Promise<Blob> {
        const { response, signal } = await send(path, options, '*/*')
        try {
                return await response.blob()
        } catch {
                throw unreadable(response.status, signal)
        }
}

/** Offer a downloaded file to the user under `filename`. */
export function saveBlob(blob: Blob, filename: string): void {
        const url = URL.createObjectURL(blob)
        const link = document.createElement('a')
        link.href = url
        link.download = filename
        document.body.append(link)
        link.click()
        link.remove()
        setTimeout(() => URL.revokeObjectURL(url), 1000)
}
