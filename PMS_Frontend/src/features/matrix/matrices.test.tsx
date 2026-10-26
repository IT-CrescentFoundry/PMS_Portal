import { fireEvent, screen, within } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { units } from '../../test/fixtures'
import { deptHeadUser } from '../../test/kpiFixtures'
import {
        chroUser,
        incrementType,
        kpiScoringType,
        matrixDetail,
        matrixHrHead,
        matrixReader,
        matrixVersion,
} from '../../test/matrixFixtures'
import { installMockApi, reply } from '../../test/mockApi'
import { renderApp } from '../../test/renderApp'
import type { CurrentUser, MatrixUploadPreview } from '../../types/api'

const by = (user: CurrentUser) => ({ id: user.id, username: user.username })

function setupList(me: CurrentUser, matrices = [matrixDetail()]) {
        return installMockApi({
                'GET /api/auth/me': reply(200, me),
                'GET /api/matrix-types': reply(200, [kpiScoringType, incrementType]),
                'GET /api/matrices': reply(200, matrices),
        })
}

describe('matrix list', () => {
        it('lists matrices and marks types awaiting approved configuration', async () => {
                setupList(matrixHrHead)
                renderApp('/matrices')
                expect(
                        await screen.findByRole('link', { name: 'Test delivery scoring' }),
                ).toHaveAttribute('href', '/matrices/30')
                expect(
                        screen.getByText(
                                /increment percentages and budget rules have not been defined/,
                        ),
                ).toBeInTheDocument()
                expect(screen.getByRole('link', { name: 'New matrix' })).toBeInTheDocument()
                expect(screen.getByRole('link', { name: 'Upload from Excel' })).toBeInTheDocument()
                const nav = screen.getByRole('navigation', { name: 'Main' })
                expect(within(nav).getByRole('link', { name: 'Matrices' })).toBeInTheDocument()
        })

        it('offers no authoring to readers', async () => {
                setupList(matrixReader)
                renderApp('/matrices')
                await screen.findByRole('link', { name: 'Test delivery scoring' })
                expect(screen.queryByRole('link', { name: 'New matrix' })).not.toBeInTheDocument()
        })

        it('is hidden from users without matrix access', async () => {
                const api = setupList(deptHeadUser)
                renderApp('/matrices')
                expect(
                        await screen.findByRole('heading', { name: 'Access denied' }),
                ).toBeInTheDocument()
                const nav = screen.getByRole('navigation', { name: 'Main' })
                expect(
                        within(nav).queryByRole('link', { name: 'Matrices' }),
                ).not.toBeInTheDocument()
                expect(api.callsTo('GET', '/api/matrices')).toHaveLength(0)
        })

        it('shows an empty state', async () => {
                setupList(matrixHrHead, [])
                renderApp('/matrices')
                expect(await screen.findByText('No matrices yet')).toBeInTheDocument()
                expect(
                        screen.getByRole('link', { name: 'Create the first matrix' }),
                ).toBeInTheDocument()
        })

        it('offers a retry when the list cannot load', async () => {
                const api = installMockApi({
                        'GET /api/auth/me': reply(200, matrixHrHead),
                        'GET /api/matrix-types': reply(200, [kpiScoringType]),
                        'GET /api/matrices': [reply(503), reply(200, [matrixDetail()])],
                })
                const { user } = renderApp('/matrices')
                await user.click(await screen.findByRole('button', { name: 'Retry' }))
                expect(
                        await screen.findByRole('link', { name: 'Test delivery scoring' }),
                ).toBeInTheDocument()
                expect(api.callsTo('GET', '/api/matrices')).toHaveLength(2)
        })
})

function setupEditor() {
        return installMockApi({
                'GET /api/auth/me': reply(200, matrixHrHead),
                'GET /api/matrix-types': reply(200, [kpiScoringType]),
                'GET /api/org-units': reply(200, units),
                'GET /api/matrices/30': reply(200, matrixDetail()),
                'GET /api/matrices/30/versions/301': reply(200, matrixVersion()),
        })
}

