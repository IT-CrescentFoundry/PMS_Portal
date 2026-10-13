import { screen, waitFor, within } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { adminUser, employeeOnlyUser, headcountReport, plants, units } from '../../test/fixtures'
import { installMockApi, networkFailure, reply } from '../../test/mockApi'
import { renderApp } from '../../test/renderApp'
import { safeReturnPath } from './permissions'

const dashboardRoutes = {
        'GET /api/plants': reply(200, plants),
        'GET /api/departments': reply(200, []),
        'GET /api/reports/headcount': reply(200, headcountReport()),
        'GET /api/org-units': reply(200, units),
}

describe('session restoration', () => {
        it('restores a valid session on start-up without asking to sign in', async () => {
                installMockApi({ 'GET /api/auth/me': reply(200, adminUser), ...dashboardRoutes })
                renderApp('/')
                expect(screen.getByText('Checking your session…')).toBeInTheDocument()
                expect(await screen.findByRole('heading', { level: 1, name: 'Welcome, test.admin' })).toBeInTheDocument()
        })

        it('sends an unauthenticated visitor to the sign-in page', async () => {
                const api = installMockApi({ 'GET /api/auth/me': reply(401, { detail: 'Not authenticated' }) })
                renderApp('/plants')
                expect(await screen.findByRole('heading', { name: 'Sign in to PMS Portal' })).toBeInTheDocument()
                // No protected data was requested before the session was known.
                expect(api.callsTo('GET', '/api/plants')).toHaveLength(0)
        })

        it('distinguishes an unreachable server from a missing session, and Retry recovers', async () => {
                installMockApi({
                        'GET /api/auth/me': [networkFailure, reply(200, adminUser)],
                        ...dashboardRoutes,
                })
                const { user } = renderApp('/')
                expect(await screen.findByRole('heading', { name: 'PMS Portal is unavailable' })).toBeInTheDocument()
                expect(screen.getByText(/have not been signed out/)).toBeInTheDocument()
                await user.click(screen.getByRole('button', { name: 'Retry' }))
                expect(await screen.findByRole('heading', { name: 'Welcome, test.admin' })).toBeInTheDocument()
        })
})

describe('login', () => {
        it('validates required fields without calling the API', async () => {
                const api = installMockApi({ 'GET /api/auth/me': reply(401) })
                const { user } = renderApp('/login')
                await user.click(await screen.findByRole('button', { name: 'Sign in' }))
                expect(screen.getByText('Enter your username.')).toBeInTheDocument()
                expect(screen.getByText('Enter your password.')).toBeInTheDocument()
                expect(api.callsTo('POST', '/api/auth/login')).toHaveLength(0)
        })

        it('shows a form error for wrong credentials and stays on the page (no redirect loop)', async () => {
                const api = installMockApi({
                        'GET /api/auth/me': reply(401),
                        'POST /api/auth/login': reply(401, { detail: 'Invalid username or password.' }),
                })
                const { user } = renderApp('/login')
                await user.type(await screen.findByLabelText('Username'), 'test.admin')
                await user.type(screen.getByLabelText('Password'), 'wrong-password')
                await user.click(screen.getByRole('button', { name: 'Sign in' }))

                const alert = await screen.findByRole('alert')
                expect(within(alert).getByText(/username or password is incorrect/)).toBeInTheDocument()
                expect(screen.getByLabelText('Password')).toHaveValue('')
                expect(api.callsTo('GET', '/api/auth/me')).toHaveLength(1) // only the start-up check
        })

        it('signs in with the browser endpoint, loads the user, and returns to the requested page', async () => {
                const api = installMockApi({
                        'GET /api/auth/me': [reply(401), reply(200, adminUser)],
                        'POST /api/auth/login': reply(200, { user: adminUser, expires_at: '2030-01-01T00:00:00Z' }),
                        ...dashboardRoutes,
                })
                const { user } = renderApp('/plants')
                await user.type(await screen.findByLabelText('Username'), '  test.admin ')
                await user.type(screen.getByLabelText('Password'), 'secret-password')
                await user.click(screen.getByRole('button', { name: 'Sign in' }))

                expect(await screen.findByRole('heading', { level: 1, name: 'Plants' })).toBeInTheDocument()
                const [loginCall] = api.callsTo('POST', '/api/auth/login')
                expect(JSON.parse(String(loginCall.init.body))).toEqual({
                        username: 'test.admin',
                        password: 'secret-password',
                })
                expect(api.callsTo('GET', '/api/auth/me')).toHaveLength(2) // start-up + after login
                // Session lives only in the HttpOnly cookie: nothing stored, no bearer header.
                expect(localStorage.length + sessionStorage.length).toBe(0)
                for (const call of api.calls) {
                        expect(call.init.credentials).toBe('include')
                        const headers = Object.keys(call.init.headers ?? {}).map((h) => h.toLowerCase())
                        expect(headers).not.toContain('authorization')
                }
        })

        it('explains when the browser did not keep the session cookie', async () => {
                installMockApi({
                        'GET /api/auth/me': reply(401),
                        'POST /api/auth/login': reply(200, { user: adminUser, expires_at: '2030-01-01T00:00:00Z' }),
                })
                const { user } = renderApp('/login')
                await user.type(await screen.findByLabelText('Username'), 'test.admin')
                await user.type(screen.getByLabelText('Password'), 'secret-password')
                await user.click(screen.getByRole('button', { name: 'Sign in' }))
                expect(await screen.findByText(/did not keep the session/)).toBeInTheDocument()
        })
})

