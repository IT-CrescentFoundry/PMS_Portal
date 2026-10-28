/**
 * Stage N: compensation matrices, compa-ratio, increment proposals and the
 * company budget, on the isolated e2e database only.
 *
 * Repeatable: the e2e server seeds a fresh four-quarter cycle for every run
 * ("E2E-C<timestamp>", quarters "E2E C1"–"E2E C4", each with a locked sheet
 * for DEMO0005; see PMS_Backend/tests/e2e_server.py). The spec publishes the
 * quarters with the annual spec's synthetic values (annual score 3.95) and
 * approves the annual result through the API, then:
 *
 *   - authors synthetic KRA performance and increment matrices (not company
 *     policy), in force for one day only, a date unique to the run, so runs
 *     never overlap; the CHRO approves one in the browser;
 *   - the HR Head creates the compensation cycle and imports a synthetic
 *     salary baseline (the values exist only in this file):
 *       DEMO0005  600,000 / 650,000  CR 0.9231, rating 5 -> 12 % = 72,000.00
 *       DEMO0001  cross-plant, no annual result in this cycle -> excluded
 *       DEMO0002  not eligible -> excluded
 *   - calculates and submits a scenario (requirement 72,000.00);
 *   - the budget owner records an approved budget of 70,000.00 (overspend
 *     2,000.00) and sees totals but no employee amounts;
 *   - the CHRO approves the final budget; increments are never adjusted.
 *
 * Stage O continues with the finalized budget: the budget owner distributes
 * 70,000.00 to Production at Demo Plant A; the HR Head allows changes with a
 * reason; the Production head's proposal (recommendation 72,000.00) can't be
 * submitted over budget, so DEMO0005 is proposed at 11.5 % (69,000.00) with
 * a reason; an Admin forwards it and the CHRO approves it.
 */
import { expect, test, type APIRequestContext } from '@playwright/test'
import {
        apiAs,
        collectConsoleErrors,
        findRunCycle,
        ok,
        publishDemoQuarter,
        signIn,
        signOut,
        type RunCycle,
} from './helpers'

const VALUES: [string, string, string][] = [
        ['2026-04', '105', '1.9'],
        ['2026-05', '95', '1.7'],
        ['2026-06', '85', '2.0'],
        ['2026-07', '102', '1.5'],
]

const BASELINE = [
        'Employee Code,Current Salary,Reference Salary,Grade,Eligible,Exclusion Reason',
        'DEMO0005,600000,650000,E2E-G1,Yes,',
        'DEMO0001,500000,500000,,Yes,',
        'DEMO0002,450000,500000,,No,E2E synthetic exclusion',
].join('\n')

let run: RunCycle
let effectiveDate = ''
const matrices: { matrixId: number; versionId: number; code: string }[] = []
let cyclePath = ''
let scenarioPath = ''
let allocationsPath = ''
let proposalPath = ''
let consoleErrors: string[] = []

test.describe.configure({ mode: 'serial' })

test.beforeAll(async () => {
        const api = await apiAs('demo.hrhead')
        run = await findRunCycle(api, 'E2E-C')
        await api.dispose()
        // One day per run (the PMS cycle id is unique), far from any real date.
        effectiveDate = new Date(Date.UTC(2031, 0, 1 + run.cycleId)).toISOString().slice(0, 10)
})

test.beforeEach(({ page }) => {
        consoleErrors = collectConsoleErrors(page)
})

test.afterEach(() => {
        expect(consoleErrors).toEqual([])
})

const FIELD_KEYS = [
        'key',
        'label',
        'role',
        'data_type',
        'unit',
        'description',
        'required',
        'min',
        'max',
        'allowed_values',
        'source',
        'aggregation',
        'round_to',
] as const

type Field = Record<string, unknown>

const range = (min: string | null, max: string | null = null) => ({
        min,
        min_inclusive: min === null ? null : true,
        max,
        max_inclusive: max === null ? null : false,
})
const rating = (lo: number, hi = lo) => ({
        min: String(lo),
        min_inclusive: true,
        max: String(hi),
        max_inclusive: true,
})
const rule = (priority: number, label: string, conditions: object, outputs: object) => ({
        priority,
        label,
        conditions,
        outputs,
})

