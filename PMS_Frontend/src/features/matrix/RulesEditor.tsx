import { Copy, Plus, Trash2 } from 'lucide-react'
import { Alert } from '../../components/common/Alert'
import { Button } from '../../components/common/Button'
import { CheckboxField, SelectField, TextField } from '../../components/common/Fields'
import { cardClasses } from '../../components/common/styles'
import type { MatrixTypeMeta } from '../../types/api'
import { CompactInput, CompactSelect, ValueInput } from './controls'
import {
        allowedValuesOf,
        conditionKind,
        emptyCondition,
        fieldName,
        inputsOf,
        newRule,
        outputsOf,
        uid,
        type ConditionDraft,
        type FieldDraft,
        type MatrixDraftState,
        type RangeDraft,
        type RuleDraft,
} from './matrixDraft'

interface EditorProps {
        meta: MatrixTypeMeta
        state: MatrixDraftState
        onChange: (next: MatrixDraftState) => void
        disabled?: boolean
}

const valueField = (field: FieldDraft) => ({
        dataType: field.dataType,
        allowed: allowedValuesOf(field),
})

/** One labelled value control per output field. */
export function OutputValues({
        fields,
        values,
        context,
        onChange,
}: {
        fields: FieldDraft[]
        values: Record<string, string>
        context: string
        onChange: (values: Record<string, string>) => void
}) {
        return (
                <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
                        {fields.map((field) => (
                                <label key={field.uid} className="block space-y-1 text-sm">
                                        <span className="font-medium text-slate-800">
                                                {fieldName(field)}
                                                {field.unit && ` (${field.unit})`}
                                        </span>
                                        <ValueInput
                                                field={valueField(field)}
                                                label={`${fieldName(field)}, ${context}`}
                                                value={values[field.uid] ?? ''}
                                                onChange={(value) =>
                                                        onChange({ ...values, [field.uid]: value })
                                                }
                                        />
                                </label>
                        ))}
                </div>
        )
}

/**
 * The decision table. Rules may not overlap (the API rejects overlaps, and an
 * ambiguous match is an error, never a choice), and every bound states
 * whether the boundary value itself is included.
 */
