import { screen, within } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { plantA, quality } from '../../test/fixtures'
import { deptHeadUser, plantHeadUser, q1, q2 } from '../../test/kpiFixtures'
import { installMockApi, reply } from '../../test/mockApi'
import { renderApp } from '../../test/renderApp'
import type { UploadPreview } from '../../types/api'

const employee = { id: 501, employee_code: 'T0001', full_name: 'Tess Person' }

const validPreview: UploadPreview = {
        quarter: q1,
        row_count: 2,
        issues: [],
        sheets: [
                {
                        employee,
                        plant: plantA,
                        department: quality,
                        action: 'create',
                        items: [
                                {
                                        row: 2,
                                        kpi_name: 'Test profit',
                                        weightage: 60,
                                        target_value: 120,
                                        unit: null,
                                        scoring_policy: null,
                                        target_note: null,
                                },
                                {
                                        row: 3,
                                        kpi_name: 'Test inventory days',
                                        weightage: 40,
                                        target_value: 30,
                                        unit: 'days',
                                        scoring_policy: 'TP-B',
                                        target_note: null,
                                },
                        ],
                        total: 100,
                },
        ],
}

function xlsx(name = 'kpis.xlsx') {
        return new File(['PK fake workbook'], name, {
                type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        })
}

function setup(preview: UploadPreview, me = deptHeadUser) {
        return installMockApi({
                'GET /api/auth/me': reply(200, me),
                'GET /api/kpi/quarters': reply(200, [{ ...q1, status: 'OPEN' }, q2]),
                'POST /api/kpi/uploads/preview': reply(200, preview),
                'POST /api/kpi/uploads/confirm': reply(200, {
                        sheets_created: 1,
                        sheets_updated: 0,
                        items: 2,
                        rows: 2,
                }),
                'GET /api/org-units': reply(200, []),
        })
}

describe('Excel KPI upload', () => {
        it('lists every problem with its row and offers no save', async () => {
                const api = setup({
                        ...validPreview,
                        sheets: [],
                        issues: [
                                {
                                        message: "KPI 'Scrap' is not in the KPI library (add it there first).",
                                        field: 'kpi',
                                        row: 4,
                                },
                                {
                                        message: 'T0001: Weightages total 90.00 %; they must total exactly 100 %.',
                                        field: 'weightage',
                                        row: 2,
                                },
                        ],
                })
                const { user } = renderApp('/kpi/upload')
                await user.upload(
                        await screen.findByLabelText('Excel file (.xlsx, up to 1 MB)'),
                        xlsx(),
                )
                await user.click(screen.getByRole('button', { name: 'Check file' }))

                expect(await screen.findByText('2 problems found in 2 rows')).toBeInTheDocument()
                const table = screen.getByRole('table', { name: 'Problems in the file' })
                const rows = within(table).getAllByRole('row').slice(1)
                expect(within(rows[0]).getByText('4')).toBeInTheDocument()
                expect(within(rows[0]).getByText(/not in the KPI library/)).toBeInTheDocument()
                expect(screen.queryByRole('button', { name: /^Save/ })).not.toBeInTheDocument()
                expect(api.callsTo('POST', '/api/kpi/uploads/confirm')).toHaveLength(0)
        })

        it('previews, then saves the same file for the chosen open quarter', async () => {
                const api = setup(validPreview)
                const { user } = renderApp('/kpi/upload')
                // Only quarters still in KPI setup can receive uploads.
                const quarter = await screen.findByLabelText('Quarter')
                expect(
                        within(quarter)
                                .getAllByRole('option')
                                .map((o) => o.textContent),
                ).toEqual([expect.stringContaining('TQ2')])
                const file = xlsx()
                await user.upload(screen.getByLabelText('Excel file (.xlsx, up to 1 MB)'), file)
                await user.click(screen.getByRole('button', { name: 'Check file' }))

                expect(await screen.findByText('The file is valid')).toBeInTheDocument()
                expect(
                        screen.getByRole('table', { name: 'Uploaded KPIs for Tess Person' }),
                ).toBeInTheDocument()
                expect(api.callsTo('POST', '/api/kpi/uploads/confirm')).toHaveLength(0)

                await user.click(screen.getByRole('button', { name: 'Save 1 sheet as drafts' }))
                expect(await screen.findByText('Upload saved')).toBeInTheDocument()
                const body = api.callsTo('POST', '/api/kpi/uploads/confirm')[0].init
                        .body as FormData
                expect(body.get('quarter_id')).toBe(String(q2.id))
                expect((body.get('file') as File).name).toBe('kpis.xlsx')
        })

        it('rejects non-xlsx files before sending anything', async () => {
                const api = setup(validPreview)
                const { user } = renderApp('/kpi/upload')
                const input = await screen.findByLabelText('Excel file (.xlsx, up to 1 MB)')
                // The spreadsheet MIME type passes the input's accept filter; the name decides.
                await user.upload(input, xlsx('kpis.xls'))
                expect(screen.getByText(/Choose an Excel workbook \(\.xlsx\)/)).toBeInTheDocument()
                await user.click(screen.getByRole('button', { name: 'Check file' }))
                expect(api.callsTo('POST', '/api/kpi/uploads/preview')).toHaveLength(0)
        })

        it('is not available to users who cannot maintain KPIs', async () => {
                setup(validPreview, plantHeadUser)
                renderApp('/kpi/upload')
                expect(
                        await screen.findByRole('heading', { name: 'Access denied' }),
                ).toBeInTheDocument()
        })
})
