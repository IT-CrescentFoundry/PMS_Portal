import { screen, within } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { employeeOnlyUser } from '../../test/fixtures'
import { deptHeadUser, q1 } from '../../test/kpiFixtures'
import { chroUser, matrixHrHead, resultDetail } from '../../test/matrixFixtures'
import { installMockApi, reply } from '../../test/mockApi'
import {
        cohort,
        employeeResult,
        overview,
        ownSheet,
        scoringQuarter,
} from '../../test/quarterlyFixtures'
import { renderApp } from '../../test/renderApp'

const overviewPath = `/api/kpi/quarters/${scoringQuarter.id}/overview`
const transitionPath = `/api/kpi/quarters/${scoringQuarter.id}/transition`
const publishPath = `/api/kpi/quarters/${scoringQuarter.id}/publish`

describe('quarter overview', () => {
        it('shows the step, the counts and what blocks the next step', async () => {
                installMockApi({
                        'GET /api/auth/me': reply(200, matrixHrHead),
                        'GET /api/kpi/quarters': reply(200, [q1, scoringQuarter]),
                        [`GET ${overviewPath}`]: reply(
                                200,
                                overview({
                                        blockers: [
                                                'Tess Person (Test Quality — Test Plant A): data for May 2026 is missing.',
                                        ],
                                }),
                        ),
                })
                renderApp('/scores/quarter')
                const steps = await screen.findByRole('list', { name: 'Quarter steps' })
                const current = within(steps)
                        .getAllByRole('listitem')
                        .find((li) => li.getAttribute('aria-current') === 'step')
                expect(current).toHaveTextContent('2. Data collection')
                expect(within(steps).getByText(/KPI setup/)).toHaveTextContent('(done)')

                expect(screen.getByText('Weights needed').closest('div')).toHaveTextContent('1')
                expect(screen.getByText('1 item to resolve first')).toBeInTheDocument()
                expect(screen.getByText(/data for May 2026 is missing/)).toBeInTheDocument()
                // Missing data blocks the step: it is never treated as zero.
                expect(
                        screen.getByRole('button', { name: 'Move to Department review' }),
                ).toBeDisabled()
        })

        it('moves the quarter one step when every check passes', async () => {
                const api = installMockApi({
                        'GET /api/auth/me': reply(200, matrixHrHead),
                        'GET /api/kpi/quarters': reply(200, [scoringQuarter]),
                        [`GET ${overviewPath}`]: reply(200, overview()),
                        [`POST ${transitionPath}`]: reply(
                                200,
                                overview({
                                        quarter: { ...scoringQuarter, status: 'DEPARTMENT_REVIEW' },
                                        next_status: 'NORMALIZATION',
                                        previous_status: 'OPEN',
                                        actions: {
                                                can_advance: true,
                                                can_return: true,
                                                can_publish: false,
                                                can_request_correction: false,
                                        },
                                }),
                        ),
                })
                const { user } = renderApp('/scores/quarter')
                expect(
                        await screen.findByText('Every check for this step passes company-wide.'),
                ).toBeInTheDocument()
                await user.click(screen.getByRole('button', { name: 'Move to Department review' }))

                expect(await screen.findByText('Moved to Department review.')).toBeInTheDocument()
                const [call] = api.callsTo('POST', transitionPath)
                expect(JSON.parse(call.init.body as string)).toEqual({
                        to: 'DEPARTMENT_REVIEW',
                        reason: null,
                })
                expect(
                        screen.getByRole('button', { name: 'Move to Normalization' }),
                ).toBeInTheDocument()
                expect(
                        screen.getByRole('button', { name: 'Return to Data collection…' }),
                ).toBeInTheDocument()
        })

        it('returns the quarter a step only with a reason', async () => {
                const api = installMockApi({
                        'GET /api/auth/me': reply(200, matrixHrHead),
                        'GET /api/kpi/quarters': reply(200, [scoringQuarter]),
                        [`GET ${overviewPath}`]: reply(
                                200,
                                overview({
                                        quarter: { ...scoringQuarter, status: 'DEPARTMENT_REVIEW' },
                                        next_status: 'NORMALIZATION',
                                        previous_status: 'OPEN',
                                        actions: {
                                                can_advance: true,
                                                can_return: true,
                                                can_publish: false,
                                                can_request_correction: false,
                                        },
                                }),
                        ),
                        [`POST ${transitionPath}`]: reply(200, overview()),
                })
                const { user } = renderApp('/scores/quarter')
                await user.click(
                        await screen.findByRole('button', { name: 'Return to Data collection…' }),
                )
                const reason = screen.getByLabelText(
                        'Why does the quarter return to data collection?',
                )
                await user.type(reason, 'Too short')
                await user.click(screen.getByRole('button', { name: 'Return to Data collection' }))
                expect(screen.getByText('Enter at least 10 characters.')).toBeInTheDocument()
                expect(api.callsTo('POST', transitionPath)).toHaveLength(0)

                await user.type(reason, ' — June data was corrected')
                await user.click(screen.getByRole('button', { name: 'Return to Data collection' }))
                expect(await screen.findByText('Returned to Data collection.')).toBeInTheDocument()
                const [call] = api.callsTo('POST', transitionPath)
                expect(JSON.parse(call.init.body as string)).toEqual({
                        to: 'OPEN',
                        reason: 'Too short — June data was corrected',
                })
        })

        it('publishes the whole quarter after a confirmation', async () => {
                const ready = { ...scoringQuarter, status: 'READY' as const }
                const api = installMockApi({
                        'GET /api/auth/me': reply(200, chroUser),
                        'GET /api/kpi/quarters': reply(200, [ready]),
                        [`GET ${overviewPath}`]: reply(
                                200,
                                overview({
                                        quarter: ready,
                                        next_status: 'PUBLISHED',
                                        previous_status: 'NORMALIZATION',
                                        employees: {
                                                total: 8,
                                                ready: 8,
                                                multi_assignment: 1,
                                                weights_needed: 0,
                                        },
                                        cohorts: { total: 2, approved: 2, unresolved: 0 },
                                        actions: {
                                                can_advance: false,
                                                can_return: true,
                                                can_publish: true,
                                                can_request_correction: false,
                                        },
                                }),
                        ),
                        [`POST ${publishPath}`]: reply(
                                200,
                                overview({
                                        quarter: { ...scoringQuarter, status: 'PUBLISHED' },
                                        next_status: null,
                                        previous_status: null,
                                        published_at: '2026-10-26T12:00:00Z',
                                        published_by: {
                                                id: chroUser.id,
                                                username: chroUser.username,
                                        },
                                        actions: {
                                                can_advance: false,
                                                can_return: false,
                                                can_publish: false,
                                                can_request_correction: false,
                                        },
                                }),
                        ),
                })
                const { user } = renderApp('/scores/quarter')
                await user.click(
                        await screen.findByRole('button', {
                                name: 'Publish the quarter’s scores…',
                        }),
                )
                expect(screen.getByText('Publishing is final')).toBeInTheDocument()
                expect(api.callsTo('POST', publishPath)).toHaveLength(0)
                await user.click(screen.getByRole('button', { name: 'Publish 8 employee scores' }))

                expect(
                        await screen.findByText('Published. The quarter is locked.'),
                ).toBeInTheDocument()
                expect(api.callsTo('POST', publishPath)).toHaveLength(1)
                expect(screen.getByText('Published and locked')).toBeInTheDocument()
                expect(screen.queryByRole('button', { name: /Publish/ })).not.toBeInTheDocument()
        })

        it('offers no steps to a department head', async () => {
                installMockApi({
                        'GET /api/auth/me': reply(200, deptHeadUser),
                        'GET /api/kpi/quarters': reply(200, [scoringQuarter]),
                        [`GET ${overviewPath}`]: reply(
                                200,
                                overview({
                                        actions: {
                                                can_advance: false,
                                                can_return: false,
                                                can_publish: false,
                                                can_request_correction: false,
                                        },
                                }),
                        ),
                })
                renderApp('/scores/quarter')
                expect(
                        await screen.findByRole('list', { name: 'Quarter steps' }),
                ).toBeInTheDocument()
                expect(
                        screen.queryByRole('button', { name: /Move to|Publish|Return to/ }),
                ).not.toBeInTheDocument()
        })

        it('reports an overview that cannot load', async () => {
                installMockApi({
                        'GET /api/auth/me': reply(200, matrixHrHead),
                        'GET /api/kpi/quarters': reply(200, [scoringQuarter]),
                        [`GET ${overviewPath}`]: reply(500, { detail: 'Server error' }),
                })
                renderApp('/scores/quarter')
                expect(await screen.findByRole('button', { name: 'Retry' })).toBeInTheDocument()
        })
})

