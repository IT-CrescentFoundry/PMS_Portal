import { afterEach, describe, expect, it, vi } from 'vitest'
import { normalizeBaseUrl } from '../config'
import { installMockApi, json, networkFailure, reply } from '../test/mockApi'
import { ApiError, apiRequest, buildUrl, isAbortError, setUnauthorizedHandler } from './apiClient'

async function captureError(promise: Promise<unknown>): Promise<unknown> {
        try {
                await promise
        } catch (error) {
                return error
        }
        throw new Error('Expected the request to fail')
}

describe('normalizeBaseUrl', () => {
        it.each([
                ['http://localhost:8000', 'http://localhost:8000'],
                ['http://localhost:8000/', 'http://localhost:8000'],
                ['http://localhost:8000///', 'http://localhost:8000'],
                ['http://localhost:8000/api', 'http://localhost:8000'],
                ['http://localhost:8000/api/', 'http://localhost:8000'],
                ['  http://localhost:8000  ', 'http://localhost:8000'],
                [undefined, 'http://localhost:8000'],
                ['', 'http://localhost:8000'],
        ])('%s -> %s', (input, expected) => {
                expect(normalizeBaseUrl(input)).toBe(expected)
        })
})

describe('buildUrl', () => {
        it('joins the base URL and path without doubling /api', () => {
                expect(buildUrl('/api/plants')).toBe('http://localhost:8000/api/plants')
        })

        it('omits empty, null, undefined and false values and encodes the rest', () => {
                const url = new URL(
                        buildUrl('/api/employees', {
                                search: 'a&b c',
                                plant_id: 3,
                                department_id: undefined,
                                as_of: null,
                                include_inactive: false,
                                primary_only: true,
                                q: '',
                        }),
                )
                expect([...url.searchParams.keys()].sort()).toEqual([
                        'plant_id',
                        'primary_only',
                        'search',
                ])
                expect(url.searchParams.get('search')).toBe('a&b c')
                expect(url.searchParams.get('primary_only')).toBe('true')
        })

        it('rejects paths outside the API', () => {
                expect(() => buildUrl('plants')).toThrow()
                expect(() => buildUrl('/plants')).toThrow()
        })
})

