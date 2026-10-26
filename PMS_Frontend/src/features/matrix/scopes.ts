import type { MatrixScope, MatrixScopeInput } from '../../types/api'

export interface ScopeRow {
        plantId: string
        departmentId: string
}

export const COMPANY_WIDE: ScopeRow = { plantId: '', departmentId: '' }

export function scopeRowsFrom(scopes: MatrixScope[]): ScopeRow[] {
        return scopes.map((s) => ({
                plantId: s.plant ? String(s.plant.id) : '',
                departmentId: s.department ? String(s.department.id) : '',
        }))
}

export function scopeInputs(rows: ScopeRow[]): MatrixScopeInput[] {
        return rows.map((r) => ({
                plant_id: r.plantId ? Number(r.plantId) : null,
                department_id: r.departmentId ? Number(r.departmentId) : null,
        }))
}
