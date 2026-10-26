import { Plus, Trash2 } from 'lucide-react'
import { useState } from 'react'
import { Button } from '../../components/common/Button'
import {
        CheckboxField,
        SelectField,
        TextAreaField,
        TextField,
} from '../../components/common/Fields'
import { cardClasses } from '../../components/common/styles'
import type { MatrixAggregation, MatrixDataType, MatrixTypeMeta } from '../../types/api'
import {
        customField,
        fieldDraft,
        fieldName,
        inputsOf,
        outputsOf,
        RANGE_TYPES,
        removeField,
        ROUNDABLE_TYPES,
        suggestedKey,
        type FieldDraft,
        type MatrixDraftState,
} from './matrixDraft'
import { DATA_TYPE_LABELS, MATRIX_AGGREGATION_LABELS } from './matrixLabels'

interface EditorProps {
        meta: MatrixTypeMeta
        state: MatrixDraftState
        onChange: (next: MatrixDraftState) => void
        disabled?: boolean
}

/**
 * Inputs and outputs of the version. Standard fields come from the type's
 * metadata; custom fields are limited to the data types and value source the
 * type allows. Adding a field here adds it to every rule, test case, preview,
 * generated template and import automatically: there is no other field list.
 */
export function FieldsEditor({ meta, state, onChange, disabled }: EditorProps) {
        const [standardKey, setStandardKey] = useState('')
        const inputs = inputsOf(state)
        const outputs = outputsOf(state)
        const unusedInputs = meta.standard_inputs.filter(
                (s) => !inputs.some((f) => f.key === s.key),
        )
        const missingOutputs = meta.outputs.filter((s) => !outputs.some((f) => f.key === s.key))
        const inputsFull = inputs.length >= meta.max_inputs
        const outputsFull = outputs.length >= meta.max_outputs

        const update = (uid: string, patch: Partial<FieldDraft>) =>
                onChange({
                        ...state,
                        fields: state.fields.map((f) => (f.uid === uid ? { ...f, ...patch } : f)),
                })
        const add = (field: FieldDraft) => onChange({ ...state, fields: [...state.fields, field] })

        function addStandard() {
                const standard = meta.standard_inputs.find((s) => s.key === standardKey)
                if (!standard) return
                add(fieldDraft(standard, true))
                setStandardKey('')
        }

        const card = (field: FieldDraft, index: number) => (
                <FieldCard
                        key={field.uid}
                        meta={meta}
                        field={field}
                        index={index}
                        disabled={disabled}
                        onChange={(patch) => update(field.uid, patch)}
                        onRemove={() => onChange(removeField(state, field.uid))}
                />
        )

        return (
                <div className="space-y-6">
                        <div className="space-y-3">
                                <h3 className="text-base font-semibold text-slate-900">Inputs</h3>
                                <p className="text-sm text-slate-700">
                                        What the rules look at (at most {meta.max_inputs}).
                                        {meta.allow_custom_inputs &&
                                                ` Custom inputs come from: ${meta.source_labels[meta.custom_input_source]}.`}
                                </p>
                                {inputs.map(card)}
                                <div className="flex flex-wrap items-end gap-2">
                                        {unusedInputs.length > 0 && (
                                                <>
                                                        <div className="w-72">
                                                                <SelectField
                                                                        label="Standard input"
                                                                        value={standardKey}
                                                                        disabled={
                                                                                disabled ||
                                                                                inputsFull
                                                                        }
                                                                        onChange={(e) =>
                                                                                setStandardKey(
                                                                                        e.target
                                                                                                .value,
                                                                                )
                                                                        }
                                                                        options={[
                                                                                {
                                                                                        value: '',
                                                                                        label: 'Choose…',
                                                                                },
                                                                                ...unusedInputs.map(
                                                                                        (s) => ({
                                                                                                value: s.key,
                                                                                                label: `${s.label} (${s.source_label ?? s.data_type_label})`,
                                                                                        }),
                                                                                ),
                                                                        ]}
                                                                />
                                                        </div>
                                                        <Button
                                                                disabled={
                                                                        disabled ||
                                                                        inputsFull ||
                                                                        !standardKey
                                                                }
                                                                onClick={addStandard}
                                                        >
                                                                <Plus
                                                                        aria-hidden="true"
                                                                        className="size-4"
                                                                />
                                                                Add standard input
                                                        </Button>
                                                </>
                                        )}
                                        {meta.allow_custom_inputs && (
                                                <Button
                                                        disabled={disabled || inputsFull}
                                                        onClick={() =>
                                                                add(customField(meta, 'input'))
                                                        }
                                                >
                                                        <Plus
                                                                aria-hidden="true"
                                                                className="size-4"
                                                        />
                                                        Add a custom input
                                                </Button>
                                        )}
                                </div>
                        </div>

                        <div className="space-y-3">
                                <h3 className="text-base font-semibold text-slate-900">Outputs</h3>
                                <p className="text-sm text-slate-700">
                                        What each rule gives
                                        {meta.outputs.length > 0 &&
                                                `; this type always gives ${meta.outputs.map((o) => o.label).join(', ')}`}
                                        .
                                </p>
                                {outputs.map(card)}
                                <div className="flex flex-wrap gap-2">
                                        {missingOutputs.map((o) => (
                                                <Button
                                                        key={o.key}
                                                        disabled={disabled}
                                                        onClick={() => add(fieldDraft(o, true))}
                                                >
                                                        <Plus
                                                                aria-hidden="true"
                                                                className="size-4"
                                                        />
                                                        Add “{o.label}”
                                                </Button>
                                        ))}
                                        {meta.allow_custom_outputs && (
                                                <Button
                                                        disabled={disabled || outputsFull}
                                                        onClick={() =>
                                                                add(customField(meta, 'output'))
                                                        }
                                                >
                                                        <Plus
                                                                aria-hidden="true"
                                                                className="size-4"
                                                        />
                                                        Add a custom output
                                                </Button>
                                        )}
                                </div>
                        </div>
                </div>
        )
}