/** Synthetic definitions for the test only; these are not company policy values. */
async function definitions(api: APIRequestContext) {
        const types = await ok<{ code: string; standard_inputs: Field[]; outputs: Field[] }[]>(
                await api.get('/api/matrix-types'),
        )
        const field = (type: string, key: string): Field => {
                const meta = types.find((t) => t.code === type)!
                const f = [...meta.standard_inputs, ...meta.outputs].find((x) => x.key === key)!
                return Object.fromEntries(FIELD_KEYS.map((k) => [k, f[k] ?? null]))
        }
        return {
                KRA_PERFORMANCE: {
                        fields: [
                                field('KRA_PERFORMANCE', 'weighted_score'),
                                field('KRA_PERFORMANCE', 'rating'),
                        ],
                        rules: [
                                rule(
                                        1,
                                        'E2E top',
                                        { weighted_score: range('3.95') },
                                        { rating: 5 },
                                ),
                                rule(
                                        2,
                                        'E2E 4',
                                        { weighted_score: range('3', '3.95') },
                                        { rating: 4 },
                                ),
                                rule(
                                        3,
                                        'E2E 3',
                                        { weighted_score: range('2', '3') },
                                        { rating: 3 },
                                ),
                                rule(
                                        4,
                                        'E2E 2',
                                        { weighted_score: range('0', '2') },
                                        { rating: 2 },
                                ),
                        ],
                        no_match: { mode: 'error' },
                        test_cases: [],
                },
                INCREMENT: {
                        fields: [
                                field('INCREMENT', 'performance_rating'),
                                field('INCREMENT', 'compa_ratio'),
                                field('INCREMENT', 'increment_percent'),
                        ],
                        rules: [
                                rule(
                                        1,
                                        'E2E 5 below',
                                        {
                                                performance_rating: rating(5),
                                                compa_ratio: range('0', '1'),
                                        },
                                        { increment_percent: '12' },
                                ),
                                rule(
                                        2,
                                        'E2E 5 above',
                                        { performance_rating: rating(5), compa_ratio: range('1') },
                                        { increment_percent: '10' },
                                ),
                                rule(
                                        3,
                                        'E2E 4',
                                        { performance_rating: rating(4) },
                                        { increment_percent: '8' },
                                ),
                                rule(
                                        4,
                                        'E2E 1-3',
                                        { performance_rating: rating(1, 3) },
                                        { increment_percent: '3' },
                                ),
                        ],
                        no_match: { mode: 'error' },
                        test_cases: [],
                },
        }
}

test('the year is published and synthetic compensation matrices are approved', async ({ page }) => {
        test.setTimeout(240_000)
        const hr = await apiAs('demo.hrhead')
        for (const [index, values] of VALUES.entries())
                await publishDemoQuarter(hr, run.quarters[index].id, run.sheets[index], values)
        await ok(
                await hr.post(`/api/annual/cycles/${run.cycleId}/calculate`, {
                        data: { employee_ids: null },
                }),
        )
        const detail = await ok<{ draft: { id: number; final_score: string } | null }>(
                await hr.get(`/api/annual/cycles/${run.cycleId}/employees/${run.employeeId}`),
        )
        expect(Number(detail.draft?.final_score)).toBe(3.95)
        const chro = await apiAs('demo.chro')
        await ok(
                await chro.post(`/api/annual/results/${detail.draft!.id}/finalize`, {
                        data: { note: 'E2E: synthetic year' },
                }),
        )

        const defs = await definitions(hr)
        for (const [type, definition] of Object.entries(defs)) {
                const scope = [{ plant_id: null, department_id: null }]
                const matrix = await ok<{
                        id: number
                        code: string
                        latest_version: { id: number }
                }>(
                        await hr.post('/api/matrices', {
                                data: {
                                        matrix_type: type,
                                        name: `E2E ${type.toLowerCase()} ${run.cycleId}`,
                                        description:
                                                'Synthetic browser-test configuration, not company policy.',
                                        applicability: scope,
                                },
                        }),
                )
                const base = `/api/matrices/${matrix.id}/versions/${matrix.latest_version.id}`
                await ok(
                        await hr.put(base, {
                                data: {
                                        definition,
                                        effective_from: effectiveDate,
                                        effective_to: effectiveDate,
                                        applicability: scope,
                                        change_summary: 'E2E synthetic values',
                                },
                        }),
                )
                await ok(await hr.post(`${base}/submit`))
                matrices.push({
                        matrixId: matrix.id,
                        versionId: matrix.latest_version.id,
                        code: matrix.code,
                })
        }

        // The CHRO approves the KRA performance matrix in the browser (the API does the other).
        const [kra, increment] = matrices
        await signIn(page, 'demo.chro')
        await page.goto(`/matrices/${kra.matrixId}/versions/${kra.versionId}`)
        await page.getByRole('button', { name: 'Approve…' }).click()
        await page.getByLabel('Approval note (optional)').fill('E2E: synthetic configuration')
        await page.getByRole('button', { name: 'Approve version 1' }).click()
        await expect(page.getByRole('button', { name: 'Publish' })).toBeVisible()
        await signOut(page)
        await ok(
                await chro.post(
                        `/api/matrices/${increment.matrixId}/versions/${increment.versionId}/approve`,
                        { data: { note: 'E2E: synthetic configuration' } },
                ),
        )
        for (const m of matrices)
                await ok(
                        await hr.post(
                                `/api/matrices/${m.matrixId}/versions/${m.versionId}/publish`,
                        ),
                )
        await chro.dispose()
        await hr.dispose()
})

