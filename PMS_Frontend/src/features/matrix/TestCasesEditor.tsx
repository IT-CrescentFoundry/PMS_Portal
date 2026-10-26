import { Plus, Trash2 } from 'lucide-react'
import { Button } from '../../components/common/Button'
import { TextField } from '../../components/common/Fields'
import { cardClasses } from '../../components/common/styles'
import { ValueInput } from './controls'
import {
        allowedValuesOf,
        fieldName,
        inputsOf,
        newTestCase,
        outputsOf,
        type FieldDraft,
        type MatrixDraftState,
        type TestCaseDraft,
} from './matrixDraft'
import { OutputValues } from './RulesEditor'

/** Worked examples with the expected result; they run with every check. */
export function TestCasesEditor({
        state,
        onChange,
        disabled,
}: {
        state: MatrixDraftState
        onChange: (next: MatrixDraftState) => void
        disabled?: boolean
}) {
        const inputs = inputsOf(state)
        const outputs = outputsOf(state)
        const update = (caseUid: string, patch: Partial<TestCaseDraft>) =>
                onChange({
                        ...state,
                        testCases: state.testCases.map((t) =>
                                t.uid === caseUid ? { ...t, ...patch } : t,
                        ),
                })

        return (
                <fieldset disabled={disabled} className="space-y-4">
                        <legend className="sr-only">Test cases</legend>
                        <p className="text-sm text-slate-700">
                                Give inputs and the result you expect, especially on each boundary
                                (for example exactly 100%). Tests run with every check, and a
                                failing test blocks submission.
                        </p>
                        {state.testCases.map((testCase, index) => {
                                const context = `test case ${index + 1}`
                                return (
                                        <fieldset
                                                key={testCase.uid}
                                                className={`${cardClasses} space-y-3 p-4`}
                                        >
                                                <legend className="px-1 text-sm font-semibold text-slate-900">
                                                        Test case {index + 1}
                                                        {testCase.label.trim() &&
                                                                `: ${testCase.label.trim()}`}
                                                </legend>
                                                <div className="max-w-md">
                                                        <TextField
                                                                label="Label"
                                                                maxLength={100}
                                                                value={testCase.label}
                                                                onChange={(e) =>
                                                                        update(testCase.uid, {
                                                                                label: e.target
                                                                                        .value,
                                                                        })
                                                                }
                                                        />
                                                </div>
                                                <p className="text-sm font-semibold text-slate-800">
                                                        Inputs
                                                </p>
                                                <InputValues
                                                        fields={inputs}
                                                        values={testCase.inputs}
                                                        context={context}
                                                        onChange={(values) =>
                                                                update(testCase.uid, {
                                                                        inputs: values,
                                                                })
                                                        }
                                                />
                                                <p className="text-sm font-semibold text-slate-800">
                                                        Expected result
                                                </p>
                                                <OutputValues
                                                        fields={outputs}
                                                        values={testCase.expected}
                                                        context={`expected, ${context}`}
                                                        onChange={(values) =>
                                                                update(testCase.uid, {
                                                                        expected: values,
                                                                })
                                                        }
                                                />
                                                <Button
                                                        size="sm"
                                                        variant="ghost"
                                                        onClick={() =>
                                                                onChange({
                                                                        ...state,
                                                                        testCases: state.testCases.filter(
                                                                                (t) =>
                                                                                        t.uid !==
                                                                                        testCase.uid,
                                                                        ),
                                                                })
                                                        }
                                                >
                                                        <Trash2
                                                                aria-hidden="true"
                                                                className="size-4"
                                                        />
                                                        Remove test case {index + 1}
                                                </Button>
                                        </fieldset>
                                )
                        })}
                        <Button
                                onClick={() =>
                                        onChange({
                                                ...state,
                                                testCases: [...state.testCases, newTestCase()],
                                        })
                                }
                        >
                                <Plus aria-hidden="true" className="size-4" />
                                Add a test case
                        </Button>
                </fieldset>
        )
}

/** One labelled value control per input field (test cases and previews). */
export function InputValues({
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
                                                {!field.required && ' (optional)'}
                                        </span>
                                        <ValueInput
                                                field={{
                                                        dataType: field.dataType,
                                                        allowed: allowedValuesOf(field),
                                                }}
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
