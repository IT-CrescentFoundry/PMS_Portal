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
export const PERMISSION_MATRIX_READ = 'matrix:read'
export const PERMISSION_MATRIX_WRITE = 'matrix:write'
export const PERMISSION_MATRIX_APPROVE = 'matrix:approve'
export const PERMISSION_SCORE_PUBLISH = 'score:publish'
export const PERMISSION_ANNUAL_READ = 'annual:read'
export const PERMISSION_ANNUAL_DEVIATION_REQUEST = 'annual:deviation_request'
export const PERMISSION_ANNUAL_APPROVE = 'annual:approve'
export const PERMISSION_CORRECTION_REQUEST = 'quarter:correction_request'
export const PERMISSION_CORRECTION_APPROVE = 'quarter:correction_approve'
export const PERMISSION_COMPENSATION_READ = 'compensation:read'
export const PERMISSION_COMPENSATION_MANAGE = 'compensation:manage'
export const PERMISSION_BUDGET_READ = 'budget:read'
export const PERMISSION_BUDGET_RECORD = 'budget:record'
export const PERMISSION_BUDGET_APPROVE = 'budget:approve'

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

/** May view configurable matrices (compensation types need more; the API decides). */
export function canReadMatrices(user: CurrentUser): boolean {
        return has(user, PERMISSION_MATRIX_READ)
}

/** HR Head: author matrix versions in the portal or by Excel upload. */
export function canWriteMatrices(user: CurrentUser): boolean {
        return has(user, PERMISSION_MATRIX_WRITE)
}

/** CHRO: approve or reject submitted matrix versions. */
export function canApproveMatrices(user: CurrentUser): boolean {
        return has(user, PERMISSION_MATRIX_APPROVE)
}

/** HR Head / CHRO: publish reviewed quarterly scores (final). */
export function canPublishScores(user: CurrentUser): boolean {
        return has(user, PERMISSION_SCORE_PUBLISH)
}

/** HR, HR Head, Admin, CHRO: annual results, deviations and history (within scope). */
export function canReadAnnual(user: CurrentUser): boolean {
        return has(user, PERMISSION_ANNUAL_READ)
}

/** Takes part in corrections of published quarters: requests (HR Head), decides
 * (CHRO), or moves and publishes them (company-wide HR authority). */
export function canWorkOnCorrections(user: CurrentUser): boolean {
        return [
                PERMISSION_CORRECTION_REQUEST,
                PERMISSION_CORRECTION_APPROVE,
                PERMISSION_QUARTER_START,
                PERMISSION_SCORE_PUBLISH,
        ].some((p) => has(user, p))
}

/** Budget totals, scenarios and decisions (no employee-level amounts by itself). */
export function canReadBudget(user: CurrentUser): boolean {
        return has(user, PERMISSION_BUDGET_READ)
}

/** HR Head: compensation cycles, salary baselines, scenarios. */
export function canManageCompensation(user: CurrentUser): boolean {
        return has(user, PERMISSION_COMPENSATION_MANAGE)
}

/** Employee-level compensation (salaries, proposals and their explanations). */
export function canReadCompensation(user: CurrentUser): boolean {
        return has(user, PERMISSION_COMPENSATION_READ)
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
