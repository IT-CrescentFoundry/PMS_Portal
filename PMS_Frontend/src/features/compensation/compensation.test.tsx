import { screen, within } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { annualCycle } from '../../test/annualFixtures'
import {
        budgetOnlyScenario,
        compBudgetUser,
        compChro,
        compCycle,
        compHrHead,
        compScenario,
        validBaselinePreview,
} from '../../test/compensationFixtures'
import { employeeOnlyUser } from '../../test/fixtures'
import { installMockApi, reply } from '../../test/mockApi'
import { renderApp } from '../../test/renderApp'
import { money, percent } from './compensationLabels'

const cyclePath = `/api/compensation/cycles/${compCycle.id}`
const scenarioPath = '/api/compensation/scenarios/300'

function body(call: { init: RequestInit }) {
        return JSON.parse(call.init.body as string)
}

describe('compensation labels', () => {
        it('formats amounts and percentages from exact text, never via floating point', () => {
                expect(money('1234567.5')).toBe('1,234,567.50')
                expect(money('-4500.03', 'INR')).toBe('INR −4,500.03')
                expect(money('0.005')).toBe('0.005')
                expect(money('99999999999999.99')).toBe('99,999,999,999,999.99')
                expect(money(null)).toBe('—')
                expect(percent('7.5')).toBe('7.50 %')
                expect(percent(null)).toBe('—')
        })
})

describe('compensation cycles', () => {
        it('lets the HR Head create a cycle', async () => {
                const api = installMockApi({
                        'GET /api/auth/me': reply(200, compHrHead),
                        'GET /api/compensation/cycles': reply(200, []),
                        'GET /api/annual/cycles': reply(200, [annualCycle]),
                        'POST /api/compensation/cycles': reply(201, compCycle),
                        [`GET ${cyclePath}`]: reply(200, compCycle),
                })
                const { user } = renderApp('/compensation')
                expect(await screen.findByText('No compensation cycle yet')).toBeInTheDocument()
                await user.click(screen.getByRole('button', { name: 'New compensation cycle' }))
                const form = screen.getByRole('form', { name: 'Compensation cycle' })
                await user.click(within(form).getByRole('button', { name: 'Create the cycle' }))
                expect(
                        within(form).getByText('Choose how compa-ratio affects increments.'),
                ).toBeInTheDocument()
                expect(api.callsTo('POST', '/api/compensation/cycles')).toHaveLength(0)

                await user.type(within(form).getByLabelText('Code'), 'TST-CMP')
                await user.type(within(form).getByLabelText('Name'), 'Test compensation cycle')
                await user.selectOptions(
                        await within(form).findByRole('combobox', {
                                name: 'Annual results from (PMS cycle)',
                        }),
                        'Test annual cycle',
                )
                await user.type(within(form).getByLabelText('Effective date'), '2031-04-01')
                await user.type(
                        within(form).getByLabelText(/Compa-ratio reference/),
                        'Test reference salary',
                )
                await user.selectOptions(
                        within(form).getByLabelText('How compa-ratio affects the increment'),
                        'MATRIX_INPUT',
                )
                await user.click(within(form).getByRole('button', { name: 'Create the cycle' }))
                expect(
                        await screen.findByRole('heading', {
                                level: 1,
                                name: 'Test compensation cycle',
                        }),
                ).toBeInTheDocument()
                expect(body(api.callsTo('POST', '/api/compensation/cycles')[0])).toEqual({
                        code: 'TST-CMP',
                        name: 'Test compensation cycle',
                        pms_cycle_id: annualCycle.id,
                        currency: 'INR',
                        effective_date: '2031-04-01',
                        cr_method: 'MATRIX_INPUT',
                        reference_label: 'Test reference salary',
                        notes: null,
                })
        })

        it('marks unapproved matrix types as awaiting configuration', async () => {
                installMockApi({
                        'GET /api/auth/me': reply(200, compHrHead),
                        [`GET ${cyclePath}`]: reply(200, compCycle),
                })
                renderApp(`/compensation/cycles/${compCycle.id}`)
                const list = await screen.findByRole('list', { name: 'Compensation matrices' })
                const items = within(list).getAllByRole('listitem')
                expect(items[0]).toHaveTextContent(
                        'KRA performance matrixApprovedKRM-TST version 1',
                )
                expect(items[1]).toHaveTextContent(
                        'Increment matrixAwaiting approved configuration',
                )
                expect(
                        screen.getByRole('form', { name: 'Calculate a scenario' }),
                ).toBeInTheDocument()
                expect(
                        screen.queryByRole('form', { name: 'Record the approved budget' }),
                ).not.toBeInTheDocument()
        })

        it('lets the budget owner record the approved budget with a reason', async () => {
                const recorded = {
                        ...compCycle,
                        decisions: [
                                {
                                        id: 7,
                                        version_no: 1,
                                        status: 'CURRENT' as const,
                                        approved_amount: '10000.00',
                                        previous_amount: null,
                                        reason: 'Board approval minute 12',
                                        recorded_by: { id: 42, username: 'test.comp.budget' },
                                        recorded_at: '2031-03-03T09:00:00Z',
                                },
                        ],
                }
                const budgetView = {
                        ...compCycle,
                        actions: {
                                can_manage: false,
                                can_record_budget: true,
                                can_approve: false,
                                can_read_employees: false,
                        },
                }
                const api = installMockApi({
                        'GET /api/auth/me': reply(200, compBudgetUser),
                        [`GET ${cyclePath}`]: reply(200, budgetView),
                        [`POST ${cyclePath}/budget-decisions`]: reply(201, {
                                ...recorded,
                                actions: budgetView.actions,
                        }),
                })
                const { user } = renderApp(`/compensation/cycles/${compCycle.id}`)
                const form = await screen.findByRole('form', { name: 'Record the approved budget' })
                expect(
                        screen.queryByRole('form', { name: 'Calculate a scenario' }),
                ).not.toBeInTheDocument()
                expect(
                        screen.queryByRole('link', { name: 'Import a salary baseline' }),
                ).not.toBeInTheDocument()
                await user.type(
                        within(form).getByLabelText('Company-approved budget (INR)'),
                        '10000.123',
                )
                await user.type(
                        within(form).getByLabelText('Reason or source of the decision'),
                        'Board',
                )
                await user.click(
                        within(form).getByRole('button', { name: 'Record the approved budget' }),
                )
                expect(
                        within(form).getByText('Enter an amount with at most two decimals.'),
                ).toBeInTheDocument()
                expect(within(form).getByText(/at least 10 characters/)).toBeInTheDocument()

                await user.clear(within(form).getByLabelText('Company-approved budget (INR)'))
                await user.type(
                        within(form).getByLabelText('Company-approved budget (INR)'),
                        '10000.00',
                )
                await user.type(
                        within(form).getByLabelText('Reason or source of the decision'),
                        ' approval minute 12',
                )
                await user.click(
                        within(form).getByRole('button', { name: 'Record the approved budget' }),
                )
                expect(await screen.findByText('Approved budget recorded.')).toBeInTheDocument()
                expect(screen.getByText('INR 10,000.00')).toBeInTheDocument()
                expect(body(api.callsTo('POST', `${cyclePath}/budget-decisions`)[0])).toEqual({
                        amount: '10000.00',
                        reason: 'Board approval minute 12',
                })
        })
})

