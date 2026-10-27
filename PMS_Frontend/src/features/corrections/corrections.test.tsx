import { screen, within } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { annualChro, annualHrHead, correction, publishedQ2 } from '../../test/annualFixtures'
import { assignmentBrief } from '../../test/kpiFixtures'
import { resultDetail, resultItem } from '../../test/matrixFixtures'
import { installMockApi, reply } from '../../test/mockApi'
import { overview } from '../../test/quarterlyFixtures'
import { renderApp } from '../../test/renderApp'

describe('requesting a correction of a published quarter', () => {
        it('checks the change, shows its effect, then submits it for the CHRO', async () => {
                const item = resultItem({
                        kpi_id: 7,
                        months_expected: ['2026-05'],
                        monthly: [
                                {
                                        month: '2026-05',
                                        actual: '95',
                                        inputs: null,
                                        import_id: 3,
                                        row: 2,
                                },
                        ],
                })
                const api = installMockApi({
                        'GET /api/auth/me': reply(200, annualHrHead),
                        'GET /api/kpi/quarters': reply(200, [publishedQ2]),
                        'GET /api/kpi/results': reply(200, {
                                quarter: publishedQ2,
                                rows: [
                                        {
                                                assignment: assignmentBrief,
                                                sheet: { id: 90, status: 'LOCKED' },
                                                result: null,
                                        },
                                ],
                        }),
                        [`GET /api/kpi/quarters/${publishedQ2.id}/employees`]: reply(200, []),
                        'GET /api/kpi/results/90': reply(200, resultDetail({ items: [item] })),
                        [`POST /api/kpi/quarters/${publishedQ2.id}/corrections/preview`]: reply(
                                200,
                                correction().preview,
                        ),
                        [`POST /api/kpi/quarters/${publishedQ2.id}/corrections`]: reply(
                                201,
                                correction(),
                        ),
                        'GET /api/kpi/corrections/55': reply(200, correction()),
                })
                const { user } = renderApp(`/scores/corrections/new?quarter=${publishedQ2.id}`)
                await user.selectOptions(
                        await screen.findByLabelText('Employee and assignment (change 1)'),
                        '90',
                )
                await user.selectOptions(await screen.findByLabelText('KPI (change 1)'), '7')
                await user.selectOptions(screen.getByLabelText('Month (change 1)'), '2026-05')
                expect(screen.getByText('Published: 95 %')).toBeInTheDocument()
                await user.type(screen.getByLabelText('Corrected value (change 1)'), '101')
                const submit = screen.getByRole('button', { name: 'Submit for CHRO approval' })
                expect(submit).toBeDisabled()

                await user.click(screen.getByRole('button', { name: 'Check the correction' }))
                const sheets = await screen.findByRole('table', {
                        name: 'Projected KPI sheet scores',
                })
                expect(
                        within(sheets)
                                .getAllByRole('cell')
                                .map((c) => c.textContent),
                ).toEqual(['T0001 Tess PersonTest Quality — Test Plant A', '3.60', '4.20'])
                expect(
                        screen.getByText(/Renormalized: Test Quality: all plants \(1 member\)/),
                ).toBeInTheDocument()
                expect(submit).toBeDisabled() // a reason is still needed
                await user.type(
                        screen.getByLabelText('Reason for the correction'),
                        'May dispatch excluded a late delivery note',
                )
                await user.click(submit)

                expect(
                        await screen.findByRole('heading', {
                                level: 1,
                                name: 'Correction 55 · TA2',
                        }),
                ).toBeInTheDocument()
                const [call] = api.callsTo(
                        'POST',
                        `/api/kpi/quarters/${publishedQ2.id}/corrections`,
                )
                expect(JSON.parse(call.init.body as string)).toEqual({
                        reason: 'May dispatch excluded a late delivery note',
                        values: [
                                {
                                        sheet_id: 90,
                                        kpi_definition_id: 7,
                                        period: '2026-05',
                                        actual: '101',
                                },
                        ],
                        weights: [],
                })
        })

        it('asks for a new check after the changes are edited', async () => {
                installMockApi({
                        'GET /api/auth/me': reply(200, annualHrHead),
                        'GET /api/kpi/quarters': reply(200, [publishedQ2]),
                        'GET /api/kpi/results': reply(200, {
                                quarter: publishedQ2,
                                rows: [
                                        {
                                                assignment: assignmentBrief,
                                                sheet: { id: 90, status: 'LOCKED' },
                                                result: null,
                                        },
                                ],
                        }),
                        [`GET /api/kpi/quarters/${publishedQ2.id}/employees`]: reply(200, []),
                        'GET /api/kpi/results/90': reply(
                                200,
                                resultDetail({
                                        items: [
                                                resultItem({
                                                        kpi_id: 7,
                                                        months_expected: ['2026-05'],
                                                }),
                                        ],
                                }),
                        ),
                        [`POST /api/kpi/quarters/${publishedQ2.id}/corrections/preview`]: reply(
                                200,
                                correction().preview,
                        ),
                })
                const { user } = renderApp(`/scores/corrections/new?quarter=${publishedQ2.id}`)
                await user.selectOptions(
                        await screen.findByLabelText('Employee and assignment (change 1)'),
                        '90',
                )
                await user.selectOptions(await screen.findByLabelText('KPI (change 1)'), '7')
                await user.selectOptions(screen.getByLabelText('Month (change 1)'), '2026-05')
                await user.type(screen.getByLabelText('Corrected value (change 1)'), '101')
                await user.type(
                        screen.getByLabelText('Reason for the correction'),
                        'May dispatch excluded a late note',
                )
                await user.click(screen.getByRole('button', { name: 'Check the correction' }))
                await screen.findByRole('table', { name: 'Projected KPI sheet scores' })
                expect(
                        screen.getByRole('button', { name: 'Submit for CHRO approval' }),
                ).toBeEnabled()
                await user.type(screen.getByLabelText('Corrected value (change 1)'), '5')
                expect(
                        screen.getByText('The changes were edited since the check; check again.'),
                ).toBeInTheDocument()
                expect(
                        screen.getByRole('button', { name: 'Submit for CHRO approval' }),
                ).toBeDisabled()
        })

        it('is offered from the overview of a published quarter, with its versions', async () => {
                installMockApi({
                        'GET /api/auth/me': reply(200, annualHrHead),
                        'GET /api/kpi/quarters': reply(200, [publishedQ2]),
                        [`GET /api/kpi/quarters/${publishedQ2.id}/overview`]: reply(
                                200,
                                overview({
                                        quarter: publishedQ2,
                                        next_status: null,
                                        published_at: '2026-10-20T10:00:00Z',
                                        published_by: { id: 33, username: 'test.chro' },
                                        published_version: 2,
                                        actions: {
                                                can_advance: false,
                                                can_return: false,
                                                can_publish: false,
                                                can_request_correction: true,
                                        },
                                }),
                        ),
                        [`GET /api/kpi/quarters/${publishedQ2.id}/versions`]: reply(200, [
                                {
                                        version_no: 1,
                                        current: false,
                                        correction_id: null,
                                        published_by: { id: 33, username: 'test.chro' },
                                        published_at: '2026-10-20T10:00:00Z',
                                },
                                {
                                        version_no: 2,
                                        current: true,
                                        correction_id: 54,
                                        published_by: { id: 33, username: 'test.chro' },
                                        published_at: '2026-10-24T10:00:00Z',
                                },
                        ]),
                })
                renderApp(`/scores/quarter?quarter=${publishedQ2.id}`)
                const versions = await screen.findByRole('list', { name: 'Published versions' })
                expect(within(versions).getAllByRole('listitem')[1]).toHaveTextContent(
                        'Version 2Current',
                )
                expect(
                        within(versions).getByRole('link', { name: 'Correction 54' }),
                ).toHaveAttribute('href', '/scores/corrections/54')
                expect(screen.getByRole('link', { name: 'Request a correction…' })).toHaveAttribute(
                        'href',
                        `/scores/corrections/new?quarter=${publishedQ2.id}`,
                )
        })
})

