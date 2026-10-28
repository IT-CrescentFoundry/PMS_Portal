import { expect, request, type APIRequestContext, type Page } from '@playwright/test'

/** The isolated e2e API (see playwright.config.ts), never the development one. */
export const API_ORIGIN = process.env.PMS_E2E_API_ORIGIN ?? 'http://localhost:8001'

/** Per-run password of the synthetic accounts, set by playwright.config.ts. */
export function e2ePassword(): string {
        const value = process.env.PMS_E2E_PASSWORD
        if (!value)
                throw new Error(
                        'PMS_E2E_PASSWORD is not set; run the tests with `npm run test:e2e`.',
                )
        return value
}

export async function signIn(page: Page, username: string): Promise<void> {
        await page.goto('/login')
        await page.getByLabel('Username').fill(username)
        await page.getByLabel('Password', { exact: true }).fill(e2ePassword())
        await page.getByRole('button', { name: 'Sign in' }).click()
        await expect(page.getByRole('button', { name: 'Sign out' })).toBeVisible()
}

export async function signOut(page: Page): Promise<void> {
        await page.getByRole('button', { name: 'Sign out' }).click()
        await expect(page.getByText('You have been signed out.')).toBeVisible()
}

/** Look up ids through the API as an administrator (not via the browser). */
export async function adminLookup() {
        const api = await request.newContext({ baseURL: API_ORIGIN })
        const login = await api.post('/api/auth/login', {
                data: { username: 'demo.admin', password: e2ePassword() },
        })
        expect(login.ok()).toBe(true)
        const plants: { id: number; code: string }[] = await (await api.get('/api/plants')).json()
        const employees: { items: { id: number; employee_code: string }[] } = await (
                await api.get('/api/employees', { params: { limit: 200 } })
        ).json()
        await api.dispose()
        return {
                plantId: (code: string) => plants.find((p) => p.code === code)!.id,
                employeeId: (code: string) =>
                        employees.items.find((e) => e.employee_code === code)!.id,
        }
}

/** The id of an employee's KPI sheet in a quarter of the demo cycle, looked up through the API. */
export async function sheetIdOf(
        username: string,
        quarterNumber: number,
        employeeCode: string,
): Promise<number> {
        const api = await request.newContext({ baseURL: API_ORIGIN })
        const login = await api.post('/api/auth/login', {
                data: { username, password: e2ePassword() },
        })
        expect(login.ok()).toBe(true)
        const quarters: {
                id: number
                quarter_number: number
                status: string
                cycle_code: string
        }[] = await (await api.get('/api/kpi/quarters')).json()
        // The demo cycle's quarter: per-run cycles ("E2E-…") start on the same date,
        // so the list order alone doesn't tell them apart.
        const quarter = quarters.find(
                (q) => q.quarter_number === quarterNumber && !q.cycle_code.startsWith('E2E'),
        )!
        const sheets: {
                rows: {
                        assignment: { employee: { employee_code: string } }
                        sheet: { id: number } | null
                }[]
        } = await (await api.get('/api/kpi/sheets', { params: { quarter_id: quarter.id } })).json()
        await api.dispose()
        const row = sheets.rows.find((r) => r.assignment.employee.employee_code === employeeCode)
        expect(row?.sheet).toBeTruthy()
        return row!.sheet!.id
}

/**
 * Collect console errors raised by the application. The browser's own
 * "Failed to load resource" lines for expected 401/403/404 API responses
 * are network logs, not application errors, and are excluded.
 */
export function collectConsoleErrors(page: Page): string[] {
        const errors: string[] = []
        page.on('console', (message) => {
                if (message.type() !== 'error') return
                if (message.text().startsWith('Failed to load resource')) return
                errors.push(message.text())
        })
        page.on('pageerror', (error) => errors.push(error.message))
        return errors
}

/** An API client signed in (bearer token) as one of the synthetic accounts. */
export async function apiAs(username: string): Promise<APIRequestContext> {
        const anonymous = await request.newContext({ baseURL: API_ORIGIN })
        const login = await anonymous.post('/api/auth/token', {
                form: { username, password: e2ePassword() },
        })
        expect(login.ok()).toBe(true)
        const { access_token } = (await login.json()) as { access_token: string }
        await anonymous.dispose()
        return request.newContext({
                baseURL: API_ORIGIN,
                extraHTTPHeaders: { Authorization: `Bearer ${access_token}` },
        })
}