describe('apiRequest', () => {
        afterEach(() => vi.useRealTimers())

        it('always sends credentials and never an Authorization header', async () => {
                const api = installMockApi({ 'GET /api/plants': reply(200, []) })
                await apiRequest('/api/plants')
                const init = api.calls[0].init
                expect(init.credentials).toBe('include')
                expect(Object.keys(init.headers ?? {}).map((h) => h.toLowerCase())).not.toContain(
                        'authorization',
                )
        })

        it('sends a JSON body on POST', async () => {
                const api = installMockApi({ 'POST /api/auth/login': reply(200, { ok: true }) })
                await apiRequest('/api/auth/login', {
                        method: 'POST',
                        body: { username: 'u', password: 'p' },
                })
                const { init } = api.calls[0]
                expect(init.method).toBe('POST')
                expect(init.body).toBe(JSON.stringify({ username: 'u', password: 'p' }))
                expect((init.headers as Record<string, string>)['Content-Type']).toBe(
                        'application/json',
                )
        })

        it('returns undefined for 204 No Content', async () => {
                installMockApi({ 'POST /api/auth/logout': reply(204) })
                await expect(
                        apiRequest('/api/auth/logout', { method: 'POST' }),
                ).resolves.toBeUndefined()
        })

        it.each([
                [400, { detail: 'Bad thing.' }, 'Bad thing.'],
                [401, { detail: 'Invalid username or password.' }, 'Invalid username or password.'],
                [
                        403,
                        { detail: 'internal role list' },
                        'You do not have permission to view this information.',
                ],
                [
                        404,
                        { detail: 'Plant 7 not found' },
                        'This record was not found, or you do not have access to it.',
                ],
                [429, undefined, 'Too many requests. Please wait a moment and try again.'],
        ])('maps HTTP %i to a safe message', async (status, body, message) => {
                installMockApi({ 'GET /api/plants': reply(status, body) })
                const error = await captureError(apiRequest('/api/plants'))
                expect(error).toBeInstanceOf(ApiError)
                expect((error as ApiError).status).toBe(status)
                expect((error as ApiError).message).toBe(message)
        })

        it('never shows server error details for 5xx, even non-JSON bodies', async () => {
                installMockApi({
                        'GET /api/plants': () =>
                                new Response(
                                        'Traceback: sqlalchemy.exc.OperationalError at db-host:3306',
                                        { status: 500 },
                                ),
                })
                const error = (await captureError(apiRequest('/api/plants'))) as ApiError
                expect(error.status).toBe(500)
                expect(error.message).not.toMatch(/Traceback|sqlalchemy|3306/)
                expect(error.isRetryable).toBe(true)
        })

        it('collects field errors from a 422 response', async () => {
                installMockApi({
                        'GET /api/employees': reply(422, {
                                detail: [
                                        {
                                                loc: ['query', 'limit'],
                                                msg: 'Input should be greater than or equal to 1',
                                        },
                                ],
                        }),
                })
                const error = (await captureError(apiRequest('/api/employees'))) as ApiError
                expect(error.fieldErrors).toEqual([
                        { field: 'limit', message: 'Input should be greater than or equal to 1' },
                ])
        })

        it('reports an unreachable server as a retryable network error', async () => {
                installMockApi({ 'GET /api/plants': networkFailure })
                const error = (await captureError(apiRequest('/api/plants'))) as ApiError
                expect(error.kind).toBe('network')
                expect(error.status).toBeNull()
                expect(error.isRetryable).toBe(true)
        })

        it('times out slow requests', async () => {
                vi.useFakeTimers()
                installMockApi({
                        'GET /api/plants': ({ init }) =>
                                new Promise((_, reject) =>
                                        init.signal?.addEventListener('abort', () =>
                                                reject(new DOMException('aborted', 'AbortError')),
                                        ),
                                ),
                })
                const pending = captureError(apiRequest('/api/plants', { timeoutMs: 1000 }))
                await vi.advanceTimersByTimeAsync(1000)
                const error = (await pending) as ApiError
                expect(error.kind).toBe('timeout')
        })

        it('rethrows caller cancellation as an AbortError (not an error to display)', async () => {
                installMockApi({
                        'GET /api/plants': ({ init }) =>
                                new Promise((_, reject) =>
                                        init.signal?.addEventListener('abort', () =>
                                                reject(new DOMException('aborted', 'AbortError')),
                                        ),
                                ),
                })
                const controller = new AbortController()
                const pending = captureError(
                        apiRequest('/api/plants', { signal: controller.signal }),
                )
                controller.abort()
                expect(isAbortError(await pending)).toBe(true)
        })

        it('reports an unreadable success body', async () => {
                installMockApi({
                        'GET /api/plants': () => new Response('not json', { status: 200 }),
                })
                const error = (await captureError(apiRequest('/api/plants'))) as ApiError
                expect(error.kind).toBe('invalid-response')
        })

        it('notifies the session handler on 401, except when the caller opts out', async () => {
                installMockApi({
                        'GET /api/plants': reply(401, { detail: 'Not authenticated' }),
                        'GET /api/auth/me': reply(401),
                })
                const handler = vi.fn()
                const unregister = setUnauthorizedHandler(handler)
                await captureError(apiRequest('/api/plants'))
                expect(handler).toHaveBeenCalledTimes(1)
                await captureError(apiRequest('/api/auth/me', { skipUnauthorizedHandler: true }))
                expect(handler).toHaveBeenCalledTimes(1)
                unregister()
        })

        it('parses JSON error bodies only when declared as JSON', async () => {
                installMockApi({
                        'GET /api/plants': () => new Response('{"detail":"x"}', { status: 400 }),
                })
                const error = (await captureError(apiRequest('/api/plants'))) as ApiError
                expect(error.message).toBe('The request could not be processed.')
                // sanity: a JSON response is parsed
                installMockApi({ 'GET /api/plants': () => json(400, { detail: 'Readable.' }) })
                expect(((await captureError(apiRequest('/api/plants'))) as ApiError).message).toBe(
                        'Readable.',
                )
        })
})