test('the HR Head sets up the cycle and imports a synthetic salary baseline', async ({ page }) => {
        await signIn(page, 'demo.hrhead')
        await page
                .getByRole('navigation', { name: 'Main' })
                .getByRole('link', { name: 'Compensation & budget' })
                .click()
        await page.getByRole('button', { name: 'New compensation cycle' }).click()
        const form = page.getByRole('form', { name: 'Compensation cycle' })
        await form.getByLabel('Code', { exact: true }).fill(`E2E-C${run.cycleId}`)
        await form.getByLabel('Name', { exact: true }).fill(`E2E compensation ${run.cycleId}`)
        await form
                .getByLabel('Annual results from (PMS cycle)')
                .selectOption({ label: run.cycleName })
        await form.getByLabel('Effective date').fill(effectiveDate)
        await form.getByLabel('Compa-ratio reference').fill('E2E reference salary')
        await form.getByLabel('How compa-ratio affects the increment').selectOption('MATRIX_INPUT')
        await form.getByRole('button', { name: 'Create the cycle' }).click()
        await expect(
                page.getByRole('heading', { level: 1, name: `E2E compensation ${run.cycleId}` }),
        ).toBeVisible()
        cyclePath = new URL(page.url()).pathname

        const policy = page.getByRole('list', { name: 'Compensation matrices' })
        await expect(policy.getByRole('listitem')).toHaveCount(2)
        await expect(policy.getByText('Awaiting approved configuration')).toHaveCount(0)
        await expect(
                policy.getByRole('link', { name: `${matrices[1].code} version 1` }),
        ).toBeVisible()

        await page.getByRole('link', { name: 'Import a salary baseline' }).click()
        await page.getByLabel('Salary baseline (.xlsx or .csv, up to 2 MB)').setInputFiles({
                name: 'e2e-baseline.csv',
                mimeType: 'text/csv',
                buffer: Buffer.from(BASELINE),
        })
        await page.getByRole('button', { name: 'Check the file' }).click()
        await expect(page.getByText('The file is valid')).toBeVisible()
        const rows = page.getByRole('table', { name: 'Rows in the file' })
        await expect(rows.getByRole('row')).toHaveCount(4)
        await expect(rows).toContainText('E2E synthetic exclusion')
        await page.getByRole('button', { name: 'Save the baseline' }).click()
        await expect(page.getByText('Saved as baseline version 1')).toBeVisible()
        await signOut(page)
})

test('the HR Head calculates a scenario, reads the explanation and submits it', async ({
        page,
}) => {
        await signIn(page, 'demo.hrhead')
        await page.goto(cyclePath)
        const form = page.getByRole('form', { name: 'Calculate a scenario' })
        await form.getByLabel('Scenario name').fill('E2E initial requirement')
        await form.getByRole('button', { name: 'Calculate the scenario' }).click()
        await expect(
                page.getByRole('heading', {
                        level: 1,
                        name: 'Scenario 1: E2E initial requirement',
                }),
        ).toBeVisible()
        scenarioPath = new URL(page.url()).pathname

        const totals = page.getByRole('region', { name: 'Initial budget requirement' })
        await expect(totals).toContainText('1 of 3')
        await expect(totals).toContainText('72,000.00')
        const lines = page.getByRole('table', { name: 'Employee proposals' })
        const sunil = lines.getByRole('row', { name: /Sunil Demo-Yadav/ })
        await expect(sunil).toContainText('0.9231')
        await expect(sunil).toContainText('12.00 %')
        await expect(sunil).toContainText('672,000.00')
        await sunil.getByText('How this was calculated').click()
        await expect(
                sunil.getByRole('list', {
                        name: 'How the proposal for Sunil Demo-Yadav was calculated',
                }),
        ).toContainText('INR 600,000.00 ÷ INR 650,000.00')
        const excluded = page.getByRole('table', { name: 'Excluded employees by reason' })
        await expect(excluded).toContainText('No approved annual result')
        await expect(excluded).toContainText('Not eligible')
        await expect(
                page.getByText('The budget owner has not recorded the approved budget yet.'),
        ).toBeVisible()

        await page.getByRole('button', { name: 'Submit to the CHRO' }).click()
        await expect(
                page.getByText('Submitted to the CHRO for the final budget decision.'),
        ).toBeVisible()
        await signOut(page)
})

