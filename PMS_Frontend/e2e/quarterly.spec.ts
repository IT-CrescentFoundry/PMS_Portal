/**
 * Stage L: one quarter from monthly data to published scores, on the isolated
 * e2e database only.
 *
 * Repeatable: the e2e server seeds a fresh quarter for every run ("E2E Q
 * <timestamp>", April–June 2026, data collection, locked sheets for five
 * Quality assignments; see PMS_Backend/tests/e2e_server.py). The synthetic
 * values below are designed so the outcome is known in advance:
 *
 *   DEMO0002 (Plant A)            5.00
 *   DEMO0001 (Plant A, primary)   4.20  } weighted 70 / 30 -> 4.05
 *   DEMO0001 (Plant B)            3.70  }
 *   DEMO0003 (Plant B)            2.20  } tied at the middle / bottom boundary
 *   DEMO0012 (Plant C)            2.20  }
 *
 * The demo normalization policy (synthetic: 20/60/20, ties placed by a
 * reviewer, example ratings 5/3/1) gives targets 1 / 2 / 1 for four people.
 */
import { expect, request, test, type Page } from '@playwright/test'
import { API_ORIGIN, collectConsoleErrors, e2ePassword, signIn, signOut } from './helpers'

const MONTHS = ['2026-04', '2026-05', '2026-06']
const MONTH_NAMES = ['April 2026', 'May 2026', 'June 2026']

// (employee, plant) -> [KPI-D01 profit, KPI-D04 claims, KPI-D07 rejection %] for each month.
const VALUES: [string, string, string[][]][] = [
        [
                'DEMO0001',
                'PLT-A',
                [
                        ['30', '30', '35'],
                        ['0', '0', '0'],
                        ['2.6', '2.6', '2.6'],
                ],
        ],
        [
                'DEMO0001',
                'PLT-B',
                [
                        ['28', '28', '29'],
                        ['0', '0', '0'],
                        ['2.6', '2.6', '2.6'],
                ],
        ],
        [
                'DEMO0002',
                'PLT-A',
                [
                        ['35', '35', '35'],
                        ['0', '0', '0'],
                        ['2.0', '2.0', '2.0'],
                ],
        ],
        [
                'DEMO0003',
                'PLT-B',
                [
                        ['25', '25', '25'],
                        ['0', '1', '0'],
                        ['2.6', '2.6', '2.6'],
                ],
        ],
        [
                'DEMO0012',
                'PLT-C',
                [
                        ['25', '25', '25'],
                        ['0', '1', '0'],
                        ['2.6', '2.6', '2.6'],
                ],
        ],
]
const KPIS = ['KPI-D01', 'KPI-D04', 'KPI-D07']

interface RunQuarter {
        id: number
        name: string
        sheet: (employee: string, plant: string) => number
        employeeId: (employee: string) => number
}

let run: RunQuarter
let consoleErrors: string[] = []

test.describe.configure({ mode: 'serial' })

test.beforeAll(async () => {
        const api = await request.newContext({ baseURL: API_ORIGIN })
        const login = await api.post('/api/auth/login', {
                data: { username: 'demo.hrhead', password: e2ePassword() },
        })
        expect(login.ok()).toBe(true)
        const quarters: { id: number; name: string; status: string }[] = await (
                await api.get('/api/kpi/quarters')
        ).json()
        // The quarter seeded for this run is the newest one.
        const quarter = quarters
                .filter((q) => q.name.startsWith('E2E Q '))
                .sort((a, b) => b.id - a.id)[0]
        expect(quarter?.status).toBe('OPEN')
        const sheets: {
                rows: {
                        assignment: {
                                employee: { id: number; employee_code: string }
                                plant: { code: string }
                        }
                        sheet: { id: number } | null
                }[]
        } = await (await api.get('/api/kpi/sheets', { params: { quarter_id: quarter.id } })).json()
        await api.dispose()
        const rows = sheets.rows.filter((r) => r.sheet !== null)
        expect(rows).toHaveLength(5)
        run = {
                id: quarter.id,
                name: quarter.name,
                sheet: (employee, plant) =>
                        rows.find(
                                (r) =>
                                        r.assignment.employee.employee_code === employee &&
                                        r.assignment.plant.code === plant,
                        )!.sheet!.id,
                employeeId: (employee) =>
                        rows.find((r) => r.assignment.employee.employee_code === employee)!
                                .assignment.employee.id,
        }
})

test.beforeEach(({ page }) => {
        consoleErrors = collectConsoleErrors(page)
})

test.afterEach(() => {
        expect(consoleErrors).toEqual([])
})