describe('logout and expiry', () => {
        it('signs out through the API and shows the sign-in page', async () => {
                const api = installMockApi({
                        'GET /api/auth/me': reply(200, adminUser),
                        'POST /api/auth/logout': reply(204),
                        ...dashboardRoutes,
                })
                const { user } = renderApp('/')
                await user.click(await screen.findByRole('button', { name: 'Sign out' }))
                expect(await screen.findByText('You have been signed out.')).toBeInTheDocument()
                expect(api.callsTo('POST', '/api/auth/logout')[0].init.credentials).toBe('include')
        })

        it('does not claim to have signed out when the server could not be reached', async () => {
                installMockApi({
                        'GET /api/auth/me': reply(200, adminUser),
                        'POST /api/auth/logout': networkFailure,
                        ...dashboardRoutes,
                })
                const { user } = renderApp('/')
                await user.click(await screen.findByRole('button', { name: 'Sign out' }))
                expect(await screen.findByText('Sign-out could not be confirmed')).toBeInTheDocument()
                expect(screen.getByText(/may still be signed in/)).toBeInTheDocument()
                expect(screen.getByRole('heading', { name: 'Welcome, test.admin' })).toBeInTheDocument()
        })

        it('returns to sign-in with an explanation when the session expires mid-use', async () => {
                installMockApi({
                        'GET /api/auth/me': reply(200, adminUser),
                        'GET /api/plants': reply(401, { detail: 'Invalid or expired token' }),
                        'GET /api/org-units': reply(401, { detail: 'Invalid or expired token' }),
                })
                renderApp('/plants')
                expect(await screen.findByText('Your session has expired')).toBeInTheDocument()
                expect(screen.getByRole('heading', { name: 'Sign in to PMS Portal' })).toBeInTheDocument()
        })
})

describe('role-aware navigation', () => {
        it('hides organization pages from users without organizational access', async () => {
                installMockApi({ 'GET /api/auth/me': reply(200, employeeOnlyUser) })
                const { user } = renderApp('/')
                const nav = await screen.findByRole('navigation', { name: 'Main' })
                expect(within(nav).queryByRole('link', { name: 'Plants' })).not.toBeInTheDocument()
                expect(within(nav).getByRole('link', { name: 'My employee record' })).toBeInTheDocument()
                expect(screen.getByText('Your employee record')).toBeInTheDocument()
                // Typing the URL still shows a clear denial (the API would refuse too).
                await user.click(within(nav).getByRole('link', { name: 'My profile' }))
                expect(await screen.findByRole('heading', { name: 'My profile' })).toBeInTheDocument()
        })

        it('shows an access-denied page for organization URLs', async () => {
                const api = installMockApi({ 'GET /api/auth/me': reply(200, employeeOnlyUser) })
                renderApp('/plants')
                expect(await screen.findByRole('heading', { name: 'Access denied' })).toBeInTheDocument()
                expect(api.callsTo('GET', '/api/plants')).toHaveLength(0)
        })
})

describe('safeReturnPath', () => {
        it.each([
                ['/plants?x=1', '/plants?x=1'],
                ['//evil.example', '/'],
                ['/\\evil.example', '/'],
                ['https://evil.example', '/'],
                ['/login', '/'],
                [undefined, '/'],
        ])('%s -> %s', (input, expected) => {
                expect(safeReturnPath(input)).toBe(expected)
        })
})

describe('page states', () => {
        it('shows a retryable error when plants cannot be loaded, then recovers', async () => {
                installMockApi({
                        'GET /api/auth/me': reply(200, adminUser),
                        'GET /api/plants': [networkFailure, reply(200, plants)],
                        'GET /api/org-units': reply(200, units),
                })
                const { user } = renderApp('/plants')
                expect(await screen.findByText('Server unreachable')).toBeInTheDocument()
                await user.click(screen.getByRole('button', { name: 'Retry' }))
                expect(await screen.findByRole('link', { name: 'Test Plant A' })).toBeInTheDocument()
        })

        it('shows the API permission error without inventing details', async () => {
                installMockApi({
                        'GET /api/auth/me': reply(200, adminUser),
                        'GET /api/plants': reply(403, { detail: 'You do not have access to organizational data.' }),
                        'GET /api/org-units': reply(403, { detail: 'x' }),
                })
                renderApp('/plants')
                expect(await screen.findByText('Access denied')).toBeInTheDocument()
                expect(screen.queryByRole('button', { name: 'Retry' })).not.toBeInTheDocument()
        })

        it('shows an empty state when no plants are accessible', async () => {
                installMockApi({
                        'GET /api/auth/me': reply(200, adminUser),
                        'GET /api/plants': reply(200, []),
                        'GET /api/org-units': reply(200, []),
                })
                renderApp('/plants')
                expect(await screen.findByText('No plants in your access')).toBeInTheDocument()
        })

        it('treats an out-of-scope or missing record the same way (404)', async () => {
                installMockApi({
                        'GET /api/auth/me': reply(200, adminUser),
                        'GET /api/plants/99': reply(404, { detail: 'Plant 99 not found' }),
                        'GET /api/reports/headcount': reply(404, { detail: 'Plant 99 not found' }),
                })
                renderApp('/plants/99')
                expect(await screen.findByText('Not available')).toBeInTheDocument()
                expect(screen.getByText(/not found, or you do not have access/)).toBeInTheDocument()
        })

        it('does not call the API for malformed ids', async () => {
                const api = installMockApi({ 'GET /api/auth/me': reply(200, adminUser) })
                renderApp('/plants/abc')
                expect(await screen.findByText('This link is not valid')).toBeInTheDocument()
                await waitFor(() => expect(api.calls.every((c) => !c.path.startsWith('/api/plants'))).toBe(true))
        })
})
