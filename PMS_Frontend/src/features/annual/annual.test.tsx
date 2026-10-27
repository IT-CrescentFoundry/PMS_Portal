import { screen, within } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { employeeOnlyUser } from '../../test/fixtures'
import {
        annualAdmin,
        annualChro,
        annualCycle,
        annualDetail,
        annualHrHead,
        annualRow,
        annualVersion,
} from '../../test/annualFixtures'
import { deptHeadUser } from '../../test/kpiFixtures'
import { installMockApi, reply } from '../../test/mockApi'
import { renderApp } from '../../test/renderApp'

const rowsPath = `/api/annual/cycles/${annualCycle.id}/employees`
const detailPath = `${rowsPath}/501`
const detailUrl = `/annual/cycles/${annualCycle.id}/employees/501`

describe('annual dashboard', () => {
        it('shows the four published quarters and calculates annual results', async () => {
                const api = installMockApi({
                        'GET /api/auth/me': reply(200, annualHrHead),
                        'GET /api/annual/cycles': reply(200, [annualCycle]),
                        [`GET ${rowsPath}`]: [
                                reply(200, [annualRow({ draft: null })]),
                                reply(200, [annualRow()]),
                        ],
                        [`POST /api/annual/cycles/${annualCycle.id}/calculate`]: reply(200, {
                                calculated: 1,
                                unchanged: 0,
                                incomplete: 0,
                        }),
                })
                const { user } = renderApp('/annual')
                expect(
                        await screen.findByText(/Q1 25 % · Q2 25 % · Q3 25 % · Q4 25 %/),
                ).toBeInTheDocument()
                const table = await screen.findByRole('table', {
                        name: 'Annual results for Test annual cycle',
                })
                const row = within(table).getByRole('row', { name: /Tess Person/ })
                expect(
                        within(row)
                                .getAllByRole('cell')
                                .map((c) => c.textContent),
                ).toEqual([
                        'Tess PersonT0001 · Test Quality — Test Plant A',
                        '4.60',
                        '3.60',
                        '3.80',
                        '3.80',
                        '—',
                        '—',
                        '—',
                        'Not calculated yet',
                ])
                await user.click(screen.getByRole('button', { name: 'Calculate annual results' }))
                expect(
                        await screen.findByText(
                                '1 annual result calculated · 0 unchanged · 0 waiting for quarters',
                        ),
                ).toBeInTheDocument()
                expect(
                        JSON.parse(
                                api.callsTo(
                                        'POST',
                                        `/api/annual/cycles/${annualCycle.id}/calculate`,
                                )[0].init.body as string,
                        ),
                ).toEqual({ employee_ids: null })
                const updated = await screen.findByRole('row', {
                        name: /Calculated · awaiting CHRO approval/,
                })
                expect(within(updated).getAllByRole('cell')[5]).toHaveTextContent('3.95')
        })

        it('never presents a missing quarter as a score', async () => {
                const row = annualRow({
                        draft: null,
                        complete: false,
                        issues: ['TA4 is not published yet (normalization)'],
                })
                row.quarters[3] = {
                        ...row.quarters[3],
                        status: 'NORMALIZATION',
                        published: false,
                        score: null,
                        version_no: null,
                        employee_result_id: null,
                }
                installMockApi({
                        'GET /api/auth/me': reply(200, annualHrHead),
                        'GET /api/annual/cycles': reply(200, [annualCycle]),
                        [`GET ${rowsPath}`]: reply(200, [
                                { ...row, actions: { ...row.actions, can_calculate: false } },
                        ]),
                })
                renderApp('/annual')
                const table = await screen.findByRole('table', {
                        name: 'Annual results for Test annual cycle',
                })
                expect(within(table).getByText('Not published')).toBeInTheDocument()
                expect(within(table).getByText('Quarters missing')).toBeInTheDocument()
                expect(
                        screen.queryByRole('button', { name: 'Calculate annual results' }),
                ).not.toBeInTheDocument()
        })

        it('is denied to users without annual access, and hidden from their navigation', async () => {
                installMockApi({ 'GET /api/auth/me': reply(200, deptHeadUser) })
                renderApp('/annual')
                expect(
                        await screen.findByRole('heading', { level: 1, name: 'Access denied' }),
                ).toBeInTheDocument()
                const nav = screen.getByRole('navigation', { name: 'Main' })
                expect(
                        within(nav).queryByRole('link', { name: 'Annual results' }),
                ).not.toBeInTheDocument()
        })
})