function monthCsv(month: number): string {
        const lines = ['Employee Code,Plant Code,Department Code,KPI,Period,Actual']
        for (const [employee, plant, values] of VALUES) {
                KPIS.forEach((kpi, k) =>
                        lines.push(
                                `${employee},${plant},QA,${kpi},${MONTHS[month]},${values[k][month]}`,
                        ),
                )
        }
        return lines.join('\n')
}

async function step(page: Page, label: string) {
        await page.goto(`/scores/quarter?quarter=${run.id}`)
        await page.getByRole('button', { name: `Move to ${label}` }).click()
        await expect(page.getByText(`Moved to ${label}.`)).toBeVisible()
}

async function review(page: Page, employee: string, plant: string) {
        await page.goto(`/scores/results/${run.sheet(employee, plant)}`)
        await page.getByRole('button', { name: 'Mark as reviewed' }).click()
        await expect(page.getByText('Marked as reviewed.')).toBeVisible()
}

test('monthly data is imported for the whole quarter and scored', async ({ page }) => {
        test.setTimeout(180_000)
        await signIn(page, 'demo.quality.head')
        await page.goto(`/scores/data?quarter=${run.id}`)
        for (let month = 0; month < MONTHS.length; month++) {
                await page.getByLabel('Month', { exact: true }).selectOption(MONTHS[month])
                await page.getByLabel('CSV or Excel file (up to 2 MB)').setInputFiles({
                        name: `quality-${MONTHS[month]}.csv`,
                        mimeType: 'text/csv',
                        buffer: Buffer.from(monthCsv(month)),
                })
                await page.getByRole('button', { name: 'Check file' }).click()
                await expect(page.getByText('The file is valid')).toBeVisible()
                await page
                        .getByRole('button', { name: `Save 15 values for ${MONTH_NAMES[month]}` })
                        .click()
                await expect(page.getByText('Monthly values saved')).toBeVisible()
        }
        await page.getByRole('link', { name: 'Calculate and review scores' }).click()
        await page.getByRole('button', { name: 'Calculate scores' }).click()
        await expect(page.getByText('Calculation finished')).toBeVisible()

        // Each score is explained per KPI, from the frozen matrix version.
        await page.goto(`/scores/results/${run.sheet('DEMO0001', 'PLT-A')}`)
        await expect(page.getByText('4.20').first()).toBeVisible()
        const profit = page.getByRole('article', { name: 'Profit vs plan' })
        await expect(profit.getByText('June 2026: 35 Rs lakh')).toBeVisible()
        await signOut(page)
})

test('departments review the results; nobody reviews their own', async ({ page }) => {
        test.setTimeout(180_000)
        await signIn(page, 'demo.hrhead')
        await step(page, 'Department review')
        await signOut(page)

        await signIn(page, 'demo.quality.head')
        await review(page, 'DEMO0002', 'PLT-A')
        // Feedback is optional; only one sheet gets any.
        const panel = page.getByRole('region', { name: 'Comments and feedback' })
        await panel.getByLabel('Kind').selectOption('FEEDBACK')
        await panel.getByLabel('Comment').fill('E2E: steady quality results all quarter.')
        await panel.getByRole('button', { name: 'Add' }).click()
        await expect(panel.getByText('E2E: steady quality results all quarter.')).toBeVisible()
        await review(page, 'DEMO0003', 'PLT-B')
        await review(page, 'DEMO0012', 'PLT-C')
        // The quality head is DEMO0001: their own scores are reviewed by someone else.
        await page.goto(`/scores/results/${run.sheet('DEMO0001', 'PLT-A')}`)
        await expect(page.getByText('4.20').first()).toBeVisible()
        await expect(page.getByRole('button', { name: 'Mark as reviewed' })).toHaveCount(0)
        await signOut(page)

        await signIn(page, 'demo.hrhead')
        await review(page, 'DEMO0001', 'PLT-A')
        const panelA = page.getByRole('region', { name: 'Comments and feedback' })
        await panelA.getByLabel('Kind').selectOption('FEEDBACK')
        await panelA.getByLabel('Comment').fill('E2E: good balance across both plants.')
        await panelA.getByRole('button', { name: 'Add' }).click()
        await expect(panelA.getByText('E2E: good balance across both plants.')).toBeVisible()
        await review(page, 'DEMO0001', 'PLT-B')

        // The cross-plant employee's weights, then the next step.
        await page.goto(`/scores/quarter?quarter=${run.id}`)
        await expect(page.getByText(/contribution weights are missing/)).toBeVisible()
        await expect(page.getByRole('button', { name: 'Move to Normalization' })).toBeDisabled()
        await page.goto(`/scores/quarters/${run.id}/employees/${run.employeeId('DEMO0001')}`)
        await page.getByLabel('Weight % for Quality — Demo Plant A').fill('70')
        await page.getByLabel('Weight % for Quality — Demo Plant B').fill('30')
        await expect(page.getByText('Total 100.00 %')).toBeVisible()
        await page.getByRole('button', { name: 'Save weights' }).click()
        await expect(page.getByText('Weights saved')).toBeVisible()
        await expect(page.getByText('Final (2 decimals)').locator('..')).toContainText('4.05')
        await step(page, 'Normalization')
        await signOut(page)
})