export function RulesEditor({ meta, state, onChange, disabled }: EditorProps) {
        const inputs = inputsOf(state)
        const outputs = outputsOf(state)

        const updateRule = (ruleUid: string, patch: Partial<RuleDraft>) =>
                onChange({
                        ...state,
                        rules: state.rules.map((r) => (r.uid === ruleUid ? { ...r, ...patch } : r)),
                })

        function setCondition(rule: RuleDraft, fieldUid: string, next: ConditionDraft | undefined) {
                const conditions = { ...rule.conditions }
                if (next === undefined) delete conditions[fieldUid]
                else conditions[fieldUid] = next
                updateRule(rule.uid, { conditions })
        }

        function duplicate(rule: RuleDraft) {
                const copy: RuleDraft = {
                        ...structuredClone(rule),
                        uid: uid(),
                        priority: newRule(state).priority,
                        label: rule.label ? `${rule.label} (copy)` : '',
                }
                const index = state.rules.findIndex((r) => r.uid === rule.uid)
                onChange({
                        ...state,
                        rules: [
                                ...state.rules.slice(0, index + 1),
                                copy,
                                ...state.rules.slice(index + 1),
                        ],
                })
        }

        return (
                <fieldset disabled={disabled} className="space-y-4">
                        <legend className="sr-only">Rules</legend>
                        <p className="text-sm text-slate-700">
                                At most one rule may match any combination of inputs, so nothing is
                                ever decided silently. An input left at “Any value” matches
                                everything. For each bound, state whether the boundary value itself
                                is included: “more than 100” leaves exactly 100 to another rule, “at
                                least 100” takes it.
                        </p>
                        {inputs.length === 0 && (
                                <Alert tone="warning" title="Add an input first">
                                        Rules compare input values, so the version needs at least
                                        one input field.
                                </Alert>
                        )}
                        {state.rules.map((rule, index) => {
                                const context = `rule row ${index + 1}`
                                return (
                                        <fieldset
                                                key={rule.uid}
                                                className={`${cardClasses} space-y-3 p-4`}
                                        >
                                                <legend className="px-1 text-sm font-semibold text-slate-900">
                                                        Rule row {index + 1}
                                                        {rule.label.trim() &&
                                                                `: ${rule.label.trim()}`}
                                                </legend>
                                                <div className="grid grid-cols-1 gap-3 sm:grid-cols-[8rem_1fr]">
                                                        <TextField
                                                                label="Priority"
                                                                hint="Unique whole number"
                                                                inputMode="numeric"
                                                                value={rule.priority}
                                                                onChange={(e) =>
                                                                        updateRule(rule.uid, {
                                                                                priority: e.target
                                                                                        .value,
                                                                        })
                                                                }
                                                        />
                                                        <TextField
                                                                label="Label (optional)"
                                                                maxLength={100}
                                                                value={rule.label}
                                                                onChange={(e) =>
                                                                        updateRule(rule.uid, {
                                                                                label: e.target
                                                                                        .value,
                                                                        })
                                                                }
                                                        />
                                                </div>
                                                <div className="space-y-2">
                                                        <p className="text-sm font-semibold text-slate-800">
                                                                When
                                                        </p>
                                                        {inputs.map((field) => (
                                                                <ConditionEditor
                                                                        key={field.uid}
                                                                        field={field}
                                                                        context={context}
                                                                        condition={
                                                                                rule.conditions[
                                                                                        field.uid
                                                                                ]
                                                                        }
                                                                        onChange={(next) =>
                                                                                setCondition(
                                                                                        rule,
                                                                                        field.uid,
                                                                                        next,
                                                                                )
                                                                        }
                                                                />
                                                        ))}
                                                </div>
                                                <div className="space-y-2">
                                                        <p className="text-sm font-semibold text-slate-800">
                                                                Then
                                                        </p>
                                                        <OutputValues
                                                                fields={outputs}
                                                                values={rule.outputs}
                                                                context={context}
                                                                onChange={(values) =>
                                                                        updateRule(rule.uid, {
                                                                                outputs: values,
                                                                        })
                                                                }
                                                        />
                                                </div>
                                                <div className="flex flex-wrap gap-2">
                                                        <Button
                                                                size="sm"
                                                                disabled={
                                                                        state.rules.length >=
                                                                        meta.max_rules
                                                                }
                                                                onClick={() => duplicate(rule)}
                                                        >
                                                                <Copy
                                                                        aria-hidden="true"
                                                                        className="size-4"
                                                                />
                                                                Duplicate rule row {index + 1}
                                                        </Button>
                                                        <Button
                                                                size="sm"
                                                                variant="ghost"
                                                                onClick={() =>
                                                                        onChange({
                                                                                ...state,
                                                                                rules: state.rules.filter(
                                                                                        (r) =>
                                                                                                r.uid !==
                                                                                                rule.uid,
                                                                                ),
                                                                        })
                                                                }
                                                        >
                                                                <Trash2
                                                                        aria-hidden="true"
                                                                        className="size-4"
                                                                />
                                                                Remove rule row {index + 1}
                                                        </Button>
                                                </div>
                                        </fieldset>
                                )
                        })}
                        <Button
                                disabled={state.rules.length >= meta.max_rules}
                                onClick={() =>
                                        onChange({
                                                ...state,
                                                rules: [...state.rules, newRule(state)],
                                        })
                                }
                        >
                                <Plus aria-hidden="true" className="size-4" />
                                Add a rule
                        </Button>

                        <fieldset className={`${cardClasses} space-y-3 p-4`}>
                                <legend className="px-1 text-sm font-semibold text-slate-900">
                                        When no rule matches
                                </legend>
                                <p className="text-sm text-slate-700">
                                        Choose explicitly: give a default result, or stop with an
                                        error so that nothing is produced until the data or the
                                        rules are corrected.
                                </p>
                                <div className="max-w-md">
                                        <SelectField
                                                label="When no rule matches"
                                                value={state.noMatchMode}
                                                onChange={(e) =>
                                                        onChange({
                                                                ...state,
                                                                noMatchMode: e.target.value as
                                                                        '' | 'default' | 'error',
                                                        })
                                                }
                                                options={[
                                                        { value: '', label: 'Choose…' },
                                                        {
                                                                value: 'default',
                                                                label: 'Use a default result',
                                                        },
                                                        {
                                                                value: 'error',
                                                                label: 'Stop with an error (no result)',
                                                        },
                                                ]}
                                        />
                                </div>
                                {state.noMatchMode === 'default' && (
                                        <OutputValues
                                                fields={outputs}
                                                values={state.noMatchOutputs}
                                                context="default result"
                                                onChange={(values) =>
                                                        onChange({
                                                                ...state,
                                                                noMatchOutputs: values,
                                                        })
                                                }
                                        />
                                )}
                        </fieldset>
                </fieldset>
        )
}

