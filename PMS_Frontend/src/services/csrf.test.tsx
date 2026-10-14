import { screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { adminUser, headcountReport, plants, units } from '../test/fixtures'
import { installMockApi, reply, type RecordedCall } from '../test/mockApi'
import { renderApp } from '../test/renderApp'
import { apiRequest, CSRF_HEADER, setCsrfToken } from './apiClient'

function csrfHeader(call: RecordedCall): string | undefined {
        return (call.init.headers as Record<string, string> | undefined)?.[CSRF_HEADER]
}

describe('CSRF token handling in the API client', () => {
        it('sends the token on state-changing requests only', async () => {
                const api = installMockApi({
                        'GET /api/plants': reply(200, []),
                        'POST /api/things': reply(200, {}),
                        'PUT /api/things': reply(200, {}),
                        'DELETE /api/things': reply(200, {}),
                })
                setCsrfToken('session-token-1')
                await apiRequest('/api/plants')
                await apiRequest('/api/things', { method: 'POST', body: {} })
                await apiRequest('/api/things', { method: 'PUT', body: {} })
                await apiRequest('/api/things', { method: 'DELETE' })
                expect(api.calls.map(csrfHeader)).toEqual([
                        undefined,
                        'session-token-1',
                        'session-token-1',
                        'session-token-1',
                ])
        })

        it('sends nothing once the token is cleared', async () => {
                const api = installMockApi({ 'POST /api/things': reply(200, {}) })
                setCsrfToken('session-token-1')
                setCsrfToken(null)
                await apiRequest('/api/things', { method: 'POST', body: {} })
                expect(csrfHeader(api.calls[0])).toBeUndefined()
        })
})

describe('CSRF token lifecycle with the session', () => {
        const dashboard = {
                'GET /api/plants': reply(200, plants),
                'GET /api/departments': reply(200, []),
                'GET /api/reports/headcount': reply(200, headcountReport()),
                'GET /api/org-units': reply(200, units),
        }

        it('uses the token from /me for writes, and forgets it after sign-out', async () => {
                const api = installMockApi({
                        'GET /api/auth/me': [
                                reply(200, adminUser),
                                reply(200, { ...adminUser, csrf_token: 'second-session' }),
                        ],
                        'POST /api/auth/logout': reply(204),
                        'POST /api/auth/login': reply(200, {
                                user: adminUser,
                                expires_at: '2030-01-01T00:00:00Z',
                        }),
                        ...dashboard,
                })
                const { user } = renderApp('/')
                await user.click(await screen.findByRole('button', { name: 'Sign out' }))
                await screen.findByText('You have been signed out.')
                expect(csrfHeader(api.callsTo('POST', '/api/auth/logout')[0])).toBe(
                        'csrf-admin-session',
                )

                // A new sign-in must not reuse the old session's token.
                await user.type(screen.getByLabelText('Username'), 'test.admin')
                await user.type(screen.getByLabelText('Password'), 'secret-password')
                await user.click(screen.getByRole('button', { name: 'Sign in' }))
                await screen.findByRole('heading', { name: 'Welcome, test.admin' })
                expect(csrfHeader(api.callsTo('POST', '/api/auth/login')[0])).toBeUndefined()

                await apiRequest('/api/auth/logout', { method: 'POST' })
                expect(csrfHeader(api.callsTo('POST', '/api/auth/logout')[1])).toBe(
                        'second-session',
                )
        })
})
