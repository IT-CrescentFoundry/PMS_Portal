/**
 * UI-only permission checks, used to decide what to SHOW. They are not a
 * security boundary: the API enforces roles and scopes on every request and
 * remains the final authority.
 */
import type { CurrentUser } from '../../types/api'

export const PERMISSION_ORG_READ = 'org:read'
export const PERMISSION_SELF_READ = 'self:read'

/** May view plants, departments, employees and headcount (within scopes). */
export function canReadOrganization(user: CurrentUser): boolean {
        return user.permissions.includes(PERMISSION_ORG_READ)
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
