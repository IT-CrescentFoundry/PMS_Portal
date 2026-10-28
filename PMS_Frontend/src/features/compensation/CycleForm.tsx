import { useState, type FormEvent } from 'react'
import { ActionError } from '../../components/common/ActionError'
import { Button } from '../../components/common/Button'
import { SelectField, TextAreaField, TextField } from '../../components/common/Fields'
import { cardClasses } from '../../components/common/styles'
import { useAction } from '../../hooks/useAction'
import { useApiQuery } from '../../hooks/useApiQuery'
import { listAnnualCycles } from '../../services/annualApi'
import type {
        CompaRatioMethod,
        CompensationCycle,
        CompensationCycleDetail,
        CompensationCycleWrite,
} from '../../types/api'
import { CR_METHOD } from './compensationLabels'

/** Create or change a compensation cycle's configuration (HR Head). */
export function CycleForm({
        initial,
        submitLabel,
        onSubmit,
        onSaved,
        onCancel,
}: {
        initial?: CompensationCycle
        submitLabel: string
        onSubmit: (body: CompensationCycleWrite) => Promise<CompensationCycleDetail>
        onSaved: (cycle: CompensationCycleDetail) => void
        onCancel: () => void
}) {
        const pmsCycles = useApiQuery('annual-cycles', (signal) => listAnnualCycles(signal))
        const [form, setForm] = useState({
                code: initial?.code ?? '',
                name: initial?.name ?? '',
                pmsCycleId: initial ? String(initial.pms_cycle.id) : '',
                currency: initial?.currency ?? 'INR',
                effectiveDate: initial?.effective_date ?? '',
                crMethod: (initial?.cr_method ?? '') as CompaRatioMethod | '',
                referenceLabel: initial?.reference_label ?? '',
                notes: initial?.notes ?? '',
        })
        const [touched, setTouched] = useState(false)
        const action = useAction()
        const errors = {
                code: form.code.trim() ? undefined : 'Give the cycle a code.',
                name: form.name.trim() ? undefined : 'Give the cycle a name.',
                pmsCycleId: form.pmsCycleId ? undefined : 'Choose the PMS cycle.',
                currency: /^[A-Z]{3}$/.test(form.currency)
                        ? undefined
                        : 'Three capital letters, e.g. INR.',
                effectiveDate: form.effectiveDate ? undefined : 'Choose the date.',
                crMethod: form.crMethod ? undefined : 'Choose how compa-ratio affects increments.',
                referenceLabel: form.referenceLabel.trim()
                        ? undefined
                        : 'Name the reference salary.',
        }
        const set = (key: keyof typeof form) => (value: string) =>
                setForm({ ...form, [key]: value })

        async function handleSubmit(event: FormEvent) {
                event.preventDefault()
                setTouched(true)
                if (Object.values(errors).some(Boolean)) return
                const saved = await action.run(() =>
                        onSubmit({
                                code: form.code.trim(),
                                name: form.name.trim(),
                                pms_cycle_id: Number(form.pmsCycleId),
                                currency: form.currency,
                                effective_date: form.effectiveDate,
                                cr_method: form.crMethod as CompaRatioMethod,
                                reference_label: form.referenceLabel.trim(),
                                notes: form.notes.trim() || null,
                        }),
                )
                if (saved) onSaved(saved)
        }

        const show = (key: keyof typeof errors) => (touched ? errors[key] : undefined)
        return (
                <form
                        noValidate
                        onSubmit={handleSubmit}
                        aria-label="Compensation cycle"
                        className={`${cardClasses} space-y-3 p-4`}
                >
                        <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
                                <TextField
                                        label="Code"
                                        maxLength={20}
                                        disabled={initial !== undefined}
                                        value={form.code}
                                        error={show('code')}
                                        onChange={(e) => set('code')(e.target.value)}
                                />
                                <TextField
                                        label="Name"
                                        maxLength={100}
                                        value={form.name}
                                        error={show('name')}
                                        onChange={(e) => set('name')(e.target.value)}
                                />
                                <SelectField
                                        label="Annual results from (PMS cycle)"
                                        value={form.pmsCycleId}
                                        error={show('pmsCycleId')}
                                        onChange={(e) => set('pmsCycleId')(e.target.value)}
                                        options={[
                                                {
                                                        value: '',
                                                        label: pmsCycles.data
                                                                ? 'Choose…'
                                                                : 'Loading…',
                                                },
                                                ...(pmsCycles.data ?? []).map((c) => ({
                                                        value: String(c.id),
                                                        label: c.name,
                                                })),
                                        ]}
                                />
                                <TextField
                                        label="Effective date"
                                        type="date"
                                        hint="Matrix versions in force on this date are used."
                                        value={form.effectiveDate}
                                        error={show('effectiveDate')}
                                        onChange={(e) => set('effectiveDate')(e.target.value)}
                                />
                                <TextField
                                        label="Currency"
                                        maxLength={3}
                                        value={form.currency}
                                        error={show('currency')}
                                        onChange={(e) =>
                                                set('currency')(e.target.value.toUpperCase())
                                        }
                                />
                                <TextField
                                        label="Compa-ratio reference"
                                        hint="What the compa-ratio divides by, e.g. salary-range midpoint."
                                        maxLength={60}
                                        value={form.referenceLabel}
                                        error={show('referenceLabel')}
                                        onChange={(e) => set('referenceLabel')(e.target.value)}
                                />
                                <SelectField
                                        label="How compa-ratio affects the increment"
                                        value={form.crMethod}
                                        error={show('crMethod')}
                                        onChange={(e) => set('crMethod')(e.target.value)}
                                        options={[
                                                { value: '', label: 'Choose…' },
                                                ...(
                                                        Object.keys(CR_METHOD) as CompaRatioMethod[]
                                                ).map((m) => ({
                                                        value: m,
                                                        label: CR_METHOD[m].label,
                                                })),
                                        ]}
                                />
                        </div>
                        <TextAreaField
                                label="Notes (optional)"
                                maxLength={1000}
                                value={form.notes}
                                onChange={(e) => set('notes')(e.target.value)}
                        />
                        <ActionError error={action.error} title="The cycle was not saved" />
                        <div className="flex flex-wrap gap-2">
                                <Button type="submit" variant="primary" isLoading={action.busy}>
                                        {submitLabel}
                                </Button>
                                <Button variant="ghost" disabled={action.busy} onClick={onCancel}>
                                        Cancel
                                </Button>
                        </div>
                </form>
        )
}
