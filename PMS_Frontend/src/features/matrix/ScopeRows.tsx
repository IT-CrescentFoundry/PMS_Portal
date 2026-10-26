import { Plus, Trash2 } from 'lucide-react'
import { Button } from '../../components/common/Button'
import { SelectField } from '../../components/common/Fields'
import type { OrgUnit } from '../../types/api'
import { departmentsOf, plantsOf } from '../organization/orgUnits'
import { COMPANY_WIDE, type ScopeRow } from './scopes'

/** "Applies to" rows: a plant, a department, both, or neither (company-wide). */
export function ScopeRows({
        rows,
        units,
        onChange,
        disabled,
}: {
        rows: ScopeRow[]
        units: OrgUnit[]
        onChange: (rows: ScopeRow[]) => void
        disabled?: boolean
}) {
        const plants = plantsOf(units)
        const update = (index: number, patch: Partial<ScopeRow>) =>
                onChange(rows.map((row, i) => (i === index ? { ...row, ...patch } : row)))
        return (
                <div className="space-y-3">
                        {rows.map((row, index) => (
                                <div
                                        key={index}
                                        className="grid grid-cols-1 items-end gap-2 sm:grid-cols-[1fr_1fr_auto]"
                                >
                                        <SelectField
                                                label={`Plant (place ${index + 1})`}
                                                value={row.plantId}
                                                disabled={disabled}
                                                onChange={(e) =>
                                                        update(index, {
                                                                plantId: e.target.value,
                                                                departmentId: '',
                                                        })
                                                }
                                                options={[
                                                        { value: '', label: 'All plants' },
                                                        ...plants.map((p) => ({
                                                                value: String(p.id),
                                                                label: p.name,
                                                        })),
                                                ]}
                                        />
                                        <SelectField
                                                label={`Department (place ${index + 1})`}
                                                value={row.departmentId}
                                                disabled={disabled}
                                                onChange={(e) =>
                                                        update(index, {
                                                                departmentId: e.target.value,
                                                        })
                                                }
                                                options={[
                                                        { value: '', label: 'All departments' },
                                                        ...departmentsOf(
                                                                units,
                                                                row.plantId
                                                                        ? Number(row.plantId)
                                                                        : undefined,
                                                        ).map((d) => ({
                                                                value: String(d.id),
                                                                label: d.name,
                                                        })),
                                                ]}
                                        />
                                        <Button
                                                variant="ghost"
                                                aria-label={`Remove place ${index + 1}`}
                                                disabled={disabled}
                                                onClick={() =>
                                                        onChange(rows.filter((_, i) => i !== index))
                                                }
                                        >
                                                <Trash2 aria-hidden="true" className="size-4" />
                                        </Button>
                                </div>
                        ))}
                        <Button
                                size="sm"
                                disabled={disabled}
                                onClick={() => onChange([...rows, { ...COMPANY_WIDE }])}
                        >
                                <Plus aria-hidden="true" className="size-4" />
                                Add a place
                        </Button>
                </div>
        )
}
