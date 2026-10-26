/**
 * Stage J against the demo seed (PMS_Backend/app/seed/demo_data.py).
 *
 * The e2e database keeps data between runs, so every test here can run
 * repeatedly: JD titles are unique per run, and the KPI sheet test reopens a
 * sheet published by an earlier run. Nothing here starts quarterly scoring,
 * which would lock the demo quarter permanently.
 */
import { expect, test, type Page } from '@playwright/test'
import { collectConsoleErrors, signIn } from './helpers'

let consoleErrors: string[] = []

test.beforeEach(({ page }) => {
        consoleErrors = collectConsoleErrors(page)
})

test.afterEach(() => {
        expect(consoleErrors).toEqual([])
})

async function signOut(page: Page) {
        await page.getByRole('button', { name: 'Sign out' }).click()
        await expect(page.getByText('You have been signed out.')).toBeVisible()
}

test('a role-specific JD goes through HOD, Plant Head and CHRO sign-off', async ({ page }) => {
        const title = `E2E Quality Inspector ${Date.now()}`

        await signIn(page, 'demo.quality.head')
        await page
                .getByRole('navigation', { name: 'Main' })
                .getByRole('link', { name: 'Job descriptions' })
                .click()
        await page.getByRole('link', { name: 'New JD' }).click()
        await page.getByLabel('Role title').fill(title)
        await page.getByLabel('Department', { exact: true }).selectOption({ label: 'Quality' })
        await page.getByLabel('Plant', { exact: true }).selectOption({ label: 'Demo Plant A' })
        await expect(page.getByLabel('Available budget for the department')).toBeDisabled()
        await page.getByLabel('No. of vacancies').fill('1')
        await page.getByLabel('Vacancy type').selectOption({ label: 'New position' })
        await page.getByLabel('Heading 1', { exact: true }).fill('Inspection')
        await page
                .getByLabel('Responsibilities under heading 1')
                .fill('Inspect incoming parts\nRelease approved lots')
        await page
                .getByLabel('Technical competencies 1', { exact: true })
                .fill('Measurement systems')
        await page.getByRole('button', { name: 'Create draft' }).click()

        await expect(page.getByRole('heading', { level: 1, name: title })).toBeVisible()
        await page.getByRole('button', { name: 'Propose (HOD)' }).click()
        await expect(
                page.getByRole('button', { name: /Proposed · awaiting Plant Head/ }),
        ).toBeVisible()
        const jdUrl = page.url()
        await signOut(page)

        await signIn(page, 'demo.planthead.a')
        await page.goto(jdUrl)
        await page.getByRole('button', { name: 'Authorise (Plant Head)' }).click()
        await expect(page.getByRole('button', { name: /Authorised · awaiting CHRO/ })).toBeVisible()
        await signOut(page)

        await signIn(page, 'demo.chro')
        await page.goto(jdUrl)
        await page.getByRole('button', { name: 'Approve (CHRO)' }).click()
        await expect(page.getByRole('button', { name: /v1 · Approved/ })).toBeVisible()
        const signOff = page.getByRole('region', { name: 'Sign-off' })
        await expect(signOff.getByText(/^demo\.quality\.head,/)).toBeVisible()
        await expect(signOff.getByText(/^demo\.planthead\.a,/)).toBeVisible()
        await expect(signOff.getByText(/^demo\.chro,/)).toBeVisible()
})

test('a Department Head sets and publishes a quarterly KPI sheet totalling 100%', async ({
        page,
}) => {
        await signIn(page, 'demo.quality.head')
        await page
                .getByRole('navigation', { name: 'Main' })
                .getByRole('link', { name: 'KPI sheets', exact: true })
                .click()
        await expect(
                page.getByRole('heading', { level: 1, name: 'Quarterly KPI sheets' }),
        ).toBeVisible()
        await expect(page.getByLabel('Quarter', { exact: true })).toHaveValue(/\d+/)

        // DEMO0001 (Asha Demo-Rao) in Quality at Plant A: create the sheet, or open the one an
        // earlier run made. (She also supports Quality at Plant B: a separate sheet.)
        const unit = 'Asha Demo-Rao, Quality — Demo Plant A'
        const create = page.getByRole('button', { name: `Create KPI sheet for ${unit}` })
        const open = page.getByRole('link', { name: `Open KPI sheet of ${unit}` })
        await expect(create.or(open)).toBeVisible()
        if (await create.isVisible()) await create.click()
        else await open.click()

        const reopen = page.getByRole('button', { name: 'Reopen for changes…' })
        const addKpi = page.getByRole('button', { name: 'Add KPI' })
        await expect(reopen.or(addKpi)).toBeVisible()
        if (await reopen.isVisible()) {
                await reopen.click()
                await page
                        .getByLabel('Why does this sheet need to change?')
                        .fill('E2E run: revise targets')
                await page.getByRole('button', { name: 'Reopen as draft' }).click()
                await expect(page.getByText('Reopened as a draft.')).toBeVisible()
        }
        // Start from an empty sheet.
        const remove = page.getByRole('button', { name: /^Remove KPI \d+$/ })
        while ((await remove.count()) > 0) await remove.first().click()

        await addKpi.click()
        await addKpi.click()
        await addKpi.click()
        await page.getByLabel('KPI 1', { exact: true }).selectOption({ label: 'Profit vs plan' })
        await page.getByLabel('Weightage % for KPI 1').fill('40')
        await page.getByLabel('Quarterly target for KPI 1').fill('120')
        await page
                .getByLabel('KPI 2', { exact: true })
                .selectOption({ label: 'Customer quality claims and complaints' })
        await page.getByLabel('Weightage % for KPI 2').fill('33.33')
        await page
                .getByLabel('KPI 3', { exact: true })
                .selectOption({ label: 'Internal rejection rate' })
        await page.getByLabel('Weightage % for KPI 3').fill('26.66')
        await page.getByLabel('Quarterly target for KPI 3').fill('2.5')
        await expect(page.getByText('0.01% still to allocate.')).toBeVisible()

        await page.getByRole('button', { name: 'Save and publish' }).click()
        await expect(
                page.getByText('Weightages must total exactly 100% before publishing.'),
        ).toBeVisible()

        await page.getByLabel('Weightage % for KPI 3').fill('26.67')
        await expect(page.getByText('Weightages total 100%.')).toBeVisible()
        await page.getByRole('button', { name: 'Save and publish' }).click()
        await expect(page.getByText(/^Published\. The KPIs lock/)).toBeVisible()
        await expect(page.getByRole('cell', { name: '100.00%' })).toBeVisible()
})

test('the upload template downloads with the session cookie', async ({ page }) => {
        await signIn(page, 'demo.quality.head')
        await page.goto('/kpi/upload')
        const download = page.waitForEvent('download')
        await page.getByRole('button', { name: 'Download template' }).click()
        expect((await download).suggestedFilename()).toBe('kpi-upload-template.xlsx')
})

test('read-only users see KPI setup but no upload or editing', async ({ page }) => {
        await signIn(page, 'demo.budget')
        const nav = page.getByRole('navigation', { name: 'Main' })
        await expect(nav.getByRole('link', { name: 'KPI library' })).toBeVisible()
        await expect(nav.getByRole('link', { name: 'Excel upload' })).toHaveCount(0)
        await nav.getByRole('link', { name: 'KPI library' }).click()
        await expect(page.getByRole('table', { name: 'KPI library' })).toBeVisible()
        await expect(page.getByRole('link', { name: 'New KPI' })).toHaveCount(0)
})
