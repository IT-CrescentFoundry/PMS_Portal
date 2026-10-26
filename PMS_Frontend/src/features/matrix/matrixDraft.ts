/**
 * Editor state for a matrix version, and its conversion to and from the
 * definition JSON the API stores.
 *
 * Fields are identified by a stable `uid` while editing, so renaming a key
 * keeps every rule condition, output and test value attached to it. Nothing
 * is validated here: the API's rule engine is the single authority (it also
 * validates Excel uploads), and the editor shows its report.
 */
import type {
        MatrixAggregation,
        MatrixCondition,
        MatrixDataType,
        MatrixDefinition,
        MatrixField,
        MatrixFieldRole,
        MatrixSource,
        MatrixTypeMeta,
        MatrixValue,
} from '../../types/api'

let counter = 0

export function uid(): string {
        counter += 1
        return `f${counter}`
}

/** Explicit inclusivity: '' means not chosen yet (the API then reports it). */
export type LowerMode = '' | 'gt' | 'gte'
export type UpperMode = '' | 'lt' | 'lte'

export interface RangeDraft {
        kind: 'range'
        min: string
        minMode: LowerMode
        max: string
        maxMode: UpperMode
}

export interface SetDraft {
        kind: 'set'
        values: string[]
}

export interface BoolDraft {
        kind: 'bool'
        value: boolean
}

export type ConditionDraft = RangeDraft | SetDraft | BoolDraft

export interface FieldDraft {
        uid: string
        key: string
        label: string
        role: MatrixFieldRole
        dataType: MatrixDataType
        unit: string
        description: string
        required: boolean
        min: string
        max: string
        /** One allowed value per line (category fields). */
        allowedValues: string
        source: MatrixSource | ''
        aggregation: MatrixAggregation | ''
        roundTo: string
        /** A standard field of the type: its key, data type and source are fixed. */
        standard: boolean
}

export interface RuleDraft {
        uid: string
        priority: string
        label: string
        /** By field uid; no entry = any value matches. */
        conditions: Record<string, ConditionDraft>
        /** By field uid. */
        outputs: Record<string, string>
}

export interface TestCaseDraft {
        uid: string
        label: string
        inputs: Record<string, string>
        expected: Record<string, string>
}

export interface MatrixDraftState {
        fields: FieldDraft[]
        rules: RuleDraft[]
        noMatchMode: '' | 'default' | 'error'
        noMatchOutputs: Record<string, string>
        testCases: TestCaseDraft[]
}

export function conditionKind(dataType: MatrixDataType): ConditionDraft['kind'] {
        if (dataType === 'CATEGORY') return 'set'
        if (dataType === 'BOOLEAN') return 'bool'
        return 'range'
}

export function emptyCondition(dataType: MatrixDataType): ConditionDraft {
        const kind = conditionKind(dataType)
        if (kind === 'set') return { kind, values: [] }
        if (kind === 'bool') return { kind, value: true }
        return { kind, min: '', minMode: '', max: '', maxMode: '' }
}

export const inputsOf = (state: MatrixDraftState) => state.fields.filter((f) => f.role === 'input')
export const outputsOf = (state: MatrixDraftState) =>
        state.fields.filter((f) => f.role === 'output')

/** Allowed values of a category field, as entered (one per line). */
export function allowedValuesOf(field: FieldDraft): string[] {
        return field.allowedValues
                .split('\n')
                .map((v) => v.trim())
                .filter(Boolean)
}

export function text(value: MatrixValue | undefined): string {
        if (value === null || value === undefined) return ''
        if (typeof value === 'boolean') return value ? 'true' : 'false'
        return String(value)
}

function isStandard(meta: MatrixTypeMeta, field: MatrixField): boolean {
        const list = field.role === 'output' ? meta.outputs : meta.standard_inputs
        return list.some((f) => f.key === field.key)
}

export function fieldDraft(field: MatrixField, standard: boolean): FieldDraft {
        return {
                uid: uid(),
                key: field.key,
                label: field.label,
                role: field.role,
                dataType: field.data_type,
                unit: field.unit ?? '',
                description: field.description ?? '',
                required: field.required,
                min: field.min ?? '',
                max: field.max ?? '',
                allowedValues: (field.allowed_values ?? []).join('\n'),
                source: field.source ?? '',
                aggregation: field.aggregation ?? '',
                roundTo: field.round_to === null ? '' : String(field.round_to),
                standard,
        }
}

