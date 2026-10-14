/**
 * Response types mirroring the backend's Pydantic schemas (see
 * docs/api.md and GET /openapi.json). Dates are ISO strings ("2026-08-01").
 */

export interface PlantRef {
        id: number
        code: string
        name: string
}

export interface DepartmentRef {
        id: number
        code: string
        name: string
}

export interface DesignationRef {
        id: number
        code: string
        name: string
}

export interface EmployeeRef {
        id: number
        employee_code: string
        full_name: string
}

export interface Plant extends PlantRef {
        location: string | null
        is_active: boolean
}

export interface Department extends DepartmentRef {
        description: string | null
        is_active: boolean
}

/** A department at one plant (plant_departments row), e.g. Quality — Plant A. */
export interface OrgUnit {
        plant_department_id: number
        plant: PlantRef
        department: DepartmentRef
        is_active: boolean
}

export interface PlantDetail extends Plant {
        units: OrgUnit[]
}

export interface DepartmentDetail extends Department {
        units: OrgUnit[]
}

export interface Assignment {
        id: number
        plant_department_id: number
        plant: PlantRef
        department: DepartmentRef
        designation: DesignationRef
        reporting_manager: EmployeeRef | null
        is_primary: boolean
        effective_from: string
        effective_to: string | null
        /** Relative to the response's as_of date. */
        is_current: boolean
}

export interface EmployeeSummary {
        id: number
        employee_code: string
        full_name: string
        email: string | null
        is_active: boolean
        /** A current primary assignment exists, possibly outside the caller's access. */
        has_primary_assignment: boolean
        /** Null when there is none OR it is outside the caller's access. */
        primary_assignment: Assignment | null
        /** Current assignments inside the filter and the caller's access. */
        matching_assignments: Assignment[]
}

export interface EmployeeList {
        items: EmployeeSummary[]
        total: number
        limit: number
        offset: number
        as_of: string
}

export interface EmployeeDetail {
        id: number
        employee_code: string
        full_name: string
        email: string | null
        date_of_joining: string | null
        date_of_exit: string | null
        is_active: boolean
        as_of: string
        has_primary_assignment: boolean
        current_assignments: Assignment[]
        assignment_history: Assignment[]
}

export interface ReportScope {
        plant_id: number | null
        department_id: number | null
        label: string
        /** The caller's access covers only part of the requested scope. */
        access_limited: boolean
}

export interface UnitHeadcount {
        plant_department_id: number
        plant: PlantRef
        department: DepartmentRef
        headcount: number
        supporting: number
}

export interface HeadcountReport {
        scope: ReportScope
        as_of: string
        /** Unique employees, each counted once at their primary assignment. */
        headcount: number
        supporting_employees: number
        employees_without_primary: number
        by_unit: UnitHeadcount[]
}

export type ScopeType = 'GLOBAL' | 'PLANT' | 'DEPARTMENT' | 'PLANT_DEPARTMENT'

export interface RoleScope {
        scope_type: ScopeType
        plant: PlantRef | null
        department: DepartmentRef | null
}

export interface RoleGrant {
        code: string
        name: string
        scopes: RoleScope[]
}

export interface CurrentUser {
        id: number
        username: string
        email: string | null
        employee: EmployeeRef | null
        roles: RoleGrant[]
        /** e.g. "org:read", "self:read" */
        permissions: string[]
        /** CSRF token bound to the session cookie; held in memory only. */
        csrf_token: string | null
}

export interface LoginResponse {
        user: CurrentUser
        expires_at: string
}