test('the budget owner records the approved budget and sees no employee amounts', async ({
        page,
}) => {
        await signIn(page, 'demo.budget')
        await page
                .getByRole('navigation', { name: 'Main' })
                .getByRole('link', { name: 'Compensation & budget' })
                .click()
        await page.getByRole('link', { name: `E2E compensation ${run.cycleId}` }).click()
        await expect(page.getByRole('link', { name: 'Import a salary baseline' })).toHaveCount(0)
        await expect(page.getByRole('form', { name: 'Calculate a scenario' })).toHaveCount(0)
        const form = page.getByRole('form', { name: 'Record the approved budget' })
        await form.getByLabel('Company-approved budget (INR)').fill('70000.00')
        await form
                .getByLabel('Reason or source of the decision')
                .fill('E2E: synthetic board approval')
        await form.getByRole('button', { name: 'Record the approved budget' }).click()
        await expect(page.getByText('Approved budget recorded.')).toBeVisible()

        await page.getByRole('link', { name: '1. E2E initial requirement' }).click()
        await expect(page.getByText('Over budget', { exact: true })).toBeVisible()
        await expect(page.getByText(/Overspend of INR 2,000\.00/)).toBeVisible()
        await expect(
                page.getByText('Employee-level amounts are visible only to compensation roles.'),
        ).toBeVisible()
        await expect(page.getByText('Hidden: fewer than 3 employees').first()).toBeVisible()
        await expect(page.getByText('Sunil Demo-Yadav')).toHaveCount(0)
        await expect(page.getByRole('button', { name: 'Approve…' })).toHaveCount(0)
        await signOut(page)
})

test('the CHRO approves the final budget', async ({ page }) => {
        await signIn(page, 'demo.chro')
        await page.goto(scenarioPath)
        await page.getByRole('button', { name: 'Approve…' }).click()
        await page
                .getByLabel('Reason for approving this scenario as the final budget')
                .fill('E2E: overspend accepted for the synthetic run')
        await page.getByRole('button', { name: 'Approve the final budget' }).click()
        await expect(page.getByText('Approved as the final budget.')).toBeVisible()
        await expect(page.getByText('Final budget', { exact: true }).first()).toBeVisible()
        await page.goto(cyclePath)
        await expect(page.getByText(/^Finalized /)).toBeVisible()
        await signOut(page)
})

test('the budget owner distributes the approved budget to a department', async ({ page }) => {
        await signIn(page, 'demo.budget')
        await page
                .getByRole('navigation', { name: 'Main' })
                .getByRole('link', { name: 'Increment allocations' })
                .click()
        await page.getByRole('link', { name: `E2E compensation ${run.cycleId}` }).click()
        allocationsPath = new URL(page.url()).pathname
        await expect(page.getByText('Company budget approved')).toBeVisible()
        await page.getByRole('button', { name: 'Distribute the budget' }).click()
        await expect(
                page.getByRole('heading', { level: 1, name: 'Budget distribution version 1' }),
        ).toBeVisible()
        await page.getByLabel('Add a plant').selectOption({ label: 'Demo Plant A' })
        await page.getByRole('button', { name: 'Add', exact: true }).click()
        await page.getByLabel('Demo Plant A: amount').fill('70000')
        await page
                .getByLabel('Add a department of Demo Plant A')
                .selectOption({ label: 'Production' })
        await page.getByLabel('Production — Demo Plant A: amount').fill('70000')
        await page.getByRole('button', { name: 'Save the draft' }).click()
        await expect(page.getByText('Draft saved.')).toBeVisible()
        await page.getByRole('button', { name: 'Publish this version' }).click()
        await expect(
                page.getByText('Published. Departments now propose against this version.'),
        ).toBeVisible()
        await signOut(page)
})

