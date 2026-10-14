import { screen, waitFor, within } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import {
        adminUser,
        assignment,
        crossPlantEmployee,
        employeeList,
        noPrimaryEmployee,
        plantB,
        primaryElsewhereEmployee,
        production,
        quality,
        units,
} from '../../test/fixtures'
import { installMockApi, reply } from '../../test/mockApi'
import { renderApp } from '../../test/renderApp'

/** The only query parameters GET /api/employees supports. */
const SUPPORTED = new Set([
        'plant_id',
        'department_id',
        'primary_only',
        'include_inactive',
        'search',
        'as_of',
        'limit',
        'offset',
])

function setup(
        list = employeeList([crossPlantEmployee, primaryElsewhereEmployee, noPrimaryEmployee]),
) {
        const api = installMockApi({
                'GET /api/auth/me': reply(200, adminUser),
                'GET /api/org-units': reply(200, units),
                'GET /api/employees': reply(200, list),
        })
        return { api, lastQuery: () => api.callsTo('GET', '/api/employees').at(-1)!.query }
}

describe('employee directory', () => {
        it('shows each person once, with primary and supporting assignments', async () => {
                setup()
                renderApp('/employees')
                const row = (await screen.findByRole('link', { name: 'Tess Person' })).closest(
                        'tr',
                )!
                expect(screen.getAllByRole('link', { name: 'Tess Person' })).toHaveLength(1)
                expect(within(row).getByText('Primary')).toBeInTheDocument()
                expect(within(row).getByText('Supporting')).toBeInTheDocument()
                expect(within(row).getByText('Test Quality — Test Plant A')).toBeInTheDocument()
                expect(within(row).getByText('Test Quality — Test Plant B')).toBeInTheDocument()
        })

        it('does not guess primary status: hidden primary and missing primary are labelled', async () => {
                setup()
                renderApp('/employees')
                const elsewhere = (
                        await screen.findByRole('link', { name: 'Remy Support' })
                ).closest('tr')!
                expect(
                        within(elsewhere).getByText('Primary assignment is outside your access.'),
                ).toBeInTheDocument()
                const none = screen.getByRole('link', { name: 'Nadia Noprimary' }).closest('tr')!
                expect(within(none).getByText('No primary assignment recorded')).toBeInTheDocument()
        })

        it('translates filters into supported API parameters only', async () => {
                const { api, lastQuery } = setup()
                const { user } = renderApp('/employees')
                await screen.findByRole('link', { name: 'Tess Person' })

                await user.selectOptions(screen.getByLabelText('Plant'), String(plantB.id))
                await waitFor(() => expect(lastQuery().get('plant_id')).toBe(String(plantB.id)))
                await user.selectOptions(screen.getByLabelText('Department'), String(quality.id))
                await waitFor(() =>
                        expect(lastQuery().get('department_id')).toBe(String(quality.id)),
                )
                await user.click(
                        screen.getByLabelText('Only employees counted here (primary assignment)'),
                )
                await waitFor(() => expect(lastQuery().get('primary_only')).toBe('true'))
                await user.type(
                        screen.getByLabelText('Search by employee code or name'),
                        'Tess{Enter}',
                )
                await waitFor(() => expect(lastQuery().get('search')).toBe('Tess'))

                for (const call of api.callsTo('GET', '/api/employees')) {
                        for (const key of call.query.keys()) expect(SUPPORTED).toContain(key)
                }
        })

        it('offers only departments that exist at the chosen plant and clears invalid ones', async () => {
                const { lastQuery } = setup()
                const { user } = renderApp(`/employees?department_id=${production.id}`)
                await screen.findByRole('link', { name: 'Tess Person' })
                expect(lastQuery().get('department_id')).toBe(String(production.id))

                // Production exists only at Plant A; choosing Plant B must clear it.
                await user.selectOptions(screen.getByLabelText('Plant'), String(plantB.id))
                await waitFor(() => expect(lastQuery().get('plant_id')).toBe(String(plantB.id)))
                expect(lastQuery().has('department_id')).toBe(false)
                const departmentOptions = within(screen.getByLabelText('Department'))
                        .getAllByRole('option')
                        .map((o) => o.textContent)
                expect(departmentOptions).toEqual(['All departments', 'Test Quality'])
        })

        it('pages through results with offset and limit', async () => {
                const { lastQuery } = setup(employeeList([crossPlantEmployee], { total: 30 }))
                const { user } = renderApp('/employees')
                await screen.findByText(/of 30 employees/)
                await user.click(screen.getByRole('button', { name: 'Next' }))
                await waitFor(() => expect(lastQuery().get('offset')).toBe('25'))
                expect(lastQuery().get('limit')).toBe('25')
        })

        it('shows an empty state when nothing matches', async () => {
                setup(employeeList([]))
                renderApp('/employees?q=nobody')
                expect(await screen.findByText('No employees found')).toBeInTheDocument()
                expect(screen.getByText('No one matches these filters.')).toBeInTheDocument()
        })
})

describe('employee detail', () => {
        it('shows only returned assignments, with history status and a hidden-primary notice', async () => {
                installMockApi({
                        'GET /api/auth/me': reply(200, adminUser),
                        'GET /api/employees/502': reply(200, {
                                id: 502,
                                employee_code: 'T0002',
                                full_name: 'Remy Support',
                                email: null,
                                date_of_joining: '2020-01-01',
                                date_of_exit: null,
                                is_active: true,
                                as_of: '2026-08-01',
                                has_primary_assignment: true,
                                current_assignments: [
                                        assignment({ id: 3, plant: plantB, is_primary: false }),
                                ],
                                assignment_history: [
                                        assignment({
                                                id: 9,
                                                is_primary: false,
                                                effective_from: '2024-01-01',
                                                effective_to: '2025-03-31',
                                                is_current: false,
                                        }),
                                        assignment({ id: 3, plant: plantB, is_primary: false }),
                                ],
                        }),
                })
                renderApp('/employees/502')
                expect(
                        await screen.findByRole('heading', { level: 1, name: 'Remy Support' }),
                ).toBeInTheDocument()
                expect(
                        screen.getByText(/primary assignment is outside your access/),
                ).toBeInTheDocument()
                const history = screen.getByRole('table', {
                        name: 'Assignment history, oldest first',
                })
                expect(within(history).getByText('Ended')).toBeInTheDocument()
                expect(within(history).getByText('Current')).toBeInTheDocument()
        })

        it('lets an employee open their own record', async () => {
                installMockApi({
                        'GET /api/auth/me': reply(200, {
                                ...adminUser,
                                permissions: ['self:read'],
                                employee: {
                                        id: 501,
                                        employee_code: 'T0001',
                                        full_name: 'Tess Person',
                                },
                                roles: [],
                        }),
                        'GET /api/employees/501': reply(200, {
                                id: 501,
                                employee_code: 'T0001',
                                full_name: 'Tess Person',
                                email: null,
                                date_of_joining: null,
                                date_of_exit: null,
                                is_active: true,
                                as_of: '2026-08-01',
                                has_primary_assignment: true,
                                current_assignments: [assignment()],
                                assignment_history: [assignment()],
                        }),
                })
                renderApp('/employees/501')
                expect(
                        await screen.findByRole('heading', { level: 1, name: 'Tess Person' }),
                ).toBeInTheDocument()
                expect(screen.getByText('You')).toBeInTheDocument()
        })
})