describe('matrix editor', () => {
        it('adds a new field everywhere it is used and saves it with the rules', async () => {
                const api = setupEditor()
                api.set(
                        'PUT /api/matrices/30/versions/301',
                        reply(
                                200,
                                matrixVersion({
                                        check: {
                                                ok: false,
                                                errors: [
                                                        {
                                                                path: 'rules[1].conditions.defect_band',
                                                                message: 'Rule 2: choose at least one value.',
                                                        },
                                                ],
                                                warnings: [],
                                                test_results: [],
                                                gaps: [],
                                                readiness: [],
                                                ready_to_submit: false,
                                        },
                                }),
                        ),
                )
                const { user } = renderApp('/matrices/30/versions/301/edit')
                expect(
                        await screen.findByRole('heading', {
                                name: 'Edit Test delivery scoring · version 1',
                        }),
                ).toBeInTheDocument()

                await user.click(screen.getByRole('button', { name: 'Add a custom input' }))
                const card = screen.getByRole('group', { name: 'Input 2: New field' })
                await user.type(within(card).getByLabelText('Label'), 'Defect band')
                expect(within(card).getByLabelText('Key')).toHaveValue('defect_band')
                await user.selectOptions(within(card).getByLabelText('Data type'), 'CATEGORY')
                await user.type(
                        within(card).getByLabelText('Allowed values (one per line)'),
                        'A{Enter}B',
                )
                await user.selectOptions(
                        within(card).getByLabelText('Monthly values combine by'),
                        'LAST',
                )

                // The new input appears in every rule, every test case and the preview.
                expect(
                        screen.getByRole('combobox', {
                                name: 'Defect band: condition, rule row 1',
                        }),
                ).toBeInTheDocument()
                expect(
                        screen.getByRole('combobox', {
                                name: 'Defect band: condition, rule row 2',
                        }),
                ).toBeInTheDocument()
                expect(
                        screen.getByRole('combobox', { name: 'Defect band, test case 1' }),
                ).toBeInTheDocument()
                expect(
                        screen.getByRole('combobox', { name: 'Defect band, try it' }),
                ).toBeInTheDocument()

                await user.selectOptions(
                        screen.getByRole('combobox', {
                                name: 'Defect band: condition, rule row 1',
                        }),
                        'set',
                )
                await user.click(
                        within(
                                screen.getByRole('group', {
                                        name: 'Defect band: values, rule row 1',
                                }),
                        ).getByLabelText('A'),
                )
                await user.click(screen.getByRole('button', { name: 'Save draft' }))

                expect(
                        await screen.findByText('Rule 2: choose at least one value.'),
                ).toBeInTheDocument()
                expect(screen.getByText('Rule row 2:')).toBeInTheDocument()
                const [put] = api.callsTo('PUT', '/api/matrices/30/versions/301')
                const body = JSON.parse(String(put.init.body))
                expect(body.definition.fields[2]).toMatchObject({
                        key: 'defect_band',
                        label: 'Defect band',
                        role: 'input',
                        data_type: 'CATEGORY',
                        allowed_values: ['A', 'B'],
                        source: 'IMPORTED',
                        aggregation: 'LAST',
                })
                expect(body.definition.rules[0].conditions.defect_band).toEqual({ values: ['A'] })
                expect(body.definition.rules[1].conditions.defect_band).toBeUndefined()
                expect(body.applicability).toEqual([{ plant_id: null, department_id: null }])
                expect(body.effective_from).toBe('2026-10-01')
                expect(screen.getByText('Draft saved')).toBeInTheDocument()
        })

        it('asks for each bound whether it is included, and checks without saving', async () => {
                const api = setupEditor()
                api.set(
                        'POST /api/matrix-types/KPI_SCORING/check',
                        reply(200, {
                                check: {
                                        ok: false,
                                        errors: [
                                                {
                                                        path: 'rules[0].conditions.achievement_percent.min_inclusive',
                                                        message: 'Achievement % lower bound: state whether 95 itself is included.',
                                                },
                                        ],
                                        warnings: [],
                                        test_results: [],
                                        gaps: [],
                                },
                                rule_summaries: [],
                                preview: null,
                                preview_error: null,
                        }),
                )
                const { user } = renderApp('/matrices/30/versions/301/edit')
                await user.click(await screen.findByRole('button', { name: 'Add a rule' }))
                await user.selectOptions(
                        screen.getByRole('combobox', {
                                name: 'Achievement %: condition, rule row 3',
                        }),
                        'range',
                )
                expect(
                        screen.getByRole('combobox', {
                                name: 'Achievement %: lower bound, rule row 3',
                        }),
                ).toHaveValue('')
                await user.type(
                        screen.getByRole('textbox', {
                                name: 'Achievement %: lower bound value, rule row 3',
                        }),
                        '95',
                )
                expect(
                        screen.getByText('Matches 95 (choose whether it is included).'),
                ).toBeInTheDocument()
                await user.click(screen.getByRole('button', { name: 'Check the rules' }))
                expect(
                        await screen.findByText(
                                'Achievement % lower bound: state whether 95 itself is included.',
                        ),
                ).toBeInTheDocument()
                const [call] = api.callsTo('POST', '/api/matrix-types/KPI_SCORING/check')
                const body = JSON.parse(String(call.init.body))
                expect(body.definition.rules[2]).toMatchObject({
                        priority: 3,
                        conditions: { achievement_percent: { min: '95', min_inclusive: null } },
                })
                expect(body.attributes).toEqual({ direction: 'HIGHER_IS_BETTER' })
                expect(api.callsTo('PUT', '/api/matrices/30/versions/301')).toHaveLength(0)
        })

        it('never edits a version that is no longer a draft', async () => {
                const api = setupEditor()
                api.set(
                        'GET /api/matrices/30/versions/301',
                        reply(
                                200,
                                matrixVersion({
                                        status: 'PUBLISHED',
                                        actions: {
                                                can_edit: false,
                                                can_submit: false,
                                                can_withdraw: false,
                                                can_approve: false,
                                                can_publish: false,
                                        },
                                }),
                        ),
                )
                renderApp('/matrices/30/versions/301/edit')
                expect(await screen.findByText('Only a draft can be edited')).toBeInTheDocument()
                expect(screen.queryByRole('button', { name: 'Save draft' })).not.toBeInTheDocument()
        })
})

