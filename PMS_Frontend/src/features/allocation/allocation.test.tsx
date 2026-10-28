import { screen, within } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import {
        allocBudget,
        allocChro,
        allocCycle,
        allocHead,
        draftDistribution,
        overview,
        proposal,
} from '../../test/allocationFixtures'
import { compCycle } from '../../test/compensationFixtures'
import { employeeOnlyUser } from '../../test/fixtures'
import { installMockApi, reply } from '../../test/mockApi'
import { renderApp } from '../../test/renderApp'

const overviewPath = `/api/allocations/cycles/${allocCycle.id}`
const proposalPath = '/api/allocations/proposals/700'

function body(call: { init: RequestInit }) {
        return JSON.parse(call.init.body as string)
}

describe('allocation access', () => {
        it('gives a Department Head the allocations, but not the budget pages', async () => {
                installMockApi({
                        'GET /api/auth/me': reply(200, allocHead),
                        'GET /api/allocations/cycles': reply(200, [allocCycle]),
                })
                renderApp('/allocations')
                const nav = await screen.findByRole('navigation', { name: 'Main' })
                expect(
                        within(nav).getByRole('link', { name: 'Increment allocations' }),
                ).toBeInTheDocument()
                expect(
                        within(nav).queryByRole('link', { name: 'Compensation & budget' }),
                ).not.toBeInTheDocument()
                const table = await screen.findByRole('table', { name: 'Compensation cycles' })
                expect(
                        within(table).getByRole('row', { name: /Test compensation cycle/ }),
                ).toHaveTextContent('ApprovedVersion 1 published')
        })

        it('is denied to users without budget or allocation access', async () => {
                installMockApi({ 'GET /api/auth/me': reply(200, employeeOnlyUser) })
                renderApp('/allocations')
                expect(
                        await screen.findByRole('heading', { level: 1, name: 'Access denied' }),
                ).toBeInTheDocument()
        })
})

describe('allocation overview', () => {
        it('shows company figures, reconciliation and department rows', async () => {
                installMockApi({
                        'GET /api/auth/me': reply(200, allocChro),
                        [`GET ${overviewPath}`]: reply(200, overview()),
                        [`GET ${overviewPath}/employees`]: reply(200, []),
                })
                renderApp(`/allocations/cycles/${allocCycle.id}`)
                expect(await screen.findByText('Approved company budget (INR)')).toBeInTheDocument()
                expect(screen.getByText('154,500.03')).toBeInTheDocument()
                const rec = screen.getByRole('list', { name: 'Reconciliation' })
                expect(rec).toHaveTextContent(
                        "Department recommendations add up to the approved budget's scenario: yes",
                )
                const table = screen.getByRole('table', { name: 'Department allocations' })
                const a = within(table).getByRole('row', { name: /Test Quality — Test Plant A/ })
                expect(a).toHaveTextContent('Awaiting Admin review')
                expect(within(a).getByRole('link', { name: 'Open version 1' })).toHaveAttribute(
                        'href',
                        '/allocations/proposals/700',
                )
                expect(
                        screen.getByText('Recommendation only (no policy set yet)'),
                ).toBeInTheDocument()
        })

        it('lets a Department Head start a proposal and filters by status', async () => {
                const api = installMockApi({
                        'GET /api/auth/me': reply(200, allocHead),
                        [`GET ${overviewPath}`]: reply(200, overview({ summary: null })),
                        [`GET ${overviewPath}/employees`]: reply(200, []),
                        [`POST ${overviewPath}/proposals`]: reply(
                                201,
                                proposal({ id: 701, plant: overview().units[1].plant }),
                        ),
                        'GET /api/allocations/proposals/701': reply(200, proposal({ id: 701 })),
                })
                const { user } = renderApp(`/allocations/cycles/${allocCycle.id}`)
                await screen.findByRole('table', { name: 'Department allocations' })
                await user.selectOptions(screen.getByLabelText('Proposal status'), 'APPROVED')
                expect(api.callsTo('GET', overviewPath).at(-1)!.query.get('status')).toBe(
                        'APPROVED',
                )
                await user.click(await screen.findByRole('button', { name: 'Start the proposal' }))
                expect(
                        await screen.findByRole('heading', {
                                level: 1,
                                name: /allocation version 1/,
                        }),
                ).toBeInTheDocument()
                expect(body(api.callsTo('POST', `${overviewPath}/proposals`)[0])).toEqual({
                        plant_id: 2,
                        department_id: 10,
                })
        })
})