/** A new custom input (or output) of the type, with nothing chosen for the user. */
export function customField(meta: MatrixTypeMeta, role: MatrixFieldRole): FieldDraft {
        const types = role === 'input' ? meta.custom_input_types : meta.custom_output_types
        return {
                uid: uid(),
                key: '',
                label: '',
                role,
                dataType: types.includes('DECIMAL') ? 'DECIMAL' : types[0],
                unit: '',
                description: '',
                required: true,
                min: '',
                max: '',
                allowedValues: '',
                source: role === 'input' ? meta.custom_input_source : '',
                aggregation: '',
                roundTo: '',
                standard: false,
        }
}

function conditionDraft(condition: MatrixCondition): ConditionDraft {
        if ('values' in condition) return { kind: 'set', values: [...condition.values] }
        if ('value' in condition) return { kind: 'bool', value: condition.value === true }
        const lower: LowerMode =
                condition.min_inclusive === true
                        ? 'gte'
                        : condition.min_inclusive === false
                          ? 'gt'
                          : ''
        const upper: UpperMode =
                condition.max_inclusive === true
                        ? 'lte'
                        : condition.max_inclusive === false
                          ? 'lt'
                          : ''
        return {
                kind: 'range',
                min: text(condition.min),
                minMode: condition.min === null ? '' : lower,
                max: text(condition.max),
                maxMode: condition.max === null ? '' : upper,
        }
}

export interface LoadedDraft {
        state: MatrixDraftState
        /** Content that refers to unknown fields; it is dropped on the next save. */
        dropped: string[]
}

export function draftFromDefinition(
        definition: MatrixDefinition,
        meta: MatrixTypeMeta,
): LoadedDraft {
        const dropped: string[] = []
        const fields = (definition.fields ?? []).map((f) => fieldDraft(f, isStandard(meta, f)))
        const uidOf = new Map(fields.map((f) => [f.key, f.uid]))
        const byKey = (
                values: Record<string, MatrixValue> | null | undefined,
                where: string,
        ): Record<string, string> => {
                const result: Record<string, string> = {}
                for (const [key, value] of Object.entries(values ?? {})) {
                        const id = uidOf.get(key)
                        if (id === undefined)
                                dropped.push(`${where} refers to an unknown field '${key}'.`)
                        else result[id] = text(value)
                }
                return result
        }
        const rules = (definition.rules ?? []).map((rule, index): RuleDraft => {
                const conditions: Record<string, ConditionDraft> = {}
                for (const [key, condition] of Object.entries(rule.conditions ?? {})) {
                        const id = uidOf.get(key)
                        if (id === undefined)
                                dropped.push(
                                        `Rule row ${index + 1} has a condition on an unknown field '${key}'.`,
                                )
                        else conditions[id] = conditionDraft(condition)
                }
                return {
                        uid: uid(),
                        priority: text(rule.priority),
                        label: rule.label ?? '',
                        conditions,
                        outputs: byKey(rule.outputs, `Rule row ${index + 1}`),
                }
        })
        const noMatch = definition.no_match
        return {
                state: {
                        fields,
                        rules,
                        noMatchMode: noMatch?.mode ?? '',
                        noMatchOutputs: byKey(noMatch?.outputs, 'The default output'),
                        testCases: (definition.test_cases ?? []).map((testCase, index) => ({
                                uid: uid(),
                                label: testCase.label ?? '',
                                inputs: byKey(testCase.inputs, `Test case ${index + 1}`),
                                expected: byKey(testCase.expected, `Test case ${index + 1}`),
                        })),
                },
                dropped,
        }
}

function value(field: FieldDraft, raw: string | undefined): MatrixValue {
        const trimmed = (raw ?? '').trim()
        if (trimmed === '') return null
        if (field.dataType === 'BOOLEAN') {
                if (trimmed === 'true') return true
                if (trimmed === 'false') return false
        }
        return trimmed
}

function valuesOf(fields: FieldDraft[], values: Record<string, string>, keepBlank: boolean) {
        const result: Record<string, MatrixValue> = {}
        for (const field of fields) {
                const converted = value(field, values[field.uid])
                if (converted !== null || keepBlank) result[field.key.trim()] = converted
        }
        return result
}

function conditionJson(condition: ConditionDraft): MatrixCondition {
        if (condition.kind === 'set') return { values: condition.values }
        if (condition.kind === 'bool') return { value: condition.value }
        const min = condition.min.trim()
        const max = condition.max.trim()
        const inclusive = (mode: string, yes: string, no: string) =>
                mode === yes ? true : mode === no ? false : null
        return {
                min: min || null,
                min_inclusive: min ? inclusive(condition.minMode, 'gte', 'gt') : null,
                max: max || null,
                max_inclusive: max ? inclusive(condition.maxMode, 'lte', 'lt') : null,
        }
}