export async function ok<T = unknown>(
        response: Awaited<ReturnType<APIRequestContext['get']>>,
): Promise<T> {
        expect(response.ok(), await response.text()).toBe(true)
        return (await response.json()) as T
}

/** A four-quarter cycle seeded for this run with DEMO0005's locked sheets (e2e_server.py). */
export interface RunCycle {
        cycleId: number
        cycleName: string
        quarters: { id: number; name: string }[]
        sheets: number[] // DEMO0005's sheet in each quarter
        employeeId: number
}

/** The newest seeded cycle whose code starts with `prefix` (e.g. "E2E-A"). */
export async function findRunCycle(api: APIRequestContext, prefix: string): Promise<RunCycle> {
        const cycles = await ok<
                {
                        id: number
                        code: string
                        name: string
                        quarters: { id: number; name: string; quarter_number: number }[]
                }[]
        >(await api.get('/api/annual/cycles'))
        const cycle = cycles.filter((c) => c.code.startsWith(prefix)).sort((a, b) => b.id - a.id)[0]
        expect(cycle).toBeTruthy()
        const quarters = [...cycle.quarters].sort((a, b) => a.quarter_number - b.quarter_number)
        const sheets: number[] = []
        let employeeId = 0
        for (const q of quarters) {
                const list = await ok<{
                        rows: {
                                assignment: { employee: { id: number; employee_code: string } }
                                sheet: { id: number } | null
                        }[]
                }>(await api.get('/api/kpi/sheets', { params: { quarter_id: q.id } }))
                const row = list.rows.find(
                        (r) => r.sheet && r.assignment.employee.employee_code === 'DEMO0005',
                )!
                sheets.push(row.sheet!.id)
                employeeId = row.assignment.employee.id
        }
        return {
                cycleId: cycle.id,
                cycleName: cycle.name,
                quarters: quarters.map((q) => ({ id: q.id, name: q.name })),
                sheets,
                employeeId,
        }
}

/**
 * Takes one run quarter from data collection to publication through the API,
 * with DEMO0005's synthetic monthly values (the quarterly workflow itself is
 * covered in the browser by quarterly.spec.ts).
 */
export async function publishDemoQuarter(
        api: APIRequestContext,
        quarterId: number,
        sheetId: number,
        [month, dispatch, productivity]: [string, string, string],
): Promise<void> {
        const csv = [
                'Employee Code,Plant Code,Department Code,KPI,Period,Actual',
                `DEMO0005,PLT-A,PROD,KPI-D02,${month},${dispatch}`,
                `DEMO0005,PLT-A,PROD,KPI-D06,${month},${productivity}`,
        ].join('\n')
        await ok(
                await api.post('/api/kpi/data/confirm', {
                        multipart: {
                                quarter_id: String(quarterId),
                                period: month,
                                file: {
                                        name: `e2e-${month}.csv`,
                                        mimeType: 'text/csv',
                                        buffer: Buffer.from(csv),
                                },
                        },
                }),
        )
        await ok(await api.post('/api/kpi/results/calculate', { data: { quarter_id: quarterId } }))
        const step = (to: string) =>
                api.post(`/api/kpi/quarters/${quarterId}/transition`, {
                        data: { to, reason: null },
                })
        await ok(await step('DEPARTMENT_REVIEW'))
        await ok(await api.post(`/api/kpi/results/${sheetId}/review`))
        await ok(await step('NORMALIZATION'))
        const cohorts = await ok<{ id: number }[]>(
                await api.get(`/api/kpi/quarters/${quarterId}/normalization`),
        )
        for (const c of cohorts)
                await ok(
                        await api.post(`/api/kpi/normalization-runs/${c.id}/approve`, { data: {} }),
                )
        await ok(await step('READY'))
        await ok(await api.post(`/api/kpi/quarters/${quarterId}/publish`))
}
