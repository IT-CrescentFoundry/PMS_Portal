import { screen, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { deptHeadUser, plantHeadUser, q1, q2 } from '../../test/kpiFixtures'
import { matrixHrHead, resultDetail } from '../../test/matrixFixtures'
import { installMockApi, reply } from '../../test/mockApi'
import { renderApp } from '../../test/renderApp'
import type { DataImportPreview, ScoreOverride } from '../../types/api'

const scoringQ2 = { ...q2, status: 'OPEN' as const }

const preview = (overrides: Partial<DataImportPreview> = {}): DataImportPreview => ({
        quarter: scoringQ2,
        period: '2026-11',
        file_name: 'november.csv',
        file_format: 'csv',
        columns: ['Employee Code', 'KPI', 'Period', 'Value'],
        contract: [
                {
                        key: 'employee_code',
                        label: 'Employee Code',
                        required: true,
                        description: 'The employee’s code.',
                },
                {
                        key: 'kpi',
                        label: 'KPI',
                        required: true,
                        description: 'The KPI’s code or name.',
                },
                {
                        key: 'actual',
                        label: 'Actual',
                        required: false,
                        description: 'The month’s value.',
                },
        ],
        mapping: { employee_code: 'Employee Code', kpi: 'KPI', actual: null },
        row_count: 1,
        counts: { new: 0, replace: 1, unchanged: 0 },
        issues: [],
        warnings: [],
        lines: [
                {
                        row: 2,
                        employee_code: 'T0001',
                        employee_name: 'Tess Person',
                        assignment: 'Test Quality — Test Plant A',
                        kpi_code: 'TK-7',
                        kpi_name: 'Test profit',
                        actual: '101',
                        inputs: null,
                        action: 'replace',
                        previous_actual: '99',
                        note: null,
                },
        ],
        lines_truncated: false,
        duplicate_import: null,
        ready: true,
        ...overrides,
})

const csv = () =>
        new File(['Employee Code,KPI,Period,Value\nT0001,TK-7,2026-11,101\n'], 'november.csv', {
                type: 'text/csv',
        })

describe('monthly KPI data import', () => {
        beforeEach(() => {
                vi.useFakeTimers({ toFake: ['Date'] })
                vi.setSystemTime(new Date('2026-11-20T10:00:00Z'))
        })
        afterEach(() => vi.useRealTimers())

        it('maps columns, asks before replacing stored values, then saves everything at once', async () => {
                const api = installMockApi({
                        'GET /api/auth/me': reply(200, matrixHrHead),
                        'GET /api/kpi/quarters': reply(200, [q1, scoringQ2]),
                        'GET /api/kpi/data/imports': reply(200, []),
                        'POST /api/kpi/data/preview': [
                                reply(
                                        200,
                                        preview({
                                                ready: false,
                                                issues: [
                                                        {
                                                                message: 'Tess Person, Test profit: a different value for November 2026 is already stored (99). Confirm replacing existing values to overwrite it.',
                                                                field: 'actual',
                                                                row: 2,
                                                        },
                                                ],
                                        }),
                                ),
                                reply(
                                        200,
                                        preview({
                                                mapping: {
                                                        employee_code: 'Employee Code',
                                                        kpi: 'KPI',
                                                        actual: 'Value',
                                                },
                                        }),
                                ),
                        ],
                        'POST /api/kpi/data/confirm': reply(200, {
                                import_id: 7,
                                created: 0,
                                replaced: 1,
                                unchanged: 0,
                                rows: 1,
                        }),
                })
                const { user } = renderApp('/scores/data')
                // The quarter being scored, and the latest month that has started.
                expect(await screen.findByLabelText('Month')).toHaveValue('2026-11')
                await user.upload(screen.getByLabelText('CSV or Excel file (up to 2 MB)'), csv())
                await user.click(screen.getByRole('button', { name: 'Check file' }))

                const problems = await screen.findByRole('table', { name: 'Problems in the file' })
                expect(within(problems).getByText(/already stored \(99\)/)).toBeInTheDocument()
                expect(screen.queryByRole('button', { name: /^Save / })).not.toBeInTheDocument()

                await user.selectOptions(screen.getByLabelText('Actual'), 'Value')
                await user.click(
                        screen.getByLabelText('Replace values already stored for this month'),
                )
                expect(screen.getByText('The settings changed since the check')).toBeInTheDocument()
                await user.click(screen.getByRole('button', { name: 'Check the file again' }))

                const save = await screen.findByRole('button', {
                        name: 'Save 1 value for November 2026',
                })
                const values = screen.getByRole('table', { name: 'Values in the file' })
                expect(within(values).getByText('Replaces')).toBeInTheDocument()
                await user.click(save)
                expect(await screen.findByText('Monthly values saved')).toBeInTheDocument()

                const [first, second] = api
                        .callsTo('POST', '/api/kpi/data/preview')
                        .map((c) => c.init.body as FormData)
                expect(first.get('quarter_id')).toBe('42')
                expect(first.get('period')).toBe('2026-11')
                expect(first.get('mapping')).toBeNull()
                expect(first.get('replace_existing')).toBe('false')
                expect(JSON.parse(String(second.get('mapping')))).toEqual({
                        employee_code: 'Employee Code',
                        kpi: 'KPI',
                        actual: 'Value',
                })
                expect(second.get('replace_existing')).toBe('true')
                const [confirm] = api.callsTo('POST', '/api/kpi/data/confirm')
                expect((confirm.init.body as FormData).get('replace_existing')).toBe('true')
                expect(api.callsTo('GET', '/api/kpi/data/imports')).toHaveLength(2)
        })

        it('is only for users who maintain KPIs', async () => {
                installMockApi({
                        'GET /api/auth/me': reply(200, plantHeadUser),
                        'GET /api/kpi/quarters': reply(200, [scoringQ2]),
                })
                renderApp('/scores/data')
                expect(
                        await screen.findByRole('heading', { name: 'Access denied' }),
                ).toBeInTheDocument()
        })
})

describe('quarterly results', () => {
        it('calculates the quarter and lists each sheet’s score', async () => {
                const detail = resultDetail()
                const api = installMockApi({
                        'GET /api/auth/me': reply(200, deptHeadUser),
                        'GET /api/kpi/quarters': reply(200, [q1, scoringQ2]),
                        'GET /api/kpi/results': reply(200, {
                                quarter: scoringQ2,
                                rows: [
                                        {
                                                assignment: detail.assignment,
                                                sheet: detail.sheet,
                                                result: detail.result,
                                        },
                                ],
                        }),
                        'POST /api/kpi/results/calculate': reply(200, {
                                calculated: 1,
                                unchanged: 0,
                                published: 0,
                                complete: 1,
                        }),
                })
                const { user } = renderApp('/scores/results')
                expect(await screen.findByRole('link', { name: 'Tess Person' })).toHaveAttribute(
                        'href',
                        '/scores/results/90',
                )
                expect(screen.getByText('3.40')).toBeInTheDocument()
                await user.click(screen.getByRole('button', { name: 'Calculate scores' }))
                expect(await screen.findByText('Calculation finished')).toBeInTheDocument()
                const [call] = api.callsTo('POST', '/api/kpi/results/calculate')
                expect(JSON.parse(String(call.init.body))).toEqual({
                        quarter_id: 42,
                        sheet_ids: null,
                })
        })

        it('explains each KPI score and records the review', async () => {
                const api = installMockApi({
                        'GET /api/auth/me': reply(200, deptHeadUser),
                        'GET /api/kpi/results/90': reply(200, resultDetail()),
                        'POST /api/kpi/results/90/review': reply(
                                200,
                                resultDetail({
                                        result: {
                                                ...resultDetail().result!,
                                                status: 'REVIEWED',
                                                reviewed_at: '2027-01-06T10:00:00Z',
                                        },
                                        reviewed_by: { id: 11, username: 'test.depthead' },
                                        actions: {
                                                can_calculate: true,
                                                can_review: false,
                                                can_publish: false,
                                                can_request_override: true,
                                        },
                                }),
                        ),
                })
                const { user } = renderApp('/scores/results/90')
                const kpi = await screen.findByRole('article', { name: 'Test profit' })
                expect(within(kpi).getByText('October 2026: 96 %')).toBeInTheDocument()
                expect(within(kpi).getByText('Average of the months')).toBeInTheDocument()
                expect(
                        within(kpi).getByRole('link', { name: 'KSM-0030 version 2' }),
                ).toHaveAttribute('href', '/matrices/30/versions/301')
                expect(
                        within(kpi).getByText(
                                'Rule 2: Achievement % is more than 90 % and at most 100 %',
                        ),
                ).toBeInTheDocument()
                expect(within(kpi).getByText('1.60')).toBeInTheDocument()
                expect(screen.getByText('3.4000')).toBeInTheDocument()
                await user.click(screen.getByRole('button', { name: 'Mark as reviewed' }))
                expect(await screen.findByText('Marked as reviewed.')).toBeInTheDocument()
                expect(api.callsTo('POST', '/api/kpi/results/90/review')).toHaveLength(1)
                expect(
                        screen.queryByRole('button', { name: 'Mark as reviewed' }),
                ).not.toBeInTheDocument()
        })

        it('requires a valid score and a reason for an override', async () => {
                const api = installMockApi({
                        'GET /api/auth/me': reply(200, deptHeadUser),
                        'GET /api/kpi/results/90': reply(200, resultDetail()),
                        'POST /api/kpi/results/90/overrides': reply(201, {}),
                })
                const { user } = renderApp('/scores/results/90')
                await user.click(
                        await screen.findByRole('button', { name: 'Request an override…' }),
                )
                await user.type(screen.getByLabelText('Proposed score'), '5.5')
                await user.click(screen.getByRole('button', { name: 'Request override' }))
                expect(
                        screen.getByText('Enter a score from 0 to 5 with at most two decimals.'),
                ).toBeInTheDocument()
                expect(
                        screen.getByText('Explain the override (at least 10 characters).'),
                ).toBeInTheDocument()
                expect(api.callsTo('POST', '/api/kpi/results/90/overrides')).toHaveLength(0)
                await user.clear(screen.getByLabelText('Proposed score'))
                await user.type(screen.getByLabelText('Proposed score'), '3.75')
                await user.type(
                        screen.getByLabelText('Reason'),
                        'Customer audit postponed by the client',
                )
                await user.click(screen.getByRole('button', { name: 'Request override' }))
                expect(await screen.findByText(/Override requested/)).toBeInTheDocument()
                const [call] = api.callsTo('POST', '/api/kpi/results/90/overrides')
                expect(JSON.parse(String(call.init.body))).toEqual({
                        proposed_score: '3.75',
                        reason: 'Customer audit postponed by the client',
                })
        })

        it('lets a Plant Head approve only their side of an override', async () => {
                const pending: ScoreOverride = {
                        id: 5,
                        status: 'PENDING',
                        sheet_id: 90,
                        employee: resultDetail().assignment.employee,
                        plant: resultDetail().assignment.plant,
                        department: resultDetail().assignment.department,
                        quarter_name: 'TQ2',
                        original_score: '3.40',
                        proposed_score: '3.75',
                        reason: 'Customer audit postponed by the client',
                        requested_by: { id: 11, username: 'test.depthead' },
                        requested_at: '2027-01-06T10:00:00Z',
                        hr_approved_by: null,
                        hr_approved_at: null,
                        plant_approved_by: null,
                        plant_approved_at: null,
                        rejected_by: null,
                        rejected_at: null,
                        rejection_reason: null,
                        applied_at: null,
                        voided_at: null,
                }
                const api = installMockApi({
                        'GET /api/auth/me': reply(200, plantHeadUser),
                        'GET /api/kpi/results/90': reply(
                                200,
                                resultDetail({
                                        pending_override: pending,
                                        actions: {
                                                can_calculate: false,
                                                can_review: false,
                                                can_publish: false,
                                                can_request_override: false,
                                        },
                                }),
                        ),
                        'POST /api/kpi/overrides/5/approve': reply(200, {
                                ...pending,
                                plant_approved_by: { id: 12, username: 'test.planthead' },
                        }),
                })
                const { user } = renderApp('/scores/results/90')
                const panel = await screen.findByRole('region', { name: 'Override request' })
                expect(
                        within(panel).getByText(
                                '3.40 → 3.75 requested by test.depthead on 6 Jan 2027.',
                        ),
                ).toBeInTheDocument()
                expect(
                        within(panel).queryByRole('button', { name: 'Approve as HR Head' }),
                ).not.toBeInTheDocument()
                await user.click(
                        within(panel).getByRole('button', { name: 'Approve as Plant Head' }),
                )
                expect(await screen.findByText('Approval recorded.')).toBeInTheDocument()
                const [call] = api.callsTo('POST', '/api/kpi/overrides/5/approve')
                expect(JSON.parse(String(call.init.body))).toEqual({ as: 'PLANT_HEAD' })
        })
})