describe('annual deviations', () => {
        it('lets an Admin request a deviation with a revised score and a reason', async () => {
                const detail = annualDetail({
                        actions: {
                                can_calculate: false,
                                can_request_deviation: true,
                                can_decide_deviation: false,
                                can_finalize: false,
                        },
                })
                const api = installMockApi({
                        'GET /api/auth/me': reply(200, annualAdmin),
                        [`GET ${detailPath}`]: [
                                reply(200, detail),
                                reply(200, {
                                        ...detail,
                                        pending_deviation: {
                                                id: 61,
                                                status: 'PENDING',
                                                original_score: '3.95',
                                                proposed_score: '4',
                                                requested_by: { id: 32, username: 'test.admin' },
                                                requested_at: '2026-10-26T12:00:00Z',
                                        },
                                        actions: {
                                                ...detail.actions,
                                                can_request_deviation: false,
                                        },
                                }),
                        ],
                        'POST /api/annual/results/900/deviations': reply(201, {}),
                })
                const { user } = renderApp(detailUrl)
                await user.click(
                        await screen.findByRole('button', { name: 'Request a deviation…' }),
                )
                const form = screen.getByRole('form', { name: 'Annual score deviation' })
                expect(within(form).getByText('3.95')).toBeInTheDocument()
                await user.click(within(form).getByRole('button', { name: 'Submit the deviation' }))
                expect(
                        within(form).getByText(
                                'Enter a score from 0 to 5 with at most two decimals.',
                        ),
                ).toBeInTheDocument()
                expect(
                        within(form).getByText('Explain the deviation (at least 10 characters).'),
                ).toBeInTheDocument()
                expect(api.callsTo('POST', '/api/annual/results/900/deviations')).toHaveLength(0)

                await user.type(within(form).getByLabelText('Revised annual score'), '4.00')
                await user.type(
                        within(form).getByLabelText('Reason for the deviation'),
                        'Plant start-up support all year',
                )
                await user.click(within(form).getByRole('button', { name: 'Submit the deviation' }))
                expect(
                        await screen.findByText('Deviation requested. The CHRO decides it.'),
                ).toBeInTheDocument()
                expect(
                        JSON.parse(
                                api.callsTo('POST', '/api/annual/results/900/deviations')[0].init
                                        .body as string,
                        ),
                ).toEqual({
                        original_score: '3.95',
                        proposed_score: '4.00',
                        reason: 'Plant start-up support all year',
                })
                expect(screen.getByText('Deviation awaiting the CHRO')).toBeInTheDocument()
        })

        it('lets the CHRO decide the deviation with a reason, then approve the result', async () => {
                const pending = {
                        id: 61,
                        status: 'PENDING' as const,
                        original_score: '3.95',
                        proposed_score: '4',
                        requested_by: { id: 32, username: 'test.admin' },
                        requested_at: '2026-10-26T12:00:00Z',
                }
                const withPending = annualDetail({
                        pending_deviation: pending,
                        actions: {
                                can_calculate: true,
                                can_request_deviation: false,
                                can_decide_deviation: true,
                                can_finalize: false,
                        },
                })
                const adjusted = annualDetail({
                        draft: annualVersion({ adjusted_score: '4', final_score: '4' }),
                        actions: {
                                can_calculate: true,
                                can_request_deviation: false,
                                can_decide_deviation: false,
                                can_finalize: true,
                        },
                })
                const approved = annualDetail({
                        draft: null,
                        published: annualVersion({
                                status: 'PUBLISHED',
                                adjusted_score: '4',
                                final_score: '4',
                                published_by: { id: 33, username: 'test.chro' },
                                published_at: '2026-10-26T13:00:00Z',
                        }),
                        actions: {
                                can_calculate: true,
                                can_request_deviation: false,
                                can_decide_deviation: false,
                                can_finalize: false,
                        },
                })
                const api = installMockApi({
                        'GET /api/auth/me': reply(200, annualChro),
                        [`GET ${detailPath}`]: [reply(200, withPending), reply(200, adjusted)],
                        'POST /api/annual/deviations/61/approve': reply(200, {}),
                        'POST /api/annual/results/900/finalize': reply(200, approved),
                })
                const { user } = renderApp(detailUrl)
                await user.click(
                        await screen.findByRole('button', { name: 'Approve the deviation…' }),
                )
                await user.type(screen.getByLabelText('Why is the deviation approved?'), 'short')
                await user.click(screen.getByRole('button', { name: 'Approve the deviation' }))
                expect(screen.getByText('Enter at least 10 characters.')).toBeInTheDocument()
                await user.type(
                        screen.getByLabelText('Why is the deviation approved?'),
                        ' but confirmed by the plant head',
                )
                await user.click(screen.getByRole('button', { name: 'Approve the deviation' }))
                expect(
                        await screen.findByText('Deviation approved: the adjusted score applies.'),
                ).toBeInTheDocument()
                expect(
                        JSON.parse(
                                api.callsTo('POST', '/api/annual/deviations/61/approve')[0].init
                                        .body as string,
                        ),
                ).toEqual({
                        reason: 'short but confirmed by the plant head',
                })
                const draft = screen.getByRole('region', {
                        name: 'Calculated version awaiting approval',
                })
                expect(
                        within(draft).getByText('Original calculated score').nextElementSibling,
                ).toHaveTextContent('3.95')
                expect(
                        within(draft).getByText('Approved adjustment').nextElementSibling,
                ).toHaveTextContent('4.00')

                await user.click(screen.getByRole('button', { name: 'Approve the annual result…' }))
                await user.type(screen.getByLabelText('Approval note (optional)'), 'Year closed')
                await user.click(screen.getByRole('button', { name: 'Approve version 1' }))
                expect(
                        await screen.findByText('Version 1 approved: it is the annual result.'),
                ).toBeInTheDocument()
                expect(
                        JSON.parse(
                                api.callsTo('POST', '/api/annual/results/900/finalize')[0].init
                                        .body as string,
                        ),
                ).toEqual({
                        note: 'Year closed',
                })
                const final = screen.getByRole('region', { name: 'Approved annual result' })
                expect(
                        within(final).getByText('Final annual score').nextElementSibling,
                ).toHaveTextContent('4.00')
        })

        it('marks a result whose source quarter is being corrected', async () => {
                const detail = annualDetail({
                        draft: null,
                        published: annualVersion({
                                status: 'PUBLISHED',
                                recalculation_required: true,
                                recalculation_reason:
                                        'TA2 is being corrected (correction 55); recalculate once the corrected version is published.',
                        }),
                        issues: [
                                'TA2 is being corrected (correction 55, department review); the annual result waits for the corrected version',
                        ],
                })
                detail.quarters[1] = { ...detail.quarters[1], correction_ids: [55] }
                installMockApi({
                        'GET /api/auth/me': reply(200, annualHrHead),
                        [`GET ${detailPath}`]: reply(200, detail),
                })
                renderApp(detailUrl)
                expect(await screen.findAllByText('Recalculation required')).not.toHaveLength(0)
                expect(
                        screen.getByText(/TA2 is being corrected \(correction 55\); recalculate/),
                ).toBeInTheDocument()
                expect(
                        screen.getByRole('link', { name: 'Being corrected (correction 55)' }),
                ).toHaveAttribute('href', '/scores/corrections/55')
                expect(screen.getByRole('list', { name: 'Audit history' })).toHaveTextContent(
                        'annual_result.calculate',
                )
        })
})

describe('the employee’s annual result', () => {
        it('appears with My KPI sheets once approved, with a notice while under review', async () => {
                installMockApi({
                        'GET /api/auth/me': reply(200, employeeOnlyUser),
                        'GET /api/kpi/my/kpi-sheets': reply(200, []),
                        'GET /api/annual/my': reply(200, [
                                {
                                        cycle_id: 70,
                                        cycle_code: 'TST-AN',
                                        cycle_name: 'Test annual cycle',
                                        version_no: 1,
                                        final_score: '4',
                                        published_at: '2026-10-26T13:00:00Z',
                                        quarters: [
                                                { quarter_number: 1, name: 'TA1', score: '4.6' },
                                        ],
                                        notice: 'A quarter this result was calculated from is being corrected.',
                                },
                        ]),
                })
                renderApp('/my/kpi-sheets')
                const section = await screen.findByRole('region', { name: 'Annual results' })
                expect(
                        within(section).getByText('Annual score').nextElementSibling,
                ).toHaveTextContent('4.00')
                expect(within(section).getByText('Under review')).toBeInTheDocument()
        })
})