test('tied employees are placed with reasons and the CHRO approves the cohort', async ({
        page,
}) => {
        test.setTimeout(180_000)
        await signIn(page, 'demo.hrhead')
        await page.goto(`/scores/normalization?quarter=${run.id}`)
        await page.getByRole('link', { name: 'Quality: all plants' }).click()

        const distribution = page.getByRole('table', { name: 'Group sizes: target and actual' })
        await expect(distribution.getByRole('row', { name: /Top 20%/ })).toContainText('1')
        await expect(page.getByText(/tied at 2.2/)).toBeVisible()
        await expect(page.getByText('2 employee(s) must be placed before approval.')).toBeVisible()

        await page.getByRole('button', { name: 'Place Meera Demo-Shah' }).click()
        await page.getByLabel('Group').selectOption('MIDDLE')
        await page.getByLabel('Reason').fill('E2E: fewer rejections in the last month')
        await page.getByRole('button', { name: 'Save placement' }).click()
        await expect(page.getByText('Meera Demo-Shah placed.')).toBeVisible()
        await page.getByRole('button', { name: 'Place Lakshmi Demo-Iyer' }).click()
        await page.getByLabel('Group').selectOption('BOTTOM')
        await page.getByLabel('Reason').fill('E2E: the claim came from a repeat defect')
        await page.getByRole('button', { name: 'Save placement' }).click()
        await expect(page.getByText('Lakshmi Demo-Iyer placed.')).toBeVisible()
        await expect(page.getByText(/match the policy’s targets/)).toBeVisible()
        // Whoever placed employees does not approve the cohort.
        await expect(page.getByText(/You placed employees in this cohort/)).toBeVisible()
        await expect(page.getByRole('button', { name: 'Approve the cohort…' })).toHaveCount(0)
        const cohortPath = new URL(page.url()).pathname
        await signOut(page)

        await signIn(page, 'demo.chro')
        await page.goto(cohortPath)
        await page.getByRole('button', { name: 'Approve the cohort…' }).click()
        await page.getByLabel('Approval note (optional)').fill('E2E: synthetic cohort')
        await page.getByRole('button', { name: 'Approve', exact: true }).click()
        await expect(page.getByText('Cohort approved.')).toBeVisible()
        await signOut(page)
})

test('the quarter is published as a whole and the employee sees the outcome', async ({ page }) => {
        test.setTimeout(180_000)
        await signIn(page, 'demo.hrhead')
        await step(page, 'Ready')
        // Publication needs the CHRO or an HR Head; the HR Head leaves it to the CHRO here.
        await signOut(page)

        await signIn(page, 'demo.chro')
        await page.goto(`/scores/quarter?quarter=${run.id}`)
        await page.getByRole('button', { name: 'Publish the quarter’s scores…' }).click()
        await page.getByRole('button', { name: 'Publish 4 employee scores' }).click()
        await expect(page.getByText('Published. The quarter is locked.')).toBeVisible()
        await expect(page.getByText('Published and locked')).toBeVisible()
        await expect(page.getByRole('button', { name: /Return to|Move to/ })).toHaveCount(0)
        await signOut(page)

        await signIn(page, 'demo.quality.head')
        await page
                .getByRole('navigation', { name: 'Main' })
                .getByRole('link', { name: 'My KPI sheets' })
                .click()
        const sheet = page.getByRole('region', { name: `${run.name} · Quality — Demo Plant A` })
        await expect(sheet.getByText('Score for this assignment').locator('..')).toContainText(
                '4.20',
        )
        await expect(sheet.getByText('Quarterly score').locator('..')).toContainText('4.05')
        await expect(sheet.getByText('Middle 60%')).toBeVisible()
        await expect(sheet.getByText('Normalized rating').locator('..')).toContainText('3')
        await expect(sheet.getByText('E2E: good balance across both plants.')).toBeVisible()
})
