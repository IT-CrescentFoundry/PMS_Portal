import { screen, waitFor, within } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { CSRF_HEADER } from '../../services/apiClient'
import { deptHeadUser, kpiSheet, kpis, policies, q1, q2, twoItems } from '../../test/kpiFixtures'
import { installMockApi, json, reply, type RecordedCall } from '../../test/mockApi'
import { renderApp } from '../../test/renderApp'
import type { KpiSheet, SheetItemInput } from '../../types/api'

function setup(sheet: KpiSheet, extra: Record<string, ReturnType<typeof reply>> = {}) {
        return installMockApi({
                'GET /api/auth/me': reply(200, deptHeadUser),
                'GET /api/kpi/sheets/90': reply(200, sheet),
                'GET /api/kpi/library': reply(200, kpis),
                'GET /api/jds': reply(200, []),
                'GET /api/kpi/policies': reply(200, policies),
                'GET /api/kpi/quarters': reply(200, [q1, q2]),
                ...extra,
        })
}

const bodyOf = (call: RecordedCall) =>
        JSON.parse(String(call.init.body)) as { items: SheetItemInput[] }

describe('quarterly KPI sheet', () => {
        it('shows a live total and will not publish until weightages reach exactly 100%', async () => {
                const api = setup(kpiSheet())
                const { user } = renderApp('/kpi/sheets/90')
                await screen.findByRole('heading', { name: 'Tess Person · TQ1' })

                const add = screen.getByRole('button', { name: 'Add KPI' })
                await user.click(add)
                await user.click(add)
                await user.click(add)
                await user.selectOptions(screen.getByLabelText('KPI 1'), 'Test profit')
                await user.type(screen.getByLabelText('Weightage % for KPI 1'), '33.33')
                await user.type(screen.getByLabelText('Quarterly target for KPI 1'), '120')
                await user.selectOptions(screen.getByLabelText('KPI 2'), 'Test claims')
                await user.type(screen.getByLabelText('Weightage % for KPI 2'), '33.33')
                // Zero tolerance: no target to enter.
                expect(
                        screen.queryByLabelText('Quarterly target for KPI 2'),
                ).not.toBeInTheDocument()
                await user.selectOptions(screen.getByLabelText('KPI 3'), 'Test inventory days')
                await user.type(screen.getByLabelText('Weightage % for KPI 3'), '33.33')
                await user.type(screen.getByLabelText('Quarterly target for KPI 3'), '30')

                expect(screen.getByText('99.99%')).toBeInTheDocument()
                expect(screen.getByText('0.01% still to allocate.')).toBeInTheDocument()

                await user.click(screen.getByRole('button', { name: 'Save and publish' }))
                expect(
                        await screen.findByText(
                                'Weightages must total exactly 100% before publishing.',
                        ),
                ).toBeInTheDocument()
                expect(api.callsTo('PUT', '/api/kpi/sheets/90')).toHaveLength(0)
                expect(api.callsTo('POST', '/api/kpi/sheets/90/publish')).toHaveLength(0)

                const third = screen.getByLabelText('Weightage % for KPI 3')
                await user.clear(third)
                await user.type(third, '33.34')
                expect(screen.getByText('Weightages total 100%.')).toBeInTheDocument()

                const savedItems = [
                        { ...twoItems[0], weightage: 33.33 },
                        {
                                id: 3,
                                kpi: {
                                        id: 8,
                                        code: 'TK-8',
                                        name: 'Test claims',
                                        direction: 'ZERO_TOLERANCE' as const,
                                },
                                weightage: 33.33,
                                target_value: 0,
                                target_note: null,
                                unit: '%',
                                scoring_policy: {
                                        id: 3,
                                        code: 'TP-Z',
                                        name: 'Test zero tolerance',
                                },
                                frozen: false,
                        },
                        { ...twoItems[1], weightage: 33.34 },
                ]
                api.set(
                        'PUT /api/kpi/sheets/90',
                        reply(200, {
                                sheet: kpiSheet({ items: savedItems, total: 100 }),
                                warnings: [],
                        }),
                )
                api.set(
                        'POST /api/kpi/sheets/90/publish',
                        reply(
                                200,
                                kpiSheet({
                                        items: savedItems,
                                        total: 100,
                                        status: 'PUBLISHED',
                                        can_edit: false,
                                }),
                        ),
                )
                await user.click(screen.getByRole('button', { name: 'Save and publish' }))
                expect(await screen.findByText(/^Published\. The KPIs lock/)).toBeInTheDocument()

                const put = api.callsTo('PUT', '/api/kpi/sheets/90')[0]
                expect(bodyOf(put).items).toEqual([
                        {
                                kpi_definition_id: 7,
                                weightage: '33.33',
                                target_value: '120',
                                target_note: null,
                                unit: null,
                                scoring_policy_id: null,
                        },
                        {
                                kpi_definition_id: 8,
                                weightage: '33.33',
                                target_value: null,
                                target_note: null,
                                unit: null,
                                scoring_policy_id: null,
                        },
                        {
                                kpi_definition_id: 9,
                                weightage: '33.34',
                                target_value: '30',
                                target_note: null,
                                unit: null,
                                scoring_policy_id: null,
                        },
                ])
                expect((put.init.headers as Record<string, string>)[CSRF_HEADER]).toBe(
                        'csrf-test.depthead',
                )
                expect(api.callsTo('POST', '/api/kpi/sheets/90/publish')).toHaveLength(1)
        })

        it('flags invalid rows next to the field', async () => {
                setup(kpiSheet())
                const { user } = renderApp('/kpi/sheets/90')
                await user.click(await screen.findByRole('button', { name: 'Add KPI' }))
                await user.click(screen.getByRole('button', { name: 'Add KPI' }))
                await user.selectOptions(screen.getByLabelText('KPI 1'), 'Test profit')
                await user.selectOptions(screen.getByLabelText('KPI 2'), 'Test profit')
                await user.type(screen.getByLabelText('Weightage % for KPI 1'), '50.555')
                await user.click(screen.getByRole('button', { name: 'Save draft' }))

                expect(screen.getByLabelText('Weightage % for KPI 1')).toHaveAccessibleDescription(
                        'Use at most two decimal places.',
                )
                expect(screen.getByLabelText('KPI 2')).toHaveAccessibleDescription(
                        'This KPI is already on the sheet.',
                )
                expect(screen.getByLabelText('Quarterly target for KPI 1')).toBeInvalid()
        })

        it('shows the API’s reasons when a save is refused', async () => {
                const api = setup(kpiSheet({ items: twoItems, total: 100 }), {
                        'PUT /api/kpi/sheets/90': () =>
                                json(422, {
                                        detail: 'Please correct the problems listed.',
                                        issues: [
                                                {
                                                        message: "'Test profit' does not apply to this plant and department.",
                                                        field: 'kpi_definition_id',
                                                        row: null,
                                                },
                                        ],
                                }),
                })
                const { user } = renderApp('/kpi/sheets/90')
                await user.click(await screen.findByRole('button', { name: 'Save draft' }))
                const issue = await screen.findByText(
                        "'Test profit' does not apply to this plant and department.",
                )
                const alert = issue.closest('[role="alert"]') as HTMLElement
                expect(within(alert).getByText('The change was not saved')).toBeInTheDocument()
                expect(
                        within(alert).getByText('Please correct the problems listed.'),
                ).toBeInTheDocument()
                expect(api.callsTo('PUT', '/api/kpi/sheets/90')).toHaveLength(1)
        })

        it('explains a locked sheet and offers a deviation instead of editing', async () => {
                setup(
                        kpiSheet({
                                status: 'LOCKED',
                                items: twoItems,
                                total: 100,
                                can_edit: false,
                                can_request_deviation: true,
                                locked_at: '2026-10-01T08:00:00Z',
                                quarter: { ...q1, status: 'OPEN' },
                        }),
                )
                const { user } = renderApp('/kpi/sheets/90')
                expect(await screen.findByText(/Locked since 1 Oct 2026/)).toBeInTheDocument()
                expect(screen.queryByRole('button', { name: 'Save draft' })).not.toBeInTheDocument()
                expect(screen.queryByLabelText('Weightage % for KPI 1')).not.toBeInTheDocument()
                expect(screen.getAllByText('Frozen')).toHaveLength(2)

                await user.click(screen.getByRole('button', { name: 'Request a deviation…' }))
                expect(screen.getByLabelText('Weightage % for KPI 1')).toHaveValue('40')
                await user.click(screen.getByRole('button', { name: 'Submit for approval' }))
                expect(
                        screen.getByLabelText('Reason for the deviation'),
                ).toHaveAccessibleDescription('Explain the reason (at least 10 characters).')
        })

        it('links to the pending deviation rather than allowing a second one', async () => {
                setup(
                        kpiSheet({
                                status: 'LOCKED',
                                items: twoItems,
                                total: 100,
                                can_edit: false,
                                can_request_deviation: false,
                                pending_deviation_id: 70,
                                quarter: { ...q1, status: 'OPEN' },
                        }),
                )
                renderApp('/kpi/sheets/90')
                const link = await screen.findByRole('link', { name: 'View the pending deviation' })
                expect(link).toHaveAttribute('href', '/kpi/deviations/70')
                expect(
                        screen.queryByRole('button', { name: 'Request a deviation…' }),
                ).not.toBeInTheDocument()
        })

        it('copies a sheet to another open quarter', async () => {
                const api = setup(kpiSheet({ items: twoItems, total: 100 }), {
                        'POST /api/kpi/sheets/90/copy': reply(
                                201,
                                kpiSheet({ id: 91, quarter: q2, items: twoItems, total: 100 }),
                        ),
                        'GET /api/kpi/sheets/91': reply(
                                200,
                                kpiSheet({ id: 91, quarter: q2, items: twoItems, total: 100 }),
                        ),
                })
                const { user } = renderApp('/kpi/sheets/90')
                await user.click(await screen.findByRole('button', { name: 'Copy as draft' }))
                await screen.findByRole('heading', { name: 'Tess Person · TQ2' })
                await waitFor(() =>
                        expect(
                                JSON.parse(
                                        String(
                                                api.callsTo('POST', '/api/kpi/sheets/90/copy')[0]
                                                        .init.body,
                                        ),
                                ),
                        ).toEqual({
                                target_quarter_id: 42,
                        }),
                )
        })
})