/** Whole numbers stay numbers; anything else is sent as typed, for the API to report. */
function wholeNumber(raw: string): number {
        const trimmed = raw.trim()
        const parsed = Number(trimmed)
        return (trimmed !== '' && Number.isInteger(parsed) ? parsed : trimmed || null) as number
}

export const RANGE_TYPES: MatrixDataType[] = ['DECIMAL', 'INTEGER', 'PERCENT', 'DATE']
export const ROUNDABLE_TYPES: MatrixDataType[] = ['DECIMAL', 'PERCENT']

export function definitionFromDraft(state: MatrixDraftState): MatrixDefinition {
        const inputs = inputsOf(state)
        const outputs = outputsOf(state)
        return {
                fields: state.fields.map((f) => {
                        const ranged = RANGE_TYPES.includes(f.dataType)
                        return {
                                key: f.key.trim(),
                                label: f.label.trim(),
                                role: f.role,
                                data_type: f.dataType,
                                unit: f.unit.trim() || null,
                                description: f.description.trim() || null,
                                required: f.required,
                                min: ranged ? f.min.trim() || null : null,
                                max: ranged ? f.max.trim() || null : null,
                                allowed_values:
                                        f.dataType === 'CATEGORY' ? allowedValuesOf(f) : null,
                                source: f.role === 'input' ? f.source || null : null,
                                aggregation:
                                        f.role === 'input' && f.source === 'IMPORTED'
                                                ? f.aggregation || null
                                                : null,
                                round_to:
                                        ROUNDABLE_TYPES.includes(f.dataType) && f.roundTo.trim()
                                                ? wholeNumber(f.roundTo)
                                                : null,
                        }
                }),
                rules: state.rules.map((r) => ({
                        priority: wholeNumber(r.priority),
                        label: r.label.trim() || null,
                        conditions: Object.fromEntries(
                                inputs
                                        .filter((f) => r.conditions[f.uid] !== undefined)
                                        .map((f) => [
                                                f.key.trim(),
                                                conditionJson(r.conditions[f.uid]),
                                        ]),
                        ),
                        outputs: valuesOf(outputs, r.outputs, true),
                })),
                no_match:
                        state.noMatchMode === ''
                                ? null
                                : state.noMatchMode === 'error'
                                  ? { mode: 'error' }
                                  : {
                                            mode: 'default',
                                            outputs: valuesOf(outputs, state.noMatchOutputs, true),
                                    },
                test_cases: state.testCases.map((t) => ({
                        label: t.label.trim(),
                        inputs: valuesOf(inputs, t.inputs, false),
                        expected: valuesOf(outputs, t.expected, false),
                })),
        }
}

/** Preview inputs (by field uid) as the API expects them (by key); blanks are left out. */
export function previewInputs(
        state: MatrixDraftState,
        values: Record<string, string>,
): Record<string, MatrixValue> {
        return valuesOf(inputsOf(state), values, false)
}

/** The next free priority: one more than the highest whole-number priority. */
export function nextPriority(state: MatrixDraftState): string {
        const used = state.rules.map((r) => Number(r.priority)).filter(Number.isInteger)
        return String(used.length ? Math.max(...used) + 1 : 1)
}

export function newRule(state: MatrixDraftState): RuleDraft {
        return { uid: uid(), priority: nextPriority(state), label: '', conditions: {}, outputs: {} }
}

export function newTestCase(): TestCaseDraft {
        return { uid: uid(), label: '', inputs: {}, expected: {} }
}

/** A key suggested from a label: "Defect rate %" -> "defect_rate". */
export function suggestedKey(label: string): string {
        const slug = label
                .toLowerCase()
                .replace(/[^a-z0-9]+/g, '_')
                .replace(/^_+|_+$/g, '')
        return (/^[a-z]/.test(slug) ? slug : slug ? `f_${slug}` : '').slice(0, 40)
}

/** Display name of a field while editing. */
export function fieldName(field: FieldDraft): string {
        return field.label.trim() || field.key.trim() || 'New field'
}

/** Remove a field and everything that refers to it. */
export function removeField(state: MatrixDraftState, fieldUid: string): MatrixDraftState {
        const without = <T>(record: Record<string, T>) =>
                Object.fromEntries(Object.entries(record).filter(([key]) => key !== fieldUid))
        return {
                ...state,
                fields: state.fields.filter((f) => f.uid !== fieldUid),
                rules: state.rules.map((r) => ({
                        ...r,
                        conditions: without(r.conditions),
                        outputs: without(r.outputs),
                })),
                noMatchOutputs: without(state.noMatchOutputs),
                testCases: state.testCases.map((t) => ({
                        ...t,
                        inputs: without(t.inputs),
                        expected: without(t.expected),
                })),
        }
}
