import { describe, expect, it } from 'vitest'
import { installMockApi, reply } from '../test/mockApi'
import { ApiError, apiDownload, apiRequest, CSRF_HEADER, setCsrfToken } from './apiClient'

async function captureError(promise: Promise<unknown>): Promise<ApiError> {
        try {
                await promise
        } catch (error) {
                return error as ApiError
        }
        throw new Error('Expected the request to fail')
}

describe('API client: changes, uploads and downloads', () => {
        it('collects business-rule issues (with spreadsheet rows) from a 422', async () => {
                installMockApi({
                        'PUT /api/kpi/sheets/9': reply(422, {
                                detail: 'Please correct the problems listed.',
                                issues: [
                                        {
                                                message: 'Weightages total 99.99 %; they must total exactly 100 %.',
                                                field: 'weightage',
                                                row: null,
                                        },
                                        {
                                                message: 'Employee T9 not found or inactive.',
                                                field: 'employee_code',
                                                row: 4,
                                        },
                                ],
                        }),
                })
                const error = await captureError(
                        apiRequest('/api/kpi/sheets/9', { method: 'PUT', body: {} }),
                )
                expect(error.status).toBe(422)
                expect(error.message).toBe('Please correct the problems listed.')
                expect(error.issues).toEqual([
                        {
                                message: 'Weightages total 99.99 %; they must total exactly 100 %.',
                                field: 'weightage',
                                row: null,
                        },
                        {
                                message: 'Employee T9 not found or inactive.',
                                field: 'employee_code',
                                row: 4,
                        },
                ])
        })

        it('explains why a change was refused (403/409 on writes)', async () => {
                installMockApi({
                        'POST /api/kpi/sheets/9/publish': reply(409, {
                                detail: 'Only a draft sheet can be edited; reopen it first.',
                        }),
                        'POST /api/kpi/deviations/3/approve': reply(403, {
                                detail: 'The requester cannot approve their own deviation.',
                        }),
                })
                expect(
                        (
                                await captureError(
                                        apiRequest('/api/kpi/sheets/9/publish', { method: 'POST' }),
                                )
                        ).message,
                ).toBe('Only a draft sheet can be edited; reopen it first.')
                expect(
                        (
                                await captureError(
                                        apiRequest('/api/kpi/deviations/3/approve', {
                                                method: 'POST',
                                                body: {},
                                        }),
                                )
                        ).message,
                ).toBe('The requester cannot approve their own deviation.')
        })

        it('keeps fixed wording for a refused read', async () => {
                installMockApi({
                        'GET /api/kpi/sheets/9': reply(403, { detail: 'internal detail' }),
                })
                expect((await captureError(apiRequest('/api/kpi/sheets/9'))).message).toBe(
                        'You do not have permission to view this information.',
                )
        })

        it('sends FormData as multipart (browser-set boundary) with the CSRF token', async () => {
                const api = installMockApi({
                        'POST /api/kpi/uploads/preview': reply(200, { ok: true }),
                })
                setCsrfToken('session-token')
                const form = new FormData()
                form.append('quarter_id', '41')
                await apiRequest('/api/kpi/uploads/preview', { method: 'POST', body: form })
                const { init } = api.calls[0]
                const headers = init.headers as Record<string, string>
                expect(init.body).toBe(form)
                expect(Object.keys(headers).map((h) => h.toLowerCase())).not.toContain(
                        'content-type',
                )
                expect(headers[CSRF_HEADER]).toBe('session-token')
                expect(init.credentials).toBe('include')
        })

        it('downloads files with the session cookie', async () => {
                const api = installMockApi({
                        'GET /api/kpi/uploads/template': () =>
                                new Response('xlsx-bytes', {
                                        status: 200,
                                        headers: { 'Content-Type': 'application/octet-stream' },
                                }),
                })
                const blob = await apiDownload('/api/kpi/uploads/template')
                expect(await blob.text()).toBe('xlsx-bytes')
                expect(api.calls[0].init.credentials).toBe('include')
        })
})
