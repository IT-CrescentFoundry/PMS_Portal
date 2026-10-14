import type { Assignment, DepartmentRef, PlantRef, RoleGrant, RoleScope } from '../types/api'

/** "Quality — Demo Plant A" */
export function unitLabel(department: DepartmentRef, plant: PlantRef): string {
        return `${department.name} — ${plant.name}`
}

/** Plain-language description of one access scope on a role grant. */
export function scopeLabel(scope: RoleScope): string {
        switch (scope.scope_type) {
                case 'GLOBAL':
                        return 'All plants and departments'
                case 'PLANT':
                        return `${scope.plant?.name ?? 'One plant'}: all departments`
                case 'DEPARTMENT':
                        return `${scope.department?.name ?? 'One department'}: all plants`
                case 'PLANT_DEPARTMENT':
                        return scope.plant && scope.department
                                ? unitLabel(scope.department, scope.plant)
                                : 'One department at one plant'
        }
}

/** Describes what a role grant covers, including grants without scope rows. */
export function grantCoverage(grant: RoleGrant): string[] {
        if (grant.scopes.length > 0) return grant.scopes.map(scopeLabel)
        return [
                grant.code === 'EMPLOYEE'
                        ? 'Own employee record'
                        : 'No organizational scope assigned',
        ]
}

export type AssignmentTiming = 'current' | 'upcoming' | 'ended'

/** Timing relative to the response's as_of date (uses the server's is_current). */
export function assignmentTiming(assignment: Assignment, asOf: string): AssignmentTiming {
        if (assignment.is_current) return 'current'
        return assignment.effective_from > asOf ? 'upcoming' : 'ended'
}

/** "Primary" or "Supporting": wording used consistently across the UI. */
export function assignmentType(assignment: Assignment): 'Primary' | 'Supporting' {
        return assignment.is_primary ? 'Primary' : 'Supporting'
}