describe('employee result', () => {
        const path = `/scores/quarters/${scoringQuarter.id}/employees/501`
        const api = `/api/kpi/quarters/${scoringQuarter.id}/employees/501`

        it('saves contribution weights only when they total 100 %', async () => {
                const mock = installMockApi({
                        'GET /api/auth/me': reply(200, matrixHrHead),
                        [`GET ${api}`]: reply(200, employeeResult()),
                        [`PUT ${api}/weights`]: reply(
                                200,
                                employeeResult({
                                        weights_source: 'CONFIGURED',
                                        calculated_score: '3.7000',
                                        final_score: '3.70',
                                        ready: true,
                                        issues: [],
                                }),
                        ),
                })
                const { user } = renderApp(path)
                expect(await screen.findByText('Not ready for normalization')).toBeInTheDocument()
                const save = screen.getByRole('button', { name: 'Save weights' })
                expect(save).toBeDisabled()

                await user.type(
                        screen.getByLabelText('Weight % for Test Quality — Test Plant A'),
                        '70',
                )
                await user.type(
                        screen.getByLabelText('Weight % for Test Quality — Test Plant B'),
                        '20',
                )
                expect(screen.getByText('Total 90.00 %')).toBeInTheDocument()
                expect(save).toBeDisabled()

                const second = screen.getByLabelText('Weight % for Test Quality — Test Plant B')
                await user.clear(second)
                await user.type(second, '30')
                expect(screen.getByText('Total 100.00 %')).toBeInTheDocument()
                await user.click(save)

                expect(await screen.findByText('Weights saved')).toBeInTheDocument()
                const [call] = mock.callsTo('PUT', `${api}/weights`)
                expect(JSON.parse(call.init.body as string)).toEqual({
                        weights: [
                                { assignment_id: 1, weight: '70' },
                                { assignment_id: 2, weight: '30' },
                        ],
                })
                expect(screen.getByText('3.70')).toBeInTheDocument()
                expect(screen.queryByText('Not ready for normalization')).not.toBeInTheDocument()
        })

        it('shows weights read-only to users who cannot set them', async () => {
                installMockApi({
                        'GET /api/auth/me': reply(200, deptHeadUser),
                        [`GET ${api}`]: reply(200, employeeResult({ can_set_weights: false })),
                })
                renderApp(path)
                expect(
                        await screen.findByRole('table', { name: 'Scored assignments' }),
                ).toBeInTheDocument()
                expect(
                        screen.queryByRole('button', { name: 'Save weights' }),
                ).not.toBeInTheDocument()
        })
})