function ConditionEditor({
        field,
        condition,
        context,
        onChange,
}: {
        field: FieldDraft
        condition: ConditionDraft | undefined
        context: string
        onChange: (next: ConditionDraft | undefined) => void
}) {
        const name = fieldName(field)
        const kind = conditionKind(field.dataType)
        const label = (part: string) => `${name}: ${part}, ${context}`
        let body
        if (condition !== undefined && condition.kind !== kind) {
                body = (
                        <div className="flex flex-wrap items-center gap-2 text-sm text-amber-900">
                                This condition was set for a different data type.
                                <Button size="sm" onClick={() => onChange(undefined)}>
                                        Clear the condition on {name}
                                </Button>
                        </div>
                )
        } else if (kind === 'bool') {
                body = (
                        <CompactSelect
                                aria-label={label('condition')}
                                className="max-w-xs"
                                value={condition?.kind === 'bool' ? String(condition.value) : ''}
                                onChange={(e) =>
                                        onChange(
                                                e.target.value === ''
                                                        ? undefined
                                                        : {
                                                                  kind: 'bool',
                                                                  value: e.target.value === 'true',
                                                          },
                                        )
                                }
                                options={[
                                        { value: '', label: 'Any value' },
                                        { value: 'true', label: 'Yes' },
                                        { value: 'false', label: 'No' },
                                ]}
                        />
                )
        } else if (kind === 'set') {
                const allowed = allowedValuesOf(field)
                const chosen = condition?.kind === 'set' ? condition.values : []
                const stale = chosen.filter((v) => !allowed.includes(v))
                body = (
                        <div className="space-y-2">
                                <CompactSelect
                                        aria-label={label('condition')}
                                        className="max-w-xs"
                                        value={condition ? 'set' : ''}
                                        onChange={(e) =>
                                                onChange(
                                                        e.target.value === ''
                                                                ? undefined
                                                                : emptyCondition(field.dataType),
                                                )
                                        }
                                        options={[
                                                { value: '', label: 'Any value' },
                                                { value: 'set', label: 'One of the values' },
                                        ]}
                                />
                                {condition &&
                                        (allowed.length === 0 ? (
                                                <p className="text-sm text-amber-900">
                                                        List the field’s allowed values first.
                                                </p>
                                        ) : (
                                                <div
                                                        role="group"
                                                        aria-label={label('values')}
                                                        className="flex flex-wrap gap-x-4 gap-y-1"
                                                >
                                                        {allowed.map((v) => (
                                                                <CheckboxField
                                                                        key={v}
                                                                        label={v}
                                                                        checked={chosen.includes(v)}
                                                                        onChange={(e) =>
                                                                                onChange({
                                                                                        kind: 'set',
                                                                                        values: e
                                                                                                .target
                                                                                                .checked
                                                                                                ? [
                                                                                                          ...chosen,
                                                                                                          v,
                                                                                                  ]
                                                                                                : chosen.filter(
                                                                                                          (
                                                                                                                  x,
                                                                                                          ) =>
                                                                                                                  x !==
                                                                                                                  v,
                                                                                                  ),
                                                                                })
                                                                        }
                                                                />
                                                        ))}
                                                </div>
                                        ))}
                                {stale.length > 0 && (
                                        <p className="text-sm text-amber-900">
                                                No longer allowed: {stale.join(', ')}.
                                        </p>
                                )}
                        </div>
                )
        } else {
                body = (
                        <RangeEditor
                                field={field}
                                condition={condition?.kind === 'range' ? condition : undefined}
                                label={label}
                                onChange={onChange}
                        />
                )
        }
        return (
                <div className="grid grid-cols-1 gap-2 rounded-md border border-slate-200 p-3 md:grid-cols-[12rem_1fr]">
                        <div className="text-sm font-medium text-slate-800">
                                {name}
                                {field.unit && ` (${field.unit})`}
                        </div>
                        <div>{body}</div>
                </div>
        )
}