describe('allocation proposals', () => {
        it('saves a change with its reason and keeps the own line locked', async () => {
                const saved = proposal({
                        changed_count: 1,
                        proposed_total: '120000',
                        remaining_budget: '12000',
                })
                const api = installMockApi({
                        'GET /api/auth/me': reply(200, allocHead),
                        [`GET ${proposalPath}`]: reply(200, proposal()),
                        [`PUT ${proposalPath}`]: reply(200, saved),
                        [`POST ${proposalPath}/submit`]: reply(
                                200,
                                proposal({
                                        ...saved,
                                        status: 'ADMIN_REVIEW',
                                        actions: {
                                                ...saved.actions,
                                                can_edit: false,
                                                can_submit: false,
                                        },
                                }),
                        ),
                })
                const { user } = renderApp('/allocations/proposals/700')
                const own = await screen.findByLabelText('Proposed % for Omar Owner')
                expect(own).toBeDisabled()
                const pct = screen.getByLabelText('Proposed % for Tara Tester')
                await user.clear(pct)
                await user.type(pct, '10')
                await user.type(
                        screen.getByLabelText('Reason for Tara Tester'),
                        'Promotion granted mid-year',
                )
                await user.click(screen.getByRole('button', { name: 'Save the draft' }))
                expect(await screen.findByText('Draft saved.')).toBeInTheDocument()
                expect(body(api.callsTo('PUT', proposalPath)[0])).toEqual({
                        note: null,
                        lines: [
                                {
                                        employee_id: 510,
                                        proposed_percent: '10',
                                        reason: 'Promotion granted mid-year',
                                },
                                { employee_id: 511, proposed_percent: '7.5', reason: null },
                        ],
                })
                await user.click(screen.getByRole('button', { name: 'Submit for review' }))
                expect(await screen.findByText('Submitted for Admin review.')).toBeInTheDocument()
        })

        it('requires a reason before the CHRO approves', async () => {
                const inReview = proposal({
                        status: 'CHRO_REVIEW',
                        actions: {
                                ...proposal().actions,
                                can_edit: false,
                                can_submit: false,
                                can_approve: true,
                                can_reject: true,
                                can_return: true,
                        },
                })
                const api = installMockApi({
                        'GET /api/auth/me': reply(200, allocChro),
                        [`GET ${proposalPath}`]: reply(200, inReview),
                        [`POST ${proposalPath}/approve`]: reply(
                                200,
                                proposal({
                                        status: 'APPROVED',
                                        decided_by: { id: 53, username: 'test.al.chro' },
                                        decided_at: '2031-04-05T09:00:00Z',
                                        decision_reason: 'Within the department budget',
                                        actions: {
                                                ...inReview.actions,
                                                can_approve: false,
                                                can_reject: false,
                                                can_return: false,
                                        },
                                }),
                        ),
                })
                const { user } = renderApp('/allocations/proposals/700')
                await user.click(await screen.findByRole('button', { name: 'Approve…' }))
                await user.type(
                        screen.getByLabelText('Reason for approving these allocations'),
                        'Too short',
                )
                await user.click(screen.getByRole('button', { name: 'Approve the allocations' }))
                expect(screen.getByText('Enter at least 10 characters.')).toBeInTheDocument()
                expect(api.callsTo('POST', `${proposalPath}/approve`)).toHaveLength(0)
                await user.type(
                        screen.getByLabelText('Reason for approving these allocations'),
                        ' fine',
                )
                await user.click(screen.getByRole('button', { name: 'Approve the allocations' }))
                expect(await screen.findByText('Approved.')).toBeInTheDocument()
                expect(body(api.callsTo('POST', `${proposalPath}/approve`)[0])).toEqual({
                        reason: 'Too short fine',
                })
        })

        it('offers a refresh when the sources changed', async () => {
                const stale = proposal({
                        stale_reasons: [
                                "The unit's distributed budget changed from 132000 to 140000.",
                        ],
                        actions: { ...proposal().actions, can_refresh: true, can_submit: false },
                })
                const api = installMockApi({
                        'GET /api/auth/me': reply(200, allocHead),
                        [`GET ${proposalPath}`]: reply(200, stale),
                        [`POST ${proposalPath}/refresh`]: reply(
                                200,
                                proposal({ unit_budget: '140000' }),
                        ),
                })
                const { user } = renderApp('/allocations/proposals/700')
                expect(await screen.findByText('This version is out of date')).toBeInTheDocument()
                expect(
                        screen.queryByRole('button', { name: 'Submit for review' }),
                ).not.toBeInTheDocument()
                await user.click(
                        screen.getByRole('button', { name: 'Refresh from the current budget' }),
                )
                expect(
                        await screen.findByText('Brought up to date with the current budget.'),
                ).toBeInTheDocument()
                expect(api.callsTo('POST', `${proposalPath}/refresh`)).toHaveLength(1)
        })

        it('shows a budget-only reader no employee amounts', async () => {
                installMockApi({
                        'GET /api/auth/me': reply(200, allocBudget),
                        [`GET ${proposalPath}`]: reply(
                                200,
                                proposal({
                                        lines: null,
                                        excluded: null,
                                        suppressed: true,
                                        recommended_total: null,
                                        proposed_total: null,
                                        remaining_budget: null,
                                        actions: {
                                                ...proposal().actions,
                                                can_edit: false,
                                                can_submit: false,
                                        },
                                }),
                        ),
                })
                renderApp('/allocations/proposals/700')
                expect(
                        await screen.findByText(/visible only to compensation roles/),
                ).toBeInTheDocument()
                expect(
                        screen.getByText(
                                'Amounts are hidden: fewer than 3 employees are included.',
                        ),
                ).toBeInTheDocument()
                expect(screen.queryByText('Tara Tester')).not.toBeInTheDocument()
        })
})