describe('normalization cohort', () => {
        const runApi = '/api/kpi/normalization-runs/7'

        it('shows target and actual group sizes and never claims a match it lacks', async () => {
                installMockApi({
                        'GET /api/auth/me': reply(200, matrixHrHead),
                        [`GET ${runApi}`]: reply(200, cohort()),
                })
                renderApp('/scores/normalization/7')
                const table = await screen.findByRole('table', {
                        name: 'Group sizes: target and actual',
                })
                const middle = within(table).getByText('Middle 60%').closest('tr')!
                expect(
                        within(middle)
                                .getAllByRole('cell')
                                .map((c) => c.textContent),
                ).toEqual(['Middle 60%', '60 %', '2', '1', '25 %'])
                expect(screen.getByText(/differ from the policy’s targets/)).toBeInTheDocument()
                expect(screen.getByText(/2 employees are tied at 2.2/)).toBeInTheDocument()
                expect(
                        screen.getByText('2 employee(s) must be placed before approval.'),
                ).toBeInTheDocument()
                const members = screen.getByRole('table', { name: 'Cohort members' })
                expect(within(members).getAllByText('To be placed')).toHaveLength(2)
                // Only tied employees are placed by hand; ranked ones are not movable.
                expect(
                        screen.queryByRole('button', { name: 'Place Tess Person' }),
                ).not.toBeInTheDocument()
        })

        it('places a tied employee only with a group and a reason', async () => {
                const placed = cohort()
                placed.members[2] = {
                        ...placed.members[2],
                        group_key: 'MIDDLE',
                        group_label: 'Middle 60%',
                        placement: 'TIE_RESOLVED',
                        placement_reason: 'Stronger second-half trend',
                        placed_by: { id: matrixHrHead.id, username: matrixHrHead.username },
                        normalized_rating: '3',
                }
                const api = installMockApi({
                        'GET /api/auth/me': reply(200, matrixHrHead),
                        [`GET ${runApi}`]: reply(200, cohort()),
                        [`POST ${runApi}/placements`]: reply(200, { ...placed, unresolved: 1 }),
                })
                const { user } = renderApp('/scores/normalization/7')
                await user.click(await screen.findByRole('button', { name: 'Place Meera Test' }))
                const form = screen.getByRole('form', { name: 'Place Meera Test' })
                await user.click(within(form).getByRole('button', { name: 'Save placement' }))
                expect(within(form).getByText('Choose a group.')).toBeInTheDocument()
                expect(
                        within(form).getByText('Explain the placement (at least 10 characters).'),
                ).toBeInTheDocument()
                expect(api.callsTo('POST', `${runApi}/placements`)).toHaveLength(0)

                // Only the groups the tie spans are offered.
                const group = within(form).getByLabelText('Group')
                expect(
                        within(group)
                                .getAllByRole('option')
                                .map((o) => o.textContent),
                ).toEqual(['Choose…', 'Middle 60%', 'Bottom 20%'])
                await user.selectOptions(group, 'MIDDLE')
                await user.type(within(form).getByLabelText('Reason'), 'Stronger second-half trend')
                await user.click(within(form).getByRole('button', { name: 'Save placement' }))

                expect(await screen.findByText('Meera Test placed.')).toBeInTheDocument()
                const [call] = api.callsTo('POST', `${runApi}/placements`)
                expect(JSON.parse(call.init.body as string)).toEqual({
                        employee_id: 503,
                        group: 'MIDDLE',
                        reason: 'Stronger second-half trend',
                })
                expect(screen.getByText('“Stronger second-half trend”')).toBeInTheDocument()
        })

        it('tells a reviewer who placed employees that someone else approves', async () => {
                const resolved = cohort({ unresolved: 0 })
                resolved.members = resolved.members.map((m) =>
                        m.placement === 'NEEDS_RESOLUTION'
                                ? {
                                          ...m,
                                          group_key: 'BOTTOM',
                                          group_label: 'Bottom 20%',
                                          placement: 'TIE_RESOLVED' as const,
                                          placed_by: {
                                                  id: matrixHrHead.id,
                                                  username: matrixHrHead.username,
                                          },
                                  }
                                : m,
                )
                installMockApi({
                        'GET /api/auth/me': reply(200, matrixHrHead),
                        [`GET ${runApi}`]: reply(200, resolved),
                })
                renderApp('/scores/normalization/7')
                expect(
                        await screen.findByText(/You placed employees in this cohort/),
                ).toBeInTheDocument()
                expect(
                        screen.queryByRole('button', { name: 'Approve the cohort…' }),
                ).not.toBeInTheDocument()
        })

        it('records an approval with an optional note', async () => {
                const api = installMockApi({
                        'GET /api/auth/me': reply(200, chroUser),
                        [`GET ${runApi}`]: reply(
                                200,
                                cohort({
                                        unresolved: 0,
                                        actions: {
                                                can_place: false,
                                                can_approve: true,
                                                can_reopen: false,
                                        },
                                }),
                        ),
                        [`POST ${runApi}/approve`]: reply(
                                200,
                                cohort({
                                        status: 'APPROVED',
                                        unresolved: 0,
                                        approved_by: {
                                                id: chroUser.id,
                                                username: chroUser.username,
                                        },
                                        approved_at: '2026-10-26T11:00:00Z',
                                        actions: {
                                                can_place: false,
                                                can_approve: false,
                                                can_reopen: true,
                                        },
                                }),
                        ),
                })
                const { user } = renderApp('/scores/normalization/7')
                await user.click(await screen.findByRole('button', { name: 'Approve the cohort…' }))
                await user.click(screen.getByRole('button', { name: 'Approve' }))

                expect(await screen.findByText('Cohort approved.')).toBeInTheDocument()
                const [call] = api.callsTo('POST', `${runApi}/approve`)
                expect(JSON.parse(call.init.body as string)).toEqual({ note: null })
                expect(screen.getByRole('button', { name: 'Reopen…' })).toBeInTheDocument()
        })
})

