import type { DepartmentRef, OrgUnit, PlantRef } from '../../types/api'

const byName = (a: { name: string }, b: { name: string }) => a.name.localeCompare(b.name)

/** Distinct plants among the units, sorted by name. */
export function plantsOf(units: OrgUnit[]): PlantRef[] {
        const map = new Map<number, PlantRef>()
        for (const unit of units) map.set(unit.plant.id, unit.plant)
        return [...map.values()].sort(byName)
}

/** Distinct departments among the units (optionally at one plant), sorted by name. */
export function departmentsOf(units: OrgUnit[], plantId?: number): DepartmentRef[] {
        const map = new Map<number, DepartmentRef>()
        for (const unit of units) {
                if (plantId === undefined || unit.plant.id === plantId) map.set(unit.department.id, unit.department)
        }
        return [...map.values()].sort(byName)
}

/** Units grouped by plant id or department id. */
export function groupUnits(units: OrgUnit[], by: 'plant' | 'department'): Map<number, OrgUnit[]> {
        const groups = new Map<number, OrgUnit[]>()
        for (const unit of units) {
                const id = by === 'plant' ? unit.plant.id : unit.department.id
                groups.set(id, [...(groups.get(id) ?? []), unit])
        }
        return groups
}

/** Whether a department exists at a plant within the caller's units. */
export function unitExists(units: OrgUnit[], plantId: number, departmentId: number): boolean {
        return units.some((u) => u.plant.id === plantId && u.department.id === departmentId)
}