describe('distribution', () => {
        it('lets the budget owner save and publish a draft', async () => {
                const api = installMockApi({
                        'GET /api/auth/me': reply(200, allocBudget),
                        'GET /api/allocations/distributions/601': reply(200, draftDistribution()),
                        'GET /api/org-units': reply(200, [
                                {
                                        plant_department_id: 1,
                                        plant: { id: 1, code: 'TP-A', name: 'Test Plant A' },
                                        department: { id: 10, code: 'TQ', name: 'Test Quality' },
                                        is_active: true,
                                },
                                {
                                        plant_department_id: 2,
                                        plant: { id: 2, code: 'TP-B', name: 'Test Plant B' },
                                        department: { id: 10, code: 'TQ', name: 'Test Quality' },
                                        is_active: true,
                                },
                        ]),
                        'PUT /api/allocations/distributions/601': reply(200, draftDistribution()),
                        'POST /api/allocations/distributions/601/publish': reply(
                                200,
                                draftDistribution({
                                        status: 'PUBLISHED',
                                        actions: {
                                                can_edit: false,
                                                can_publish: false,
                                                can_start_revision: false,
                                        },
                                }),
                        ),
                })
                const { user } = renderApp('/allocations/distributions/601')
                const amount = await screen.findByLabelText('Test Quality — Test Plant A: amount')
                await user.clear(amount)
                await user.type(amount, '130000')
                await user.selectOptions(screen.getByLabelText('Add a plant'), '2')
                await user.click(screen.getByRole('button', { name: 'Add' }))
                await user.type(screen.getByLabelText('Test Plant B: amount'), '23000')
                await user.click(screen.getByRole('button', { name: 'Save the draft' }))
                expect(await screen.findByText('Draft saved.')).toBeInTheDocument()
                expect(body(api.callsTo('PUT', '/api/allocations/distributions/601')[0])).toEqual({
                        allow_mixed_methods: false,
                        note: null,
                        plants: [
                                {
                                        plant_id: 1,
                                        method: 'AMOUNT',
                                        value: '137000',
                                        units: [
                                                {
                                                        department_id: 10,
                                                        method: 'AMOUNT',
                                                        value: '130000',
                                                },
                                        ],
                                },
                                { plant_id: 2, method: 'AMOUNT', value: '23000', units: [] },
                        ],
                })
                await user.click(screen.getByRole('button', { name: 'Publish this version' }))
                expect(
                        await screen.findByText(
                                'Published. Departments now propose against this version.',
                        ),
                ).toBeInTheDocument()
        })
})

describe('budget revision', () => {
        it('lets the CHRO reopen an approved budget with a reason', async () => {
                const finalized = {
                        ...compCycle,
                        status: 'FINALIZED' as const,
                        finalized_at: '2031-04-01T09:00:00Z',
                        actions: { ...compCycle.actions, can_manage: false, can_reopen: true },
                }
                const api = installMockApi({
                        'GET /api/auth/me': reply(200, allocChro),
                        [`GET /api/compensation/cycles/${compCycle.id}`]: reply(200, finalized),
                        [`POST /api/compensation/cycles/${compCycle.id}/reopen`]: reply(200, {
                                ...finalized,
                                status: 'OPEN',
                                revision_no: 1,
                                reopened_by: { id: 53, username: 'test.al.chro' },
                                reopened_at: '2031-04-06T09:00:00Z',
                                reopen_reason: 'A quarter correction changed results',
                                actions: { ...finalized.actions, can_reopen: false },
                        }),
                })
                const { user } = renderApp(`/compensation/cycles/${compCycle.id}`)
                expect(
                        await screen.findByRole('link', { name: 'Open the allocations' }),
                ).toHaveAttribute('href', `/allocations/cycles/${compCycle.id}`)
                await user.click(screen.getByRole('button', { name: 'Reopen for revision…' }))
                await user.type(
                        screen.getByLabelText('Why does the approved budget need a revision?'),
                        'A quarter correction changed results',
                )
                await user.click(
                        screen.getByRole('button', { name: 'Reopen the budget for revision' }),
                )
                expect(await screen.findByText('Budget revision 1 in progress')).toBeInTheDocument()
                expect(
                        body(
                                api.callsTo(
                                        'POST',
                                        `/api/compensation/cycles/${compCycle.id}/reopen`,
                                )[0],
                        ),
                ).toEqual({
                        reason: 'A quarter correction changed results',
                })
        })
})
