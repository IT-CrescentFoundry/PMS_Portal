/**
 * Stage K against the demo seed (PMS_Backend/app/seed/demo_data.py), on the
 * isolated e2e database only.
 *
 * Repeatable: every run creates its own matrix and KPI (unique names), swaps
 * that KPI into the locked Q3 sheet of DEMO0002 through a dual-approved
 * deviation, imports October values and calculates the quarter. Nothing is
 * reviewed or published as final, which would freeze the demo sheet.
 */
import { expect, test } from '@playwright/test'
import { collectConsoleErrors, sheetIdOf, signIn, signOut } from './helpers'

const stamp = Date.now()
const matrixName = `E2E delivery scoring ${stamp}`
const kpiName = `E2E on-time delivery ${stamp}`
let versionPath = ''

let consoleErrors: string[] = []

test.describe.configure({ mode: 'serial' })

test.beforeEach(({ page }) => {
        consoleErrors = collectConsoleErrors(page)
})

test.afterEach(() => {
        expect(consoleErrors).toEqual([])
})

test('the HR Head configures a scoring matrix, round-trips it through Excel and the CHRO approves it', async ({
        page,
}, testInfo) => {
        test.setTimeout(180_000)
        await signIn(page, 'demo.hrhead')
        await page
                .getByRole('navigation', { name: 'Main' })
                .getByRole('link', { name: 'Matrices' })
                .click()
        await expect(
                page.getByRole('heading', { level: 1, name: 'Configurable matrices' }),
        ).toBeVisible()
        await expect(page.getByText(/Awaiting approved configuration/).first()).toBeVisible()
        await page.getByRole('link', { name: 'New matrix' }).click()

        await page.getByRole('radio', { name: /^KPI scoring matrix/ }).check()
        await page.getByLabel('Name', { exact: true }).fill(matrixName)
        await page.getByLabel('What good looks like').selectOption({ label: 'Higher is better' })
        await page.getByRole('button', { name: 'Create and define version 1' }).click()
        await expect(
                page.getByRole('heading', { level: 1, name: `Edit ${matrixName} · version 1` }),
        ).toBeVisible()

        // Fields: the standard achievement input next to the fixed score output.
        await page.getByLabel('Standard input').selectOption('achievement_percent')
        await page.getByRole('button', { name: 'Add standard input' }).click()

        // Rules with explicit boundaries: exactly 100% belongs to rule 2.
        await page.getByRole('button', { name: 'Add a rule' }).click()
        await page.getByRole('button', { name: 'Add a rule' }).click()
        await page.getByLabel('Achievement %: condition, rule row 1').selectOption('range')
        await page.getByLabel('Achievement %: lower bound, rule row 1').selectOption('gt')
        await page.getByLabel('Achievement %: lower bound value, rule row 1').fill('100')
        await page.getByLabel('Score, rule row 1').fill('5')
        await page.getByLabel('Achievement %: condition, rule row 2').selectOption('range')
        await page.getByLabel('Achievement %: lower bound, rule row 2').selectOption('gt')
        await page.getByLabel('Achievement %: lower bound value, rule row 2').fill('90')
        await page.getByLabel('Achievement %: upper bound, rule row 2').selectOption('lte')
        await page.getByLabel('Achievement %: upper bound value, rule row 2').fill('100')
        await page.getByLabel('Score, rule row 2').fill('4')
        await page.getByLabel('When no rule matches', { exact: true }).selectOption('default')
        await page.getByLabel('Score, default result').fill('1')

        await page.getByRole('button', { name: 'Add a test case' }).click()
        await page.getByLabel('Achievement %, test case 1').fill('100')
        await page.getByLabel('Score, expected, test case 1').fill('4')
        await page
                .getByRole('group', { name: 'Test case 1' })
                .getByLabel('Label', { exact: true })
                .fill('Exactly 100%')

        await page.getByLabel('Effective from').fill('2026-10-01')
        await page.getByRole('button', { name: 'Check the rules' }).click()
        await expect(page.getByText('No problems found')).toBeVisible()
        await page.getByRole('button', { name: 'Save draft' }).click()
        await expect(page.getByText('The version is ready to submit to the CHRO.')).toBeVisible()
        await page.getByRole('link', { name: 'Review and submit for approval' }).click()

        // Round trip: download the draft as a workbook and upload it unchanged.
        const download = page.waitForEvent('download')
        await page.getByRole('button', { name: 'Download as Excel' }).click()
        const workbook = testInfo.outputPath('matrix-draft.xlsx')
        await (await download).saveAs(workbook)
        await page.goto('/matrices/upload')
        await page.getByLabel('Excel file (.xlsx, up to 1 MB)').setInputFiles(workbook)
        await page.getByRole('button', { name: 'Check file' }).click()
        await expect(page.getByText('The workbook is valid')).toBeVisible()
        await expect(page.getByText(/Replaces the content of the open draft/).first()).toBeVisible()
        await page.getByRole('button', { name: 'Save as draft' }).click()
        await page.getByRole('link', { name: /^Open version 1 of KSM-/ }).click()

        await expect(page.getByText(/Excel upload · matrix-draft\.xlsx/)).toBeVisible()
        await page.getByRole('button', { name: 'Submit for approval' }).click()
        await expect(page.getByText('Submitted for CHRO approval.')).toBeVisible()
        versionPath = new URL(page.url()).pathname
        await signOut(page)

        // Separation of duties: the CHRO approves, the author cannot.
        await signIn(page, 'demo.chro')
        await page.goto(versionPath)
        await page.getByRole('button', { name: 'Approve…' }).click()
        await page.getByLabel('Approval note (optional)').fill('E2E: synthetic configuration')
        await page.getByRole('button', { name: 'Approve version 1' }).click()
        await expect(page.getByRole('button', { name: 'Publish' })).toBeVisible()
        await signOut(page)

        await signIn(page, 'demo.hrhead')
        await page.goto(versionPath)
        await page.getByRole('button', { name: 'Publish' }).click()
        await expect(
                page.getByText('Published. Earlier versions keep their history.'),
        ).toBeVisible()
        await expect(page.getByText('Published', { exact: true }).first()).toBeVisible()

        // A KPI scored by the new policy (the policy carries the matrix's name).
        await page.goto('/kpi/library/new')
        await page.getByLabel('KPI name').fill(kpiName)
        await page.getByLabel('Unit', { exact: true }).fill('%')
        const policy = page
                .getByLabel('Default scoring rule')
                .locator('option', { hasText: matrixName })
        await page
                .getByLabel('Default scoring rule')
                .selectOption((await policy.getAttribute('value'))!)
        await page.getByLabel('Reporting frequency').selectOption('MONTHLY')
        await page.getByLabel('Monthly values combine into the quarter by').selectOption('AVERAGE')
        await page.getByRole('button', { name: 'Create KPI' }).click()
        await expect(page.getByRole('heading', { level: 1, name: kpiName })).toBeVisible()
})