function FieldCard({
        meta,
        field,
        index,
        disabled,
        onChange,
        onRemove,
}: {
        meta: MatrixTypeMeta
        field: FieldDraft
        index: number
        disabled?: boolean
        onChange: (patch: Partial<FieldDraft>) => void
        onRemove: () => void
}) {
        const input = field.role === 'input'
        const types: MatrixDataType[] = field.standard
                ? [field.dataType]
                : input
                  ? meta.custom_input_types
                  : meta.custom_output_types
        const aggregations: MatrixAggregation[] = meta.aggregations[field.dataType] ?? []
        const mandatory = field.standard && !input
        const name = fieldName(field)
        const dates = field.dataType === 'DATE'

        function changeLabel(label: string) {
                const followsLabel = !field.standard && field.key === suggestedKey(field.label)
                onChange(followsLabel ? { label, key: suggestedKey(label) } : { label })
        }

        function changeType(dataType: MatrixDataType) {
                const allowed = meta.aggregations[dataType] ?? []
                onChange({
                        dataType,
                        aggregation:
                                field.aggregation && allowed.includes(field.aggregation)
                                        ? field.aggregation
                                        : '',
                })
        }

        return (
                <fieldset
                        disabled={disabled}
                        className={`${cardClasses} grid grid-cols-1 gap-3 p-4 sm:grid-cols-2 lg:grid-cols-4`}
                >
                        <legend className="px-1 text-sm font-semibold text-slate-900">
                                {input ? 'Input' : 'Output'} {index + 1}: {name}
                                {field.standard && ' (standard)'}
                        </legend>
                        <TextField
                                label="Label"
                                maxLength={100}
                                value={field.label}
                                onChange={(e) => changeLabel(e.target.value)}
                        />
                        <TextField
                                label="Key"
                                hint={
                                        field.standard
                                                ? 'Fixed for a standard field.'
                                                : 'a–z, 0–9 and _'
                                }
                                maxLength={40}
                                value={field.key}
                                disabled={field.standard}
                                onChange={(e) => onChange({ key: e.target.value })}
                        />
                        <SelectField
                                label="Data type"
                                value={field.dataType}
                                disabled={field.standard}
                                onChange={(e) => changeType(e.target.value as MatrixDataType)}
                                options={types.map((t) => ({
                                        value: t,
                                        label: meta.data_type_labels[t] ?? DATA_TYPE_LABELS[t],
                                }))}
                        />
                        <TextField
                                label="Unit (optional)"
                                maxLength={20}
                                value={field.unit}
                                onChange={(e) => onChange({ unit: e.target.value })}
                        />
                        {RANGE_TYPES.includes(field.dataType) && (
                                <>
                                        <TextField
                                                label="Lowest allowed value (optional)"
                                                type={dates ? 'date' : 'text'}
                                                inputMode={dates ? undefined : 'decimal'}
                                                value={field.min}
                                                onChange={(e) => onChange({ min: e.target.value })}
                                        />
                                        <TextField
                                                label="Highest allowed value (optional)"
                                                type={dates ? 'date' : 'text'}
                                                inputMode={dates ? undefined : 'decimal'}
                                                value={field.max}
                                                onChange={(e) => onChange({ max: e.target.value })}
                                        />
                                </>
                        )}
                        {ROUNDABLE_TYPES.includes(field.dataType) && input && (
                                <TextField
                                        label="Round to decimals (optional)"
                                        hint="0–6 places, half-up, before matching."
                                        inputMode="numeric"
                                        value={field.roundTo}
                                        onChange={(e) => onChange({ roundTo: e.target.value })}
                                />
                        )}
                        {input && field.source === 'IMPORTED' && (
                                <SelectField
                                        label="Monthly values combine by"
                                        value={field.aggregation}
                                        onChange={(e) =>
                                                onChange({
                                                        aggregation: e.target.value as
                                                                MatrixAggregation | '',
                                                })
                                        }
                                        options={[
                                                { value: '', label: 'Choose…' },
                                                ...aggregations.map((a) => ({
                                                        value: a,
                                                        label: MATRIX_AGGREGATION_LABELS[a],
                                                })),
                                        ]}
                                />
                        )}
                        {field.dataType === 'CATEGORY' && (
                                <div className="sm:col-span-2">
                                        <TextAreaField
                                                label="Allowed values (one per line)"
                                                value={field.allowedValues}
                                                onChange={(e) =>
                                                        onChange({ allowedValues: e.target.value })
                                                }
                                        />
                                </div>
                        )}
                        <div className="sm:col-span-2">
                                <TextField
                                        label="Description (optional)"
                                        maxLength={500}
                                        value={field.description}
                                        onChange={(e) => onChange({ description: e.target.value })}
                                />
                        </div>
                        {input && (
                                <p className="text-sm text-slate-700 sm:col-span-2">
                                        <span className="font-medium">Value comes from:</span>{' '}
                                        {field.source
                                                ? meta.source_labels[field.source]
                                                : 'Not set'}
                                </p>
                        )}
                        <div className="flex flex-wrap items-center gap-4 sm:col-span-2 lg:col-span-4">
                                {input && (
                                        <CheckboxField
                                                label="Required (no result without it)"
                                                checked={field.required}
                                                onChange={(e) =>
                                                        onChange({ required: e.target.checked })
                                                }
                                        />
                                )}
                                {!mandatory && (
                                        <Button variant="ghost" size="sm" onClick={onRemove}>
                                                <Trash2 aria-hidden="true" className="size-4" />
                                                Remove {name}
                                        </Button>
                                )}
                        </div>
                </fieldset>
        )
}