describe('comments and feedback', () => {
        it('are optional and added to a locked sheet', async () => {
                const api = installMockApi({
                        'GET /api/auth/me': reply(200, deptHeadUser),
                        'GET /api/kpi/results/90': reply(200, resultDetail()),
                        'GET /api/kpi/sheets/90/comments': [
                                reply(200, { comments: [], can_comment: true }),
                                reply(200, {
                                        comments: [
                                                {
                                                        id: 1,
                                                        kind: 'FEEDBACK',
                                                        body: 'Good consistency this quarter.',
                                                        author: {
                                                                id: deptHeadUser.id,
                                                                username: deptHeadUser.username,
                                                        },
                                                        created_at: '2026-10-26T10:00:00Z',
                                                },
                                        ],
                                        can_comment: true,
                                }),
                        ],
                        'POST /api/kpi/sheets/90/comments': reply(201, {
                                id: 1,
                                kind: 'FEEDBACK',
                                body: 'Good consistency this quarter.',
                                author: { id: deptHeadUser.id, username: deptHeadUser.username },
                                created_at: '2026-10-26T10:00:00Z',
                        }),
                })
                const { user } = renderApp('/scores/results/90')
                const panel = await screen.findByRole('region', { name: 'Comments and feedback' })
                expect(await within(panel).findByText('No comments yet.')).toBeInTheDocument()
                expect(within(panel).getByText(/Neither is needed for review/)).toBeInTheDocument()

                await user.click(within(panel).getByRole('button', { name: 'Add' }))
                expect(within(panel).getByText('Write the comment first.')).toBeInTheDocument()
                expect(api.callsTo('POST', '/api/kpi/sheets/90/comments')).toHaveLength(0)

                await user.selectOptions(within(panel).getByLabelText('Kind'), 'FEEDBACK')
                await user.type(
                        within(panel).getByLabelText('Comment'),
                        'Good consistency this quarter.',
                )
                await user.click(within(panel).getByRole('button', { name: 'Add' }))

                expect(
                        await within(panel).findByText('Good consistency this quarter.'),
                ).toBeInTheDocument()
                const [call] = api.callsTo('POST', '/api/kpi/sheets/90/comments')
                expect(JSON.parse(call.init.body as string)).toEqual({
                        kind: 'FEEDBACK',
                        body: 'Good consistency this quarter.',
                })
        })
})