describe('deciding and completing a correction', () => {
        it('lets the CHRO approve with a recorded reason', async () => {
                const api = installMockApi({
                        'GET /api/auth/me': reply(200, annualChro),
                        'GET /api/kpi/corrections/55': reply(
                                200,
                                correction({
                                        actions: {
                                                can_decide: true,
                                                can_advance: false,
                                                can_return: false,
                                                can_publish: false,
                                        },
                                }),
                        ),
                        'POST /api/kpi/corrections/55/approve': reply(
                                200,
                                correction({
                                        status: 'DEPARTMENT_REVIEW',
                                        version_no: 2,
                                        decided_by: { id: 33, username: 'test.chro' },
                                        decided_at: '2026-10-26T12:00:00Z',
                                        decision_reason: 'Verified against the May delivery notes',
                                }),
                        ),
                })
                const { user } = renderApp('/scores/corrections/55')
                const requested = await screen.findByRole('table', { name: 'Requested changes' })
                expect(
                        within(requested)
                                .getAllByRole('cell')
                                .map((c) => c.textContent),
                ).toEqual([
                        'Tess PersonT0001 · Test Quality — Test Plant A',
                        'TK-7 Test profit · May 2026',
                        '95',
                        '101',
                ])
                await user.click(screen.getByRole('button', { name: 'Approve the correction…' }))
                await user.type(screen.getByLabelText('Why is the correction approved?'), 'ok')
                await user.click(screen.getByRole('button', { name: 'Approve the correction' }))
                expect(screen.getByText('Enter at least 10 characters.')).toBeInTheDocument()
                expect(api.callsTo('POST', '/api/kpi/corrections/55/approve')).toHaveLength(0)
                await user.clear(screen.getByLabelText('Why is the correction approved?'))
                await user.type(
                        screen.getByLabelText('Why is the correction approved?'),
                        'Verified against the May delivery notes',
                )
                await user.click(screen.getByRole('button', { name: 'Approve the correction' }))
                expect(
                        await screen.findByText(
                                'Approved: the corrected version is open for department review.',
                        ),
                ).toBeInTheDocument()
                const steps = screen.getByRole('list', { name: 'Correction steps' })
                expect(
                        within(steps)
                                .getAllByRole('listitem')
                                .find((li) => li.getAttribute('aria-current')),
                ).toHaveTextContent('2. Department review')
                expect(screen.getByText(/Approved by test.chro/)).toBeInTheDocument()
        })

        it('shows what blocks the next step and publishes only when ready', async () => {
                const api = installMockApi({
                        'GET /api/auth/me': reply(200, annualHrHead),
                        'GET /api/kpi/corrections/55': [
                                reply(
                                        200,
                                        correction({
                                                status: 'DEPARTMENT_REVIEW',
                                                version_no: 2,
                                                next_status: 'NORMALIZATION',
                                                blockers: [
                                                        'T0001 Tess Person: not reviewed by the department',
                                                ],
                                                sheets: [
                                                        {
                                                                sheet_id: 90,
                                                                employee: {
                                                                        id: 501,
                                                                        employee_code: 'T0001',
                                                                        full_name: 'Tess Person',
                                                                },
                                                                unit: 'Test Quality — Test Plant A',
                                                                status: 'CALCULATED',
                                                                final_score: '4.2',
                                                                published_score: '3.6',
                                                        },
                                                ],
                                                actions: {
                                                        can_decide: false,
                                                        can_advance: true,
                                                        can_return: false,
                                                        can_publish: false,
                                                },
                                        }),
                                ),
                        ],
                })
                renderApp('/scores/corrections/55')
                expect(
                        await screen.findByText(
                                'T0001 Tess Person: not reviewed by the department',
                        ),
                ).toBeInTheDocument()
                expect(screen.getByRole('button', { name: 'Move to Normalization' })).toBeDisabled()
                const sheets = screen.getByRole('table', { name: 'Corrected KPI sheet results' })
                expect(within(sheets).getByRole('link', { name: 'Tess Person' })).toHaveAttribute(
                        'href',
                        '/scores/results/90',
                )
                expect(api.callsTo('POST', '/api/kpi/corrections/55/publish')).toHaveLength(0)
        })

        it('publishes a ready correction after a confirmation', async () => {
                const ready = correction({
                        status: 'READY',
                        version_no: 2,
                        previous_status: 'NORMALIZATION',
                        actions: {
                                can_decide: false,
                                can_advance: false,
                                can_return: true,
                                can_publish: true,
                        },
                })
                const api = installMockApi({
                        'GET /api/auth/me': reply(200, annualChro),
                        'GET /api/kpi/corrections/55': reply(200, ready),
                        'POST /api/kpi/corrections/55/publish': reply(
                                200,
                                correction({
                                        status: 'PUBLISHED',
                                        version_no: 2,
                                        published_by: { id: 33, username: 'test.chro' },
                                }),
                        ),
                })
                const { user } = renderApp('/scores/corrections/55')
                await user.click(
                        await screen.findByRole('button', {
                                name: 'Publish the corrected version…',
                        }),
                )
                expect(api.callsTo('POST', '/api/kpi/corrections/55/publish')).toHaveLength(0)
                await user.click(screen.getByRole('button', { name: 'Publish version 2' }))
                expect(
                        await screen.findByText(
                                'Version 2 published. The earlier version stays in the history.',
                        ),
                ).toBeInTheDocument()
                expect(screen.queryByRole('button', { name: /Publish/ })).not.toBeInTheDocument()
        })
})