function setupVersion(me: CurrentUser, version = matrixVersion()) {
        return installMockApi({
                'GET /api/auth/me': reply(200, me),
                'GET /api/matrix-types': reply(200, [kpiScoringType]),
                'GET /api/matrices/30': reply(200, matrixDetail()),
                'GET /api/matrices/30/versions/301': reply(200, version),
        })
}

const submitted = matrixVersion({
        status: 'SUBMITTED',
        submitted_by: by(matrixHrHead),
        submitted_at: '2026-10-11T09:00:00Z',
        actions: {
                can_edit: false,
                can_submit: false,
                can_withdraw: false,
                can_approve: true,
                can_publish: false,
        },
})

describe('matrix approval', () => {
        it('lets the CHRO reject only with a reason', async () => {
                const api = setupVersion(chroUser, submitted)
                api.set(
                        'POST /api/matrices/30/versions/301/reject',
                        reply(
                                200,
                                matrixVersion({
                                        status: 'REJECTED',
                                        rejected_by: by(chroUser),
                                        rejected_at: '2026-10-12T09:00:00Z',
                                        rejection_reason: 'Bands need a legal review',
                                        actions: {
                                                can_edit: false,
                                                can_submit: false,
                                                can_withdraw: false,
                                                can_approve: false,
                                                can_publish: false,
                                        },
                                }),
                        ),
                )
                const { user } = renderApp('/matrices/30/versions/301')
                await user.click(await screen.findByRole('button', { name: 'Reject…' }))
                await user.click(screen.getByRole('button', { name: 'Reject version 1' }))
                expect(screen.getByText('Enter a reason.')).toBeInTheDocument()
                expect(api.callsTo('POST', '/api/matrices/30/versions/301/reject')).toHaveLength(0)
                await user.type(
                        screen.getByLabelText('Reason for rejecting'),
                        'Bands need a legal review',
                )
                await user.click(screen.getByRole('button', { name: 'Reject version 1' }))
                expect(await screen.findByText('Bands need a legal review')).toBeInTheDocument()
                const [call] = api.callsTo('POST', '/api/matrices/30/versions/301/reject')
                expect(JSON.parse(String(call.init.body))).toEqual({
                        reason: 'Bands need a legal review',
                })
        })

        it('records an optional approval note', async () => {
                const api = setupVersion(chroUser, submitted)
                api.set(
                        'POST /api/matrices/30/versions/301/approve',
                        reply(
                                200,
                                matrixVersion({
                                        status: 'APPROVED',
                                        approved_by: by(chroUser),
                                        approved_at: '2026-10-12T09:00:00Z',
                                        approval_note: 'Matches the policy circular',
                                        actions: {
                                                can_edit: false,
                                                can_submit: false,
                                                can_withdraw: false,
                                                can_approve: false,
                                                can_publish: true,
                                        },
                                }),
                        ),
                )
                const { user } = renderApp('/matrices/30/versions/301')
                await user.click(await screen.findByRole('button', { name: 'Approve…' }))
                await user.type(
                        screen.getByLabelText('Approval note (optional)'),
                        'Matches the policy circular',
                )
                await user.click(screen.getByRole('button', { name: 'Approve version 1' }))
                expect(await screen.findByRole('button', { name: 'Publish' })).toBeInTheDocument()
                const [call] = api.callsTo('POST', '/api/matrices/30/versions/301/approve')
                expect(JSON.parse(String(call.init.body))).toEqual({
                        note: 'Matches the policy circular',
                })
        })

        it('blocks submission until the version is ready, and previews a result', async () => {
                const api = setupVersion(
                        matrixHrHead,
                        matrixVersion({
                                effective_from: null,
                                check: {
                                        ...matrixVersion().check,
                                        readiness: [
                                                {
                                                        path: 'effective_from',
                                                        message: 'Set the date from which this version applies.',
                                                },
                                        ],
                                        ready_to_submit: false,
                                },
                        }),
                )
                api.set(
                        'POST /api/matrices/30/versions/301/preview',
                        reply(200, {
                                outputs: { score: 4 },
                                rule: {
                                        priority: 2,
                                        label: 'Near target',
                                        description:
                                                'Achievement % is more than 90 % and at most 100 %',
                                },
                                used_default: false,
                                inputs: { achievement_percent: '100' },
                        }),
                )
                const { user } = renderApp('/matrices/30/versions/301')
                expect(
                        await screen.findByRole('button', { name: 'Submit for approval' }),
                ).toBeDisabled()
                expect(
                        screen.getByText('Set the date from which this version applies.'),
                ).toBeInTheDocument()
                await user.type(
                        screen.getByRole('textbox', { name: 'Achievement %, try this version' }),
                        '100',
                )
                await user.click(screen.getByRole('button', { name: 'Show the result' }))
                expect(await screen.findByText('Result: Score: 4')).toBeInTheDocument()
                const [call] = api.callsTo('POST', '/api/matrices/30/versions/301/preview')
                expect(JSON.parse(String(call.init.body))).toEqual({
                        inputs: { achievement_percent: '100' },
                })
        })
})