describe('my KPI sheets', () => {
        it('shows the KPIs and says when nothing is published yet', async () => {
                installMockApi({
                        'GET /api/auth/me': reply(200, employeeOnlyUser),
                        'GET /api/kpi/my/kpi-sheets': reply(200, [ownSheet()]),
                })
                renderApp('/my/kpi-sheets')
                const table = await screen.findByRole('table', {
                        name: `KPIs for ${scoringQuarter.name}, Test Quality — Test Plant A`,
                })
                expect(within(table).getAllByRole('row').length).toBeGreaterThan(1)
                expect(screen.getByText('Not published yet.')).toBeInTheDocument()
                expect(screen.queryByText('Quarterly score')).not.toBeInTheDocument()

                const nav = screen.getByRole('navigation', { name: 'Main' })
                expect(within(nav).getByRole('link', { name: 'My KPI sheets' })).toBeInTheDocument()
                expect(
                        within(nav).queryByRole('link', { name: 'Quarter overview' }),
                ).not.toBeInTheDocument()
        })

        it('shows the published outcome and feedback', async () => {
                installMockApi({
                        'GET /api/auth/me': reply(200, employeeOnlyUser),
                        'GET /api/kpi/my/kpi-sheets': reply(200, [
                                ownSheet({
                                        quarter: { ...scoringQuarter, status: 'PUBLISHED' },
                                        published_score: '4.20',
                                        published_at: '2026-10-26T12:00:00Z',
                                        outcome: {
                                                final_score: '4.05',
                                                group_label: 'Top 20%',
                                                normalized_rating: '5',
                                                published_at: '2026-10-26T12:00:00Z',
                                        },
                                        feedback: [
                                                {
                                                        id: 1,
                                                        kind: 'FEEDBACK',
                                                        body: 'Good consistency this quarter.',
                                                        author: {
                                                                id: 11,
                                                                username: 'test.depthead',
                                                        },
                                                        created_at: '2026-10-20T10:00:00Z',
                                                },
                                        ],
                                }),
                        ]),
                })
                renderApp('/my/kpi-sheets')
                expect(await screen.findByText('4.20')).toBeInTheDocument()
                expect(screen.getByText('Quarterly score').nextElementSibling).toHaveTextContent(
                        '4.05',
                )
                expect(screen.getByText('Top 20%')).toBeInTheDocument()
                expect(screen.getByText('Normalized rating').nextElementSibling).toHaveTextContent(
                        '5',
                )
                expect(screen.getByText('Good consistency this quarter.')).toBeInTheDocument()
        })

        it('has an empty state', async () => {
                installMockApi({
                        'GET /api/auth/me': reply(200, employeeOnlyUser),
                        'GET /api/kpi/my/kpi-sheets': reply(200, []),
                })
                renderApp('/my/kpi-sheets')
                expect(await screen.findByText('No KPI sheets yet')).toBeInTheDocument()
        })
})
