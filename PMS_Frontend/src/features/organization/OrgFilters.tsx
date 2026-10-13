import { SelectField } from '../../components/common/Fields'
import type { OrgUnit } from '../../types/api'
import { departmentsOf, plantsOf } from './orgUnits'

interface OrgFiltersProps {
        units: OrgUnit[]
        plantId: number | undefined
        departmentId: number | undefined
        onChange: (next: { plantId: number | undefined; departmentId: number | undefined }) => void
        disabled?: boolean
}

/**
 * Plant + department selectors built from the caller's accessible units.
 * Choosing a plant limits departments to those that exist at that plant, and
 * clears a department selection that is not available there.
 */
export function OrgFilters({ units, plantId, departmentId, onChange, disabled }: OrgFiltersProps) {
        const plants = plantsOf(units)
        const departments = departmentsOf(units, plantId)

        return (
                <>
                        <SelectField
                                label="Plant"
                                value={plantId === undefined ? '' : String(plantId)}
                                disabled={disabled}
                                onChange={(event) => {
                                        const nextPlant = event.target.value ? Number(event.target.value) : undefined
                                        const stillAvailable =
                                                departmentId === undefined ||
                                                departmentsOf(units, nextPlant).some((d) => d.id === departmentId)
                                        onChange({ plantId: nextPlant, departmentId: stillAvailable ? departmentId : undefined })
                                }}
                                options={[
                                        { value: '', label: 'All accessible plants' },
                                        ...plants.map((p) => ({ value: String(p.id), label: p.name })),
                                ]}
                        />
                        <SelectField
                                label="Department"
                                value={departmentId === undefined ? '' : String(departmentId)}
                                disabled={disabled}
                                onChange={(event) =>
                                        onChange({
                                                plantId,
                                                departmentId: event.target.value ? Number(event.target.value) : undefined,
                                        })
                                }
                                options={[
                                        { value: '', label: 'All departments' },
                                        ...departments.map((d) => ({ value: String(d.id), label: d.name })),
                                ]}
                        />
                </>
        )
}