test('the HR Head allows changes with a reason', async ({ page }) => {
        await signIn(page, 'demo.hrhead')
        await page.goto(allocationsPath)
        await expect(page.getByText('Recommendation only (no policy set yet)')).toBeVisible()
        await page.getByRole('button', { name: 'Change the policy' }).click()
        await page.getByLabel('Policy', { exact: true }).selectOption('WITH_REASON')
        await page.getByRole('button', { name: 'Save the policy' }).click()
        await expect(page.getByText('Changes with a reason', { exact: true })).toBeVisible()
        await signOut(page)
})

test('the department proposes within its budget, with a reason for the change', async ({
        page,
}) => {
        await signIn(page, 'demo.production.head.a')
        await page
                .getByRole('navigation', { name: 'Main' })
                .getByRole('link', { name: 'Increment allocations' })
                .click()
        await page.getByRole('link', { name: `E2E compensation ${run.cycleId}` }).click()
        const units = page.getByRole('table', { name: 'Department allocations' })
        await expect(units.getByRole('row')).toHaveCount(2) // header + Production only
        await units.getByRole('button', { name: 'Start the proposal' }).click()
        await expect(
                page.getByRole('heading', {
                        level: 1,
                        name: 'Production — Demo Plant A: allocation version 1',
                }),
        ).toBeVisible()
        proposalPath = new URL(page.url()).pathname
        // The matrix recommendation (72,000.00) exceeds the 70,000.00 budget.
        await page.getByRole('button', { name: 'Submit for review' }).click()
        await expect(
                page.getByText(/exceeds the unit's distributed budget of 70000 by 2000/),
        ).toBeVisible()
        await page.getByLabel('Proposed % for Sunil Demo-Yadav').fill('11.5')
        await page.getByLabel('Reason for Sunil Demo-Yadav').fill('E2E: fits the department budget')
        await page.getByRole('button', { name: 'Save the draft' }).click()
        await expect(page.getByText('Draft saved.')).toBeVisible()
        await expect(page.getByText('Remaining budget')).toBeVisible()
        await page.getByRole('button', { name: 'Submit for review' }).click()
        await expect(page.getByText('Submitted for Admin review.')).toBeVisible()
        await signOut(page)
})

test('an Admin forwards the proposal and the CHRO approves it', async ({ page }) => {
        await signIn(page, 'demo.admin')
        await page.goto(proposalPath)
        await expect(page.getByRole('button', { name: 'Approve…' })).toHaveCount(0)
        await page.getByLabel('Review note for the CHRO (optional)').fill('E2E: checked')
        await page.getByRole('button', { name: 'Forward to the CHRO' }).click()
        await expect(page.getByText('Forwarded to the CHRO.')).toBeVisible()
        await signOut(page)

        await signIn(page, 'demo.chro')
        await page.goto(proposalPath)
        const lines = page.getByRole('table', { name: 'Employee allocations' })
        await expect(lines.getByRole('row', { name: /Sunil Demo-Yadav/ })).toContainText('11.50 %')
        await page.getByRole('button', { name: 'Approve…' }).click()
        await page
                .getByLabel('Reason for approving these allocations')
                .fill('E2E: within the department budget')
        await page.getByRole('button', { name: 'Approve the allocations' }).click()
        await expect(page.getByText('Approved.', { exact: true })).toBeVisible()
        await page.goto(allocationsPath)
        await expect(page.getByText('Approved by the CHRO')).toBeVisible()
        await expect(
                page.getByRole('table', { name: 'Department allocations' }).getByRole('row', {
                        name: /Production — Demo Plant A/,
                }),
        ).toContainText('69,000.00')
        await signOut(page)
})

test('roles without budget access cannot open compensation', async ({ page }) => {
        await signIn(page, 'demo.employee')
        await expect(
                page
                        .getByRole('navigation', { name: 'Main' })
                        .getByRole('link', { name: 'Compensation & budget' }),
        ).toHaveCount(0)
        await page.goto('/compensation')
        await expect(page.getByRole('heading', { level: 1, name: 'Access denied' })).toBeVisible()
        await page.goto('/allocations')
        await expect(page.getByRole('heading', { level: 1, name: 'Access denied' })).toBeVisible()
        const api = await apiAs('demo.employee')
        expect((await api.get('/api/compensation/cycles')).status()).toBe(403)
        await api.dispose()
        await signOut(page)
})