test('a dual-approved deviation brings the KPI onto a locked sheet, and October data is scored', async ({
        page,
}) => {
        test.setTimeout(180_000)
        expect(versionPath).not.toBe('')
        const sheetId = await sheetIdOf('demo.quality.head', 3, 'DEMO0002')

        await signIn(page, 'demo.quality.head')
        await page.goto(`/kpi/sheets/${sheetId}`)
        await page.getByRole('button', { name: 'Request a deviation…' }).click()
        await page.getByLabel('KPI 3', { exact: true }).selectOption({ label: kpiName })
        await page.getByLabel('Weightage % for KPI 3').fill('40')
        await page.getByLabel('Quarterly target for KPI 3').fill('95')
        await page
                .getByLabel('Reason for the deviation')
                .fill('E2E run: delivery KPI replaces the rejection rate')
        await page.getByRole('button', { name: 'Submit for approval' }).click()
        await expect(
                page.getByRole('heading', { level: 1, name: /^Deviation for Ravi Demo-Kumar/ }),
        ).toBeVisible()
        const deviationPath = new URL(page.url()).pathname
        await signOut(page)

        await signIn(page, 'demo.hrhead.a')
        await page.goto(deviationPath)
        await page.getByRole('button', { name: 'Approve as HR Head' }).click()
        await expect(page.getByRole('button', { name: 'Approve as HR Head' })).toHaveCount(0)
        await signOut(page)

        await signIn(page, 'demo.planthead.a')
        await page.goto(deviationPath)
        await page.getByRole('button', { name: 'Approve as Plant Head' }).click()
        await expect(page.getByText(/^Applied on/)).toBeVisible()
        await signOut(page)

        // October values for the sheet's KPIs, then the quarter's calculation.
        await signIn(page, 'demo.quality.head')
        await page
                .getByRole('navigation', { name: 'Main' })
                .getByRole('link', { name: 'Monthly KPI data' })
                .click()
        await expect(page.getByLabel('Month', { exact: true })).toHaveValue('2026-10')
        const csv = [
                'Employee Code,Plant Code,Department Code,KPI,Period,Actual',
                'DEMO0002,PLT-A,QA,KPI-D01,2026-10,96',
                'DEMO0002,PLT-A,QA,KPI-D04,2026-10,0',
                `DEMO0002,PLT-A,QA,${kpiName},2026-10,97`,
        ].join('\n')
        await page.getByLabel('CSV or Excel file (up to 2 MB)').setInputFiles({
                name: `october-${stamp}.csv`,
                mimeType: 'text/csv',
                buffer: Buffer.from(csv),
        })
        await page.getByRole('button', { name: 'Check file' }).click()
        await expect(page.getByText('The file is valid')).toBeVisible()
        await page.getByRole('button', { name: /^Save 3 values for October 2026$/ }).click()
        await expect(page.getByText('Monthly values saved')).toBeVisible()

        await page.getByRole('link', { name: 'Calculate and review scores' }).click()
        await page.getByRole('button', { name: 'Calculate scores' }).click()
        await expect(page.getByText('Calculation finished')).toBeVisible()
        await page.getByRole('link', { name: 'Ravi Demo-Kumar' }).click()

        // The explanation: source value, matrix version frozen by the deviation, rule and score.
        const kpi = page.getByRole('article', { name: kpiName })
        await expect(kpi.getByText('October 2026: 97 %')).toBeVisible()
        await expect(kpi.getByText(/November 2026:\s*missing/)).toBeVisible()
        await expect(kpi.getByRole('link', { name: /^KSM-\d+ version 1$/ })).toHaveAttribute(
                'href',
                versionPath,
        )
        await expect(kpi.getByText(/^Rule 1: Achievement % is more than 100/)).toBeVisible()
        await expect(kpi.getByText('Provisional')).toBeVisible()
        await expect(page.getByText('Provisional', { exact: true }).first()).toBeVisible()
        await expect(page.getByRole('button', { name: 'Mark as reviewed' })).toHaveCount(0)
})

test('compensation matrix types stay hidden from roles without compensation access', async ({
        page,
}) => {
        await signIn(page, 'demo.quality.head')
        await page.goto('/matrices/new')
        await expect(page.getByRole('heading', { level: 1, name: 'Access denied' })).toBeVisible()
        await page.goto('/matrices')
        await expect(
                page.getByRole('heading', { level: 1, name: 'Configurable matrices' }),
        ).toBeVisible()
        await expect(page.getByText(/Increment matrix/)).toHaveCount(0)
        await expect(page.getByRole('link', { name: 'New matrix' })).toHaveCount(0)
})
