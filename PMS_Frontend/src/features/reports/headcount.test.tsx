import { screen, waitFor, within } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { adminUser, headcountReport, plantA, plantB, quality, units } from '../../test/fixtures'
import { deferred, installMockApi, reply } from '../../test/mockApi'
import { renderApp } from '../../test/renderApp'
import { describeView } from './headcountView'

describe('headcount report', () => {
        it('shows the API headcount as the total, never a client-side sum of units', async () => {
                // Units sum to 5, but one person works in two units: the API counts 4.
                const report = headcountReport({
                        headcount: 4,
                        by_unit: [
                                { plant_department_id: 1001, plant: plantA, department: quality, headcount: 3, supporting: 0 },
                                { plant_department_id: 1002, plant: plantB, department: quality, headcount: 2, supporting: 1 },
                        ],
                })
                installMockApi({
                        'GET /api/auth/me': reply(200, adminUser),
                        'GET /api/org-units': reply(200, units),
                        'GET /api/reports/headcount': reply(200, report),
                })
                renderApp(`/reports/headcount?department_id=${quality.id}`)
                expect(await screen.findByRole('heading', { name: 'Test Quality — All Plants' })).toBeInTheDocument()
                const table = screen.getByRole('table')
                const footer = within(table).getByText('Total headcount (each person counted once)').closest('tr')!
                expect(within(footer).getByText('4')).toBeInTheDocument()
        })

        it('surfaces data-quality and limited-access notes from the API', async () => {
                installMockApi({
                        'GET /api/auth/me': reply(200, adminUser),
                        'GET /api/org-units': reply(200, units),
                        'GET /api/reports/headcount': reply(
                                200,
                                headcountReport({
                                        employees_without_primary: 2,
                                        scope: { plant_id: null, department_id: null, label: 'All Departments — All Plants', access_limited: true },
                                }),
                        ),
                })
                renderApp('/reports/headcount')
                expect(await screen.findByText(/Your access covers only part of this selection/)).toBeInTheDocument()
                expect(screen.getByText('Not counted; please review their records')).toBeInTheDocument()
        })

        it('never lets an older response replace the report for newer filters', async () => {
                const slowOld = deferred(200, headcountReport({ scope: { plant_id: null, department_id: null, label: 'OLD — All Plants', access_limited: false } }))
                const fastNew = reply(
                        200,
                        headcountReport({ scope: { plant_id: plantB.id, department_id: null, label: 'NEW — Test Plant B', access_limited: false } }),
                )
                const api = installMockApi({
                        'GET /api/auth/me': reply(200, adminUser),
                        'GET /api/org-units': reply(200, units),
                        'GET /api/reports/headcount': [slowOld.handler, fastNew],
                })
                const { user } = renderApp('/reports/headcount')
                await waitFor(() => expect(screen.getByLabelText('Plant')).toBeEnabled())
                await user.selectOptions(screen.getByLabelText('Plant'), String(plantB.id))

                expect(await screen.findByRole('heading', { name: 'NEW — Test Plant B' })).toBeInTheDocument()
                slowOld.release() // the stale request finishes late (it was also aborted)
                await new Promise((r) => setTimeout(r, 20))
                expect(screen.queryByRole('heading', { name: 'OLD — All Plants' })).not.toBeInTheDocument()
                expect(api.callsTo('GET', '/api/reports/headcount').at(-1)!.query.get('plant_id')).toBe(String(plantB.id))
        })

        it('describes each view in plain words', () => {
                expect(describeView(true, true)).toBe('One department at one plant')
                expect(describeView(false, true)).toMatch(/across all accessible plants/)
                expect(describeView(true, false)).toBe('All departments at one plant')
                expect(describeView(false, false)).toBe('All accessible plants and departments')
        })
})

describe('department views', () => {
        it('plant-specific view uses the API label and lists people with their assignment type', async () => {
                installMockApi({
                        'GET /api/auth/me': reply(200, adminUser),
                        'GET /api/reports/headcount': reply(
                                200,
                                headcountReport({
                                        scope: { plant_id: plantB.id, department_id: quality.id, label: 'Test Quality — Test Plant B', access_limited: false },
                                        headcount: 1,
                                        supporting_employees: 1,
                                        by_unit: [{ plant_department_id: 1002, plant: plantB, department: quality, headcount: 1, supporting: 1 }],
                                }),
                        ),
                        'GET /api/employees': reply(200, {
                                items: [
                                        {
                                                id: 501, employee_code: 'T0001', full_name: 'Tess Person', email: null, is_active: true,
                                                has_primary_assignment: true, primary_assignment: null,
                                                matching_assignments: [{ id: 2, plant_department_id: 1002, plant: plantB, department: quality, designation: { id: 1, code: 'E', name: 'Engineer' }, reporting_manager: null, is_primary: false, effective_from: '2026-04-01', effective_to: null, is_current: true }],
                                        },
                                ],
                                total: 1, limit: 50, offset: 0, as_of: '2026-08-01',
                        }),
                })
                renderApp(`/departments/${quality.id}/plants/${plantB.id}`)
                expect(await screen.findByRole('heading', { level: 1, name: 'Test Quality — Test Plant B' })).toBeInTheDocument()
                const row = screen.getByRole('link', { name: 'Tess Person' }).closest('tr')!
                expect(within(row).getByText('Supporting')).toBeInTheDocument()
        })

        it('explains when a department is not set up at a plant', async () => {
                installMockApi({
                        'GET /api/auth/me': reply(200, adminUser),
                        'GET /api/reports/headcount': reply(
                                200,
                                headcountReport({
                                        scope: { plant_id: plantB.id, department_id: 11, label: 'Test Production — Test Plant B', access_limited: false },
                                        headcount: 0,
                                        by_unit: [],
                                }),
                        ),
                        'GET /api/employees': reply(200, { items: [], total: 0, limit: 50, offset: 0, as_of: '2026-08-01' }),
                })
                renderApp(`/departments/11/plants/${plantB.id}`)
                expect(await screen.findByText('This department is not set up at this plant')).toBeInTheDocument()
        })
})
