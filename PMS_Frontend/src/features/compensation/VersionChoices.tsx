import { SelectField } from '../../components/common/Fields'
import { useApiQuery } from '../../hooks/useApiQuery'
import { listMatrices } from '../../services/matrixApi'
import type { CompaRatioMethod } from '../../types/api'
import { MATRIX_TYPE_LABELS } from './compensationLabels'

const TYPES = ['KRA_PERFORMANCE', 'INCREMENT', 'CR_IMPACT'] as const

/** Per matrix type, the approved version in force or an explicit version to analyse. */
export function VersionChoices({
        method,
        value,
        onChange,
}: {
        method: CompaRatioMethod
        value: Record<string, string>
        onChange: (value: Record<string, string>) => void
}) {
        const types = TYPES.filter((t) => t !== 'CR_IMPACT' || method === 'IMPACT_MULTIPLIER')
        return (
                <div className="grid grid-cols-1 gap-3 md:grid-cols-3">
                        {types.map((t) => (
                                <VersionChoice
                                        key={t}
                                        type={t}
                                        value={value[t] ?? ''}
                                        onChange={(v) => onChange({ ...value, [t]: v })}
                                />
                        ))}
                </div>
        )
}

function VersionChoice({
        type,
        value,
        onChange,
}: {
        type: string
        value: string
        onChange: (v: string) => void
}) {
        const matrices = useApiQuery(`matrices|${type}`, (signal) =>
                listMatrices({ matrixType: type }, signal),
        )
        const options = new Map<number, string>()
        for (const m of matrices.data ?? []) {
                for (const v of [m.in_force, m.open_version, m.latest_version]) {
                        if (v)
                                options.set(
                                        v.id,
                                        `${m.code} v${v.version_no} (${v.status.toLowerCase()})`,
                                )
                }
        }
        return (
                <SelectField
                        label={MATRIX_TYPE_LABELS[type]}
                        value={value}
                        onChange={(e) => onChange(e.target.value)}
                        options={[
                                { value: '', label: 'The approved version in force' },
                                ...[...options].map(([id, label]) => ({
                                        value: String(id),
                                        label,
                                })),
                        ]}
                />
        )
}