function upload(preview: MatrixUploadPreview) {
        return installMockApi({
                'GET /api/auth/me': reply(200, matrixHrHead),
                'GET /api/matrix-types': reply(200, [kpiScoringType]),
                'POST /api/matrices/uploads/preview': reply(200, preview),
                'POST /api/matrices/uploads/confirm': reply(200, {
                        matrix_id: 31,
                        matrix_code: 'KSM-0031',
                        version_id: 311,
                        version_no: 1,
                }),
        })
}

const basePreview: MatrixUploadPreview = {
        action: 'create',
        matrix_type: 'KPI_SCORING',
        type_name: 'KPI scoring matrix',
        matrix_code: null,
        name: 'Uploaded scoring',
        target_version_no: null,
        template_version: 1,
        schema_version: 1,
        effective_from: '2026-10-01',
        effective_to: null,
        applicability: ['Company-wide'],
        fields: matrixVersion().definition.fields,
        rules: matrixVersion().rule_summaries,
        test_results: [],
        problems: [],
        warnings: [],
        ready: true,
}

const workbook = () =>
        new File(['PK fake workbook'], 'scoring.xlsx', {
                type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        })

describe('matrix upload', () => {
        it('reports problems with their workbook location and saves nothing', async () => {
                const api = upload({
                        ...basePreview,
                        ready: false,
                        problems: [
                                {
                                        location: 'Rules, row 7',
                                        message: 'Rule 2 overlaps rule 1 where Achievement % is exactly 100 %.',
                                },
                        ],
                })
                const { user } = renderApp('/matrices/upload')
                await user.upload(
                        await screen.findByLabelText('Excel file (.xlsx, up to 1 MB)'),
                        workbook(),
                )
                await user.click(screen.getByRole('button', { name: 'Check file' }))
                const table = await screen.findByRole('table', { name: 'Problems in the workbook' })
                expect(within(table).getByText('Rules, row 7')).toBeInTheDocument()
                expect(
                        screen.getByRole('button', { name: 'Download the report (CSV)' }),
                ).toBeInTheDocument()
                expect(
                        screen.queryByRole('button', { name: 'Save as draft' }),
                ).not.toBeInTheDocument()
                expect(api.callsTo('POST', '/api/matrices/uploads/confirm')).toHaveLength(0)
        })

        it('saves a valid workbook as a draft after the preview', async () => {
                const api = upload(basePreview)
                const { user } = renderApp('/matrices/upload')
                await user.upload(
                        await screen.findByLabelText('Excel file (.xlsx, up to 1 MB)'),
                        workbook(),
                )
                await user.click(screen.getByRole('button', { name: 'Check file' }))
                expect(await screen.findByText('The workbook is valid')).toBeInTheDocument()
                await user.click(screen.getByRole('button', { name: 'Save as draft' }))
                expect(
                        await screen.findByRole('link', { name: 'Open version 1 of KSM-0031' }),
                ).toHaveAttribute('href', '/matrices/31/versions/311')
                expect(api.callsTo('POST', '/api/matrices/uploads/confirm')).toHaveLength(1)
        })

        it('refuses files that are not Excel workbooks before sending them', async () => {
                const api = upload(basePreview)
                const { user } = renderApp('/matrices/upload')
                const input = await screen.findByLabelText('Excel file (.xlsx, up to 1 MB)')
                fireEvent.change(input, {
                        target: { files: [new File(['a,b'], 'rules.csv', { type: 'text/csv' })] },
                })
                await user.click(screen.getByRole('button', { name: 'Check file' }))
                expect(
                        screen.getByText(
                                'Choose an Excel workbook (.xlsx) generated by the portal.',
                        ),
                ).toBeInTheDocument()
                expect(api.callsTo('POST', '/api/matrices/uploads/preview')).toHaveLength(0)
        })
})
