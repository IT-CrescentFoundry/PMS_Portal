/**
 * Stage M: annual performance, an annual score deviation and a controlled
 * correction of a published quarter, on the isolated e2e database only.
 *
 * Repeatable: the e2e server seeds a fresh annual cycle for every run
 * ("E2E-A<timestamp>": four one-month quarters, April–July 2026, each in data
 * collection with a locked sheet for DEMO0005, the demo.employee account;
 * see PMS_Backend/tests/e2e_server.py). Synthetic monthly values, designed so
 * the outcome is known in advance (dispatch 60 %, productivity 40 %):
 *
 *   Q1 April  dispatch 105 (5), productivity 1.9 (4)   4.60
 *   Q2 May    dispatch  95 (4), productivity 1.7 (3)   3.60  -> corrected to 101 (5): 4.20
 *   Q3 June   dispatch  85 (3), productivity 2.0 (5)   3.80
 *   Q4 July   dispatch 102 (5), productivity 1.5 (2)   3.80
 *
 * Annual score (equally weighted quarters): 3.95; an Admin's deviation to
 * 4.00 is approved by the CHRO; after the Q2 correction, 4.10.
 */
import { expect, test, type Page } from '@playwright/test'
import {
        apiAs,
        collectConsoleErrors,
        findRunCycle,
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

let run: RunCycle
let correctionPath = ''
let consoleErrors: string[] = []

test.describe.configure({ mode: 'serial' })

test.beforeAll(async () => {
        const api = await apiAs('demo.hrhead')
        run = await findRunCycle(api, 'E2E-A')
        await api.dispose()
})

test.beforeEach(({ page }) => {
        consoleErrors = collectConsoleErrors(page)
})

test.afterEach(() => {
        expect(consoleErrors).toEqual([])
})

const annualPath = () => `/annual/cycles/${run.cycleId}/employees/${run.employeeId}`

async function openAnnual(page: Page) {
        await page.goto(annualPath())
        await expect(
                page.getByRole('heading', { level: 1, name: 'Sunil Demo-Yadav' }),
        ).toBeVisible()
}

test('four quarterly results are published for the synthetic employee', async ({ page }) => {
        test.setTimeout(180_000)
        // The quarterly workflow itself is covered in the browser by quarterly.spec.ts;
        // here the same API steps publish four quarters quickly.
        const api = await apiAs('demo.hrhead')
        for (const [index, values] of VALUES.entries())
                await publishDemoQuarter(api, run.quarters[index].id, run.sheets[index], values)
        await api.dispose()

        await signIn(page, 'demo.hrhead')
        await page.goto(`/scores/quarter?quarter=${run.quarters[3].id}`)
        await expect(page.getByText('Published and locked')).toBeVisible()
        await signOut(page)
})

test('the annual score is calculated from the four published quarters', async ({ page }) => {
        test.setTimeout(120_000)
        await signIn(page, 'demo.hrhead')
        await page
                .getByRole('navigation', { name: 'Main' })
                .getByRole('link', { name: 'Annual results' })
                .click()
        await page.getByLabel('PMS cycle').selectOption(String(run.cycleId))
        const table = page.getByRole('table', { name: `Annual results for ${run.cycleName}` })
        const row = table.getByRole('row', { name: /Sunil Demo-Yadav/ })
        await expect(row).toContainText('4.60')
        await expect(row).toContainText('Not calculated yet')
        await page.getByRole('button', { name: 'Calculate annual results' }).click()
        await expect(
                page.getByText('1 annual result calculated · 0 unchanged · 0 waiting for quarters'),
        ).toBeVisible()
        await expect(row).toContainText('3.95')
        await row.getByRole('link', { name: 'Sunil Demo-Yadav' }).click()
        const draft = page.getByRole('region', { name: 'Calculated version awaiting approval' })
        await expect(draft.getByText('Original calculated score').locator('..')).toContainText(
                '3.95',
        )
        await expect(page.getByRole('table', { name: 'Annual result versions' })).toContainText(
                'Q1 v1: 4.60 · Q2 v1: 3.60 · Q3 v1: 3.80 · Q4 v1: 3.80',
        )
        // Only the CHRO approves.
        await expect(page.getByRole('button', { name: 'Approve the annual result…' })).toHaveCount(
                0,
        )
        await signOut(page)
})

test('an Admin requests a deviation and the CHRO decides it, then approves the result', async ({
        page,
}) => {
        test.setTimeout(120_000)
        await signIn(page, 'demo.admin')
        await openAnnual(page)
        await page.getByRole('button', { name: 'Request a deviation…' }).click()
        await page.getByLabel('Revised annual score').fill('4.00')
        await page
                .getByLabel('Reason for the deviation')
                .fill('E2E: plant start-up support all year')
        await page.getByRole('button', { name: 'Submit the deviation' }).click()
        await expect(page.getByText('Deviation requested. The CHRO decides it.')).toBeVisible()
        await expect(page.getByText('Deviation awaiting the CHRO')).toBeVisible()
        await expect(page.getByRole('button', { name: 'Approve the deviation…' })).toHaveCount(0)
        await signOut(page)

        await signIn(page, 'demo.chro')
        await page.goto('/annual/deviations')
        await page
                .getByRole('table', { name: 'Annual score deviations' })
                .getByRole('link', { name: 'Sunil Demo-Yadav' })
                .first()
                .click()
        await expect(
                page.getByRole('heading', { level: 1, name: 'Sunil Demo-Yadav' }),
        ).toBeVisible()
        await page.goto(annualPath())
        await page.getByRole('button', { name: 'Approve the deviation…' }).click()
        await page
                .getByLabel('Why is the deviation approved?')
                .fill('E2E: support confirmed by the plant head')
        await page.getByRole('button', { name: 'Approve the deviation' }).click()
        await expect(
                page.getByText('Deviation approved: the adjusted score applies.'),
        ).toBeVisible()
        const draft = page.getByRole('region', { name: 'Calculated version awaiting approval' })
        await expect(draft.getByText('Original calculated score').locator('..')).toContainText(
                '3.95',
        )
        await expect(draft.getByText('Final annual score').locator('..')).toContainText('4.00')
        await page.getByRole('button', { name: 'Approve the annual result…' }).click()
        await page.getByLabel('Approval note (optional)').fill('E2E: synthetic year closed')
        await page.getByRole('button', { name: 'Approve version 1' }).click()
        await expect(page.getByText('Version 1 approved: it is the annual result.')).toBeVisible()
        await signOut(page)
})

test('a published quarter is corrected through a new, reviewed version', async ({ page }) => {
        test.setTimeout(180_000)
        const q2 = run.quarters[1]
        await signIn(page, 'demo.hrhead')
        await page.goto(`/scores/quarter?quarter=${q2.id}`)
        await page.getByRole('link', { name: 'Request a correction…' }).click()
        await page
                .getByLabel('Employee and assignment (change 1)')
                .selectOption({ label: 'DEMO0005 Sunil Demo-Yadav · Production — Demo Plant A' })
        await page.getByLabel('KPI (change 1)').selectOption({ label: 'KPI-D02 Dispatch volume' })
        await page.getByLabel('Month (change 1)').selectOption('2026-05')
        await page.getByLabel('Corrected value (change 1)').fill('101')
        await page
                .getByLabel('Reason for the correction')
                .fill('E2E: May dispatch missed a late delivery note')
        await page.getByRole('button', { name: 'Check the correction' }).click()
        const projected = page.getByRole('table', { name: 'Projected KPI sheet scores' })
        await expect(projected).toContainText('3.60')
        await expect(projected).toContainText('4.20')
        await page.getByRole('button', { name: 'Submit for CHRO approval' }).click()
        await expect(
                page.getByRole('heading', {
                        level: 1,
                        name: new RegExp(`^Correction \\d+ · ${q2.name.replace(/[()]/g, '\\$&')}$`),
                }),
        ).toBeVisible()
        correctionPath = new URL(page.url()).pathname
        // The requester never decides.
        await expect(page.getByRole('button', { name: 'Approve the correction…' })).toHaveCount(0)
        await signOut(page)

        await signIn(page, 'demo.chro')
        await page.goto(correctionPath)
        await page.getByRole('button', { name: 'Approve the correction…' }).click()
        await page
                .getByLabel('Why is the correction approved?')
                .fill('E2E: matches the signed delivery notes')
        await page.getByRole('button', { name: 'Approve the correction' }).click()
        await expect(
                page.getByText('Approved: the corrected version is open for department review.'),
        ).toBeVisible()
        await signOut(page)

        // Department review of the recalculated sheet (not by the employee).
        await signIn(page, 'demo.production.head.a')
        await page.goto(`/scores/results/${run.sheets[1]}`)
        await expect(page.getByText('Corrected version 2 under review')).toBeVisible()
        await page.getByRole('button', { name: 'Mark as reviewed' }).click()
        await expect(page.getByText('Marked as reviewed.')).toBeVisible()
        await signOut(page)

        await signIn(page, 'demo.hrhead')
        await page.goto(correctionPath)
        await page.getByRole('button', { name: 'Move to Normalization' }).click()
        await expect(page.getByText('Moved to Normalization.')).toBeVisible()
        await page
                .getByRole('list', { name: 'Renormalized cohorts' })
                .getByRole('link')
                .first()
                .click()
        await page.getByRole('button', { name: 'Approve the cohort…' }).click()
        await page.getByRole('button', { name: 'Approve', exact: true }).click()
        await expect(page.getByText('Cohort approved.')).toBeVisible()
        await page.goto(correctionPath)
        await page.getByRole('button', { name: 'Move to Ready' }).click()
        await expect(page.getByText('Moved to Ready.')).toBeVisible()
        await page.getByRole('button', { name: 'Publish the corrected version…' }).click()
        await page.getByRole('button', { name: 'Publish version 2' }).click()
        await expect(
                page.getByText('Version 2 published. The earlier version stays in the history.'),
        ).toBeVisible()

        // Both versions stay available.
        await page.goto(`/scores/quarter?quarter=${q2.id}`)
        const versions = page.getByRole('list', { name: 'Published versions' })
        await expect(versions.getByRole('listitem').nth(0)).toContainText('Version 1')
        await expect(versions.getByRole('listitem').nth(0)).toContainText('Superseded')
        await expect(versions.getByRole('listitem').nth(1)).toContainText('Current')
        await page.goto(`/scores/results/${run.sheets[1]}`)
        const resultVersions = page.getByRole('table', { name: 'Versions of this result' })
        await expect(resultVersions.getByRole('row')).toHaveCount(3)
        await expect(resultVersions).toContainText('Superseded by a correction')
        await signOut(page)
})

test('the annual result is recalculated and approved again; both versions stay', async ({
        page,
}) => {
        test.setTimeout(120_000)
        await signIn(page, 'demo.hrhead')
        await openAnnual(page)
        await expect(page.getByText('Recalculation required').first()).toBeVisible()
        await page.getByRole('button', { name: 'Calculate the annual result' }).click()
        await expect(page.getByText('Annual result calculated.')).toBeVisible()
        const draft = page.getByRole('region', { name: 'Calculated version awaiting approval' })
        await expect(draft.getByText('Original calculated score').locator('..')).toContainText(
                '4.10',
        )
        // The approved version 1 stays the annual result until version 2 is approved.
        const approved = page.getByRole('region', { name: 'Approved annual result' })
        await expect(approved.getByText('Final annual score').locator('..')).toContainText('4.00')
        await signOut(page)

        await signIn(page, 'demo.chro')
        await openAnnual(page)
        await page.getByRole('button', { name: 'Approve the annual result…' }).click()
        await page.getByRole('button', { name: 'Approve version 2' }).click()
        await expect(page.getByText('Version 2 approved: it is the annual result.')).toBeVisible()
        const versions = page.getByRole('table', { name: 'Annual result versions' })
        await expect(versions.getByRole('row').nth(1)).toContainText('Approved (final)')
        await expect(versions.getByRole('row').nth(1)).toContainText('Q2 v2: 4.20')
        await expect(versions.getByRole('row').nth(2)).toContainText(
                'Superseded by a later version',
        )
        const history = page.getByRole('list', { name: 'Audit history' })
        await expect(history).toContainText('annual_deviation.approve')
        await expect(history).toContainText('annual_result.publish')
        await signOut(page)
})

test('the employee sees only their approved annual result; others are denied', async ({ page }) => {
        await signIn(page, 'demo.employee')
        await page
                .getByRole('navigation', { name: 'Main' })
                .getByRole('link', { name: 'My KPI sheets' })
                .click()
        const card = page.getByRole('article', { name: run.cycleName })
        await expect(card.getByText('Annual score').locator('..')).toContainText('4.10')
        await page.goto('/annual')
        await expect(page.getByRole('heading', { level: 1, name: 'Access denied' })).toBeVisible()
        await signOut(page)

        await signIn(page, 'demo.quality.head')
        await page.goto(annualPath())
        await expect(page.getByRole('heading', { level: 1, name: 'Access denied' })).toBeVisible()
        await expect(
                page
                        .getByRole('navigation', { name: 'Main' })
                        .getByRole('link', { name: 'Annual results' }),
        ).toHaveCount(0)
})
