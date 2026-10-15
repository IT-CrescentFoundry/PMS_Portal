/**
 * UI-only permission checks, used to decide what to SHOW. They are not a
 * security boundary: the API enforces roles and scopes on every request and
 * remains the final authority.
 */
import type { CurrentUser } from '../../types/api'

export const PERMISSION_ORG_READ = 'org:read'
export const PERMISSION_SELF_READ = 'self:read'
export const PERMISSION_JD_WRITE = 'jd:write'
export const PERMISSION_JD_AUTHORISE = 'jd:authorise'
export const PERMISSION_JD_APPROVE = 'jd:approve'
export const PERMISSION_KPI_WRITE = 'kpi:write'
export const PERMISSION_QUARTER_START = 'quarter:start'
export const PERMISSION_DEVIATION_HR = 'deviation:approve_hr'
export const PERMISSION_DEVIATION_PLANT = 'deviation:approve_plant'

/** Roles that may fill HR-only JD fields (available budget). Mirrors the API. */
const HR_ROLE_CODES = new Set(['HR', 'HR_HEAD', 'CHRO', 'ADMIN'])

function has(user: CurrentUser, permission: string): boolean {
        return user.permissions.includes(permission)
}

/** May view plants, departments, employees and headcount (within scopes). */
export function canReadOrganization(user: CurrentUser): boolean {
        return has(user, PERMISSION_ORG_READ)
}

/** May draft and propose JDs (Proposed by HOD), within scope. */
export function canWriteJD(user: CurrentUser): boolean {
        return has(user, PERMISSION_JD_WRITE)
}

/** Plant Head sign-off ("Authorised by"). */
export function canAuthoriseJD(user: CurrentUser): boolean {
        return has(user, PERMISSION_JD_AUTHORISE)
}

/** COO/CHRO sign-off ("Approved by"). */
export function canApproveJD(user: CurrentUser): boolean {
        return has(user, PERMISSION_JD_APPROVE)
}

export function isHrUser(user: CurrentUser): boolean {
        return user.roles.some((role) => HR_ROLE_CODES.has(role.code))
}

/** May maintain the KPI library and employees' quarterly KPI sheets, within scope. */
export function canWriteKpi(user: CurrentUser): boolean {
        return has(user, PERMISSION_KPI_WRITE)
}

/** May start quarterly scoring (needs company-wide scope; the API checks). */
export function canStartScoring(user: CurrentUser): boolean {
        return has(user, PERMISSION_QUARTER_START)
}

export function canApproveDeviationAsHR(user: CurrentUser): boolean {
        return has(user, PERMISSION_DEVIATION_HR)
}

export function canApproveDeviationAsPlant(user: CurrentUser): boolean {
        return has(user, PERMISSION_DEVIATION_PLANT)
}

/** May open their own employee record. */
export function canReadOwnRecord(user: CurrentUser): boolean {
        return user.employee !== null && user.permissions.includes(PERMISSION_SELF_READ)
}

export function displayName(user: CurrentUser): string {
        return user.employee?.full_name ?? user.username
}

/** Role names joined for compact display, e.g. "Department Head, Employee". */
export function roleSummary(user: CurrentUser): string {
        return user.roles.map((role) => role.name).join(', ') || 'No role assigned'
}

/** Return-path after login: only same-app absolute paths are accepted. */
export function safeReturnPath(value: unknown): string {
        if (typeof value !== 'string') return '/'
        if (!value.startsWith('/') || value.startsWith('//') || value.startsWith('/\\')) return '/'
        if (value === '/login' || value.startsWith('/login?')) return '/'
        return value
}