function describeRange(condition: RangeDraft, dates: boolean): string {
        const parts: string[] = []
        const lowerWords = {
                gt: dates ? 'after' : 'more than',
                gte: dates ? 'on or after' : 'at least',
        }
        const upperWords = {
                lt: dates ? 'before' : 'less than',
                lte: dates ? 'on or before' : 'at most',
        }
        if (condition.min.trim())
                parts.push(
                        condition.minMode
                                ? `${lowerWords[condition.minMode]} ${condition.min.trim()}`
                                : `${condition.min.trim()} (choose whether it is included)`,
                )
        if (condition.max.trim())
                parts.push(
                        condition.maxMode
                                ? `${upperWords[condition.maxMode]} ${condition.max.trim()}`
                                : `${condition.max.trim()} (choose whether it is included)`,
                )
        return parts.length
                ? `Matches ${parts.join(' and ')}.`
                : 'Give a lower bound, an upper bound or both.'
}

function RangeEditor({
        field,
        condition,
        label,
        onChange,
}: {
        field: FieldDraft
        condition: RangeDraft | undefined
        label: (part: string) => string
        onChange: (next: ConditionDraft | undefined) => void
}) {
        const dates = field.dataType === 'DATE'
        const inputMode = dates ? undefined : field.dataType === 'INTEGER' ? 'numeric' : 'decimal'
        const patch = (change: Partial<RangeDraft>) =>
                condition && onChange({ ...condition, ...change })
        return (
                <div className="space-y-1">
                        <div className="flex flex-wrap items-center gap-2">
                                <CompactSelect
                                        aria-label={label('condition')}
                                        className="w-44"
                                        value={condition ? 'range' : ''}
                                        onChange={(e) =>
                                                onChange(
                                                        e.target.value === ''
                                                                ? undefined
                                                                : emptyCondition(field.dataType),
                                                )
                                        }
                                        options={[
                                                { value: '', label: 'Any value' },
                                                { value: 'range', label: 'Within bounds' },
                                        ]}
                                />
                                {condition && (
                                        <>
                                                <CompactSelect
                                                        aria-label={label('lower bound')}
                                                        className="w-40"
                                                        value={condition.minMode}
                                                        onChange={(e) =>
                                                                patch({
                                                                        minMode: e.target
                                                                                .value as RangeDraft['minMode'],
                                                                })
                                                        }
                                                        options={[
                                                                {
                                                                        value: '',
                                                                        label: 'Lower bound…',
                                                                },
                                                                {
                                                                        value: 'gt',
                                                                        label: dates
                                                                                ? 'After'
                                                                                : 'More than',
                                                                },
                                                                {
                                                                        value: 'gte',
                                                                        label: dates
                                                                                ? 'On or after'
                                                                                : 'At least',
                                                                },
                                                        ]}
                                                />
                                                <CompactInput
                                                        aria-label={label('lower bound value')}
                                                        className="w-36"
                                                        type={dates ? 'date' : 'text'}
                                                        inputMode={inputMode}
                                                        value={condition.min}
                                                        onChange={(e) =>
                                                                patch({ min: e.target.value })
                                                        }
                                                />
                                                <span className="text-sm text-slate-600">and</span>
                                                <CompactSelect
                                                        aria-label={label('upper bound')}
                                                        className="w-40"
                                                        value={condition.maxMode}
                                                        onChange={(e) =>
                                                                patch({
                                                                        maxMode: e.target
                                                                                .value as RangeDraft['maxMode'],
                                                                })
                                                        }
                                                        options={[
                                                                {
                                                                        value: '',
                                                                        label: 'Upper bound…',
                                                                },
                                                                {
                                                                        value: 'lt',
                                                                        label: dates
                                                                                ? 'Before'
                                                                                : 'Less than',
                                                                },
                                                                {
                                                                        value: 'lte',
                                                                        label: dates
                                                                                ? 'On or before'
                                                                                : 'At most',
                                                                },
                                                        ]}
                                                />
                                                <CompactInput
                                                        aria-label={label('upper bound value')}
                                                        className="w-36"
                                                        type={dates ? 'date' : 'text'}
                                                        inputMode={inputMode}
                                                        value={condition.max}
                                                        onChange={(e) =>
                                                                patch({ max: e.target.value })
                                                        }
                                                />
                                        </>
                                )}
                        </div>
                        {condition && (
                                <p className="text-xs text-slate-600">
                                        {describeRange(condition, dates)}
                                </p>
                        )}
                </div>
        )
}