describe('salary baseline import', () => {
        it('shows problems and saves nothing until the file is valid', async () => {
                const api = installMockApi({
                        'GET /api/auth/me': reply(200, compHrHead),
                        [`GET ${cyclePath}`]: reply(200, compCycle),
                        [`POST ${cyclePath}/baseline/preview`]: [
                                reply(200, {
                                        ...validBaselinePreview,
                                        issues: [
                                                {
                                                        message: 'Employee T0001 appears more than once; one row per employee.',
                                                        field: 'Employee Code',
                                                        row: 3,
                                                },
                                        ],
                                        ready: false,
                                }),
                                reply(200, validBaselinePreview),
                        ],
                        [`POST ${cyclePath}/baseline/confirm`]: reply(201, {
                                id: 96,
                                version_no: 2,
                                file_name: 'baseline.csv',
                                row_count: 2,
                                imported_by: null,
                                created_at: '2031-03-04T09:00:00Z',
                        }),
                })
                const { user } = renderApp(`/compensation/cycles/${compCycle.id}/baseline`)
                const input = await screen.findByLabelText(
                        'Salary baseline (.xlsx or .csv, up to 2 MB)',
                )
                const file = new File(['Employee Code,Current Salary'], 'baseline.csv', {
                        type: 'text/csv',
                })
                await user.upload(input, file)
                await user.click(screen.getByRole('button', { name: 'Check the file' }))
                const problems = await screen.findByRole('table', { name: 'Problems in the file' })
                expect(within(problems).getByText(/appears more than once/)).toBeInTheDocument()
                expect(
                        screen.queryByRole('button', { name: 'Save the baseline' }),
                ).not.toBeInTheDocument()

                await user.click(screen.getByRole('button', { name: 'Check the file' }))
                const rows = await screen.findByRole('table', { name: 'Rows in the file' })
                expect(within(rows).getByText('Joined after the cut-off')).toBeInTheDocument()
                expect(within(rows).getByText('100,000.00')).toBeInTheDocument()
                expect(
                        screen.getByText('1 employee has no approved annual result yet.'),
                ).toBeInTheDocument()
                await user.click(screen.getByRole('button', { name: 'Save the baseline' }))
                expect(await screen.findByText('Saved as baseline version 2')).toBeInTheDocument()
                expect(api.callsTo('POST', `${cyclePath}/baseline/confirm`)).toHaveLength(1)
                const sent = api.callsTo('POST', `${cyclePath}/baseline/confirm`)[0].init
                        .body as FormData
                expect((sent.get('file') as File).name).toBe('baseline.csv')
        })

        it('is not offered to readers who cannot manage compensation', async () => {
                installMockApi({
                        'GET /api/auth/me': reply(200, compChro),
                        [`GET ${cyclePath}`]: reply(200, {
                                ...compCycle,
                                actions: { ...compCycle.actions, can_manage: false },
                        }),
                })
                renderApp(`/compensation/cycles/${compCycle.id}/baseline`)
                expect(
                        await screen.findByRole('heading', { level: 1, name: 'Access denied' }),
                ).toBeInTheDocument()
        })
})

