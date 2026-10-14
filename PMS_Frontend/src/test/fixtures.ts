/** Synthetic test data shaped exactly like the API responses. */
import type {
        Assignment,
        CurrentUser,
        EmployeeList,
        EmployeeSummary,
        HeadcountReport,
        OrgUnit,
        Plant,
} from '../types/api'

export const plantA = { id: 1, code: 'TP-A', name: 'Test Plant A' }
export const plantB = { id: 2, code: 'TP-B', name: 'Test Plant B' }
export const quality = { id: 10, code: 'TQ', name: 'Test Quality' }
export const production = { id: 11, code: 'TPR', name: 'Test Production' }
const engineer = { id: 100, code: 'ENG', name: 'Engineer' }

export const plants: Plant[] = [
        { ...plantA, location: 'Northfield', is_active: true },
        { ...plantB, location: null, is_active: true },
]

/** Quality at A and B; Production only at A. */
export const units: OrgUnit[] = [
        { plant_department_id: 1000, plant: plantA, department: production, is_active: true },
        { plant_department_id: 1001, plant: plantA, department: quality, is_active: true },
        { plant_department_id: 1002, plant: plantB, department: quality, is_active: true },
]

export const adminUser: CurrentUser = {
        id: 1,
        username: 'test.admin',
        email: null,
        employee: null,
        roles: [
                {
                        code: 'ADMIN',
                        name: 'Administrator',
                        scopes: [{ scope_type: 'GLOBAL', plant: null, department: null }],
                },
        ],
        permissions: ['org:read'],
        csrf_token: 'csrf-admin-session',
}

export const employeeOnlyUser: CurrentUser = {
        id: 2,
        username: 'test.employee',
        email: null,
        employee: { id: 501, employee_code: 'T0001', full_name: 'Tess Person' },
        roles: [{ code: 'EMPLOYEE', name: 'Employee', scopes: [] }],
        permissions: ['self:read'],
        csrf_token: 'csrf-employee-session',
}

export function assignment(overrides: Partial<Assignment> = {}): Assignment {
        return {
                id: 1,
                plant_department_id: 1001,
                plant: plantA,
                department: quality,
                designation: engineer,
                reporting_manager: null,
                is_primary: true,
                effective_from: '2025-04-01',
                effective_to: null,
                is_current: true,
                ...overrides,
        }
}

/** One person, two plants: primary at A, supporting at B. */
export const crossPlantEmployee: EmployeeSummary = {
        id: 501,
        employee_code: 'T0001',
        full_name: 'Tess Person',
        email: null,
        is_active: true,
        has_primary_assignment: true,
        primary_assignment: assignment({ id: 1 }),
        matching_assignments: [
                assignment({ id: 1 }),
                assignment({ id: 2, plant_department_id: 1002, plant: plantB, is_primary: false }),
        ],
}

/** Primary assignment exists but is outside the caller's access. */
export const primaryElsewhereEmployee: EmployeeSummary = {
        id: 502,
        employee_code: 'T0002',
        full_name: 'Remy Support',
        email: null,
        is_active: true,
        has_primary_assignment: true,
        primary_assignment: null,
        matching_assignments: [
                assignment({ id: 3, plant_department_id: 1002, plant: plantB, is_primary: false }),
        ],
}

export const noPrimaryEmployee: EmployeeSummary = {
        id: 503,
        employee_code: 'T0003',
        full_name: 'Nadia Noprimary',
        email: null,
        is_active: true,
        has_primary_assignment: false,
        primary_assignment: null,
        matching_assignments: [assignment({ id: 4, is_primary: false })],
}

export function employeeList(
        items: EmployeeSummary[],
        overrides: Partial<EmployeeList> = {},
): EmployeeList {
        return {
                items,
                total: items.length,
                limit: 25,
                offset: 0,
                as_of: '2026-08-01',
                ...overrides,
        }
}

export function headcountReport(overrides: Partial<HeadcountReport> = {}): HeadcountReport {
        return {
                scope: {
                        plant_id: null,
                        department_id: quality.id,
                        label: 'Test Quality — All Plants',
                        access_limited: false,
                },
                as_of: '2026-08-01',
                headcount: 3,
                supporting_employees: 0,
                employees_without_primary: 0,
                by_unit: [
                        {
                                plant_department_id: 1001,
                                plant: plantA,
                                department: quality,
                                headcount: 2,
                                supporting: 0,
                        },
                        {
                                plant_department_id: 1002,
                                plant: plantB,
                                department: quality,
                                headcount: 1,
                                supporting: 1,
                        },
                ],
                ...overrides,
        }
}