describe('budget scenarios', () => {
        it('shows the requirement, the variance and how each proposal was calculated', async () => {
                installMockApi({
                        'GET /api/auth/me': reply(200, compHrHead),
                        [`GET ${scenarioPath}`]: reply(200, {
                                ...compScenario(),
                                actions: {
                                        can_submit: false,
                                        can_approve: false,
                                        can_reject: false,
                                },
                        }),
                })
                const { user } = renderApp('/compensation/scenarios/300')
                expect(
                        await screen.findByRole('heading', {
                                level: 1,
                                name: 'Scenario 1: Initial requirement',
                        }),
                ).toBeInTheDocument()
                expect(screen.getByText('Over budget')).toBeInTheDocument()
                expect(screen.getByText(/Overspend of INR 2,000.00/)).toBeInTheDocument()
                expect(screen.getByText(/never changed to fit the budget/)).toBeInTheDocument()
                const lines = screen.getByRole('table', { name: 'Employee proposals' })
                const tess = within(lines).getByRole('row', { name: /Tess Person/ })
                expect(
                        within(tess)
                                .getAllByRole('cell')
                                .map((c) => c.textContent)
                                .slice(1),
                ).toEqual(['4.20', '0.8000', '5', '12.00 %', '12,000.00', '112,000.00'])
                await user.click(within(tess).getByText('How this was calculated'))
                const steps = within(tess).getByRole('list', {
                        name: 'How the proposal for Tess Person was calculated',
                })
                expect(steps).toHaveTextContent('INR 100,000.00 ÷ INR 125,000.00 = 0.8 → 0.8000')
                expect(
                        within(steps).getByRole('link', { name: 'KRM-TST version 1' }),
                ).toHaveAttribute('href', '/matrices/81/versions/801')
                const theo = within(lines).getByRole('row', { name: /Theo Tester/ })
                expect(theo).toHaveTextContent('Excluded: Not eligible')
                expect(
                        screen.getByRole('table', { name: 'Excluded employees by reason' }),
                ).toHaveTextContent('Not eligible1')
                expect(screen.queryByRole('button', { name: 'Approve…' })).not.toBeInTheDocument()
        })

        it('requires a reason before the CHRO approves the final budget', async () => {
                const api = installMockApi({
                        'GET /api/auth/me': reply(200, compChro),
                        [`GET ${scenarioPath}`]: reply(200, compScenario()),
                        [`POST ${scenarioPath}/approve`]: reply(
                                200,
                                compScenario({
                                        status: 'FINALIZED',
                                        decided_by: { id: 43, username: 'test.comp.chro' },
                                        decided_at: '2031-03-05T09:00:00Z',
                                        decision_reason: 'Approved within the board envelope',
                                        actions: {
                                                can_submit: false,
                                                can_approve: false,
                                                can_reject: false,
                                        },
                                }),
                        ),
                })
                const { user } = renderApp('/compensation/scenarios/300')
                await user.click(await screen.findByRole('button', { name: 'Approve…' }))
                await user.type(
                        screen.getByLabelText(
                                'Reason for approving this scenario as the final budget',
                        ),
                        'Too short',
                )
                await user.click(screen.getByRole('button', { name: 'Approve the final budget' }))
                expect(screen.getByText('Enter at least 10 characters.')).toBeInTheDocument()
                expect(api.callsTo('POST', `${scenarioPath}/approve`)).toHaveLength(0)
                await user.clear(
                        screen.getByLabelText(
                                'Reason for approving this scenario as the final budget',
                        ),
                )
                await user.type(
                        screen.getByLabelText(
                                'Reason for approving this scenario as the final budget',
                        ),
                        'Approved within the board envelope',
                )
                await user.click(screen.getByRole('button', { name: 'Approve the final budget' }))
                expect(await screen.findByText('Approved as the final budget.')).toBeInTheDocument()
                expect(body(api.callsTo('POST', `${scenarioPath}/approve`)[0])).toEqual({
                        reason: 'Approved within the board envelope',
                })
                expect(screen.queryByRole('button', { name: 'Approve…' })).not.toBeInTheDocument()
        })

        it('shows a budget-only reader totals without employee amounts', async () => {
                installMockApi({
                        'GET /api/auth/me': reply(200, compBudgetUser),
                        [`GET ${scenarioPath}`]: reply(200, budgetOnlyScenario()),
                })
                renderApp('/compensation/scenarios/300')
                expect(
                        await screen.findByText(
                                'Employee-level amounts are visible only to compensation roles.',
                        ),
                ).toBeInTheDocument()
                expect(
                        screen.queryByRole('table', { name: 'Employee proposals' }),
                ).not.toBeInTheDocument()
                const units = screen.getByRole('table', {
                        name: 'Requirement by plant and department',
                })
                expect(
                        within(units).getByText('Hidden: fewer than 3 employees'),
                ).toBeInTheDocument()
                expect(screen.queryByText('Tess Person')).not.toBeInTheDocument()
        })

        it('warns when a scenario is out of date or analysis only', async () => {
                installMockApi({
                        'GET /api/auth/me': reply(200, compHrHead),
                        [`GET ${scenarioPath}`]: reply(
                                200,
                                compScenario({
                                        status: 'CALCULATED',
                                        analysis_only: true,
                                        stale_reasons: [
                                                'KRM-TST version 1 is no longer the published version in force.',
                                        ],
                                        actions: {
                                                can_submit: false,
                                                can_approve: false,
                                                can_reject: false,
                                        },
                                }),
                        ),
                })
                renderApp('/compensation/scenarios/300')
                expect(await screen.findByText('This scenario is out of date')).toBeInTheDocument()
                expect(
                        screen.getByText(/can’t be submitted or produce a final decision/),
                ).toBeInTheDocument()
                expect(
                        screen.queryByRole('button', { name: 'Submit to the CHRO' }),
                ).not.toBeInTheDocument()
        })
})

describe('compensation access', () => {
        it('is denied to users without budget access, and hidden from their navigation', async () => {
                installMockApi({ 'GET /api/auth/me': reply(200, employeeOnlyUser) })
                renderApp('/compensation')
                expect(
                        await screen.findByRole('heading', { level: 1, name: 'Access denied' }),
                ).toBeInTheDocument()
                const nav = screen.getByRole('navigation', { name: 'Main' })
                expect(
                        within(nav).queryByRole('link', { name: 'Compensation & budget' }),
                ).not.toBeInTheDocument()
        })

        it('appears in the navigation of the budget owner', async () => {
                installMockApi({
                        'GET /api/auth/me': reply(200, compBudgetUser),
                        'GET /api/compensation/cycles': reply(200, [compCycle]),
                })
                renderApp('/compensation')
                const nav = await screen.findByRole('navigation', { name: 'Main' })
                expect(
                        within(nav).getByRole('link', { name: 'Compensation & budget' }),
                ).toBeInTheDocument()
                expect(
                        await screen.findByRole('link', { name: 'Test compensation cycle' }),
                ).toBeInTheDocument()
                expect(
                        screen.queryByRole('button', { name: 'New compensation cycle' }),
                ).not.toBeInTheDocument()
        })
})
