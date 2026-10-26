import { useState, type FormEvent } from 'react'
import { Link, useNavigate } from 'react-router'
import { ActionError } from '../../components/common/ActionError'
import { Alert } from '../../components/common/Alert'
import { Button } from '../../components/common/Button'
import { SelectField, TextAreaField, TextField } from '../../components/common/Fields'
import { PageHeader } from '../../components/common/PageHeader'
import { ErrorState, LoadingState } from '../../components/common/QueryStates'
import { buttonClasses, cardClasses } from '../../components/common/styles'
import { useAction } from '../../hooks/useAction'
import { useApiQuery } from '../../hooks/useApiQuery'
import { createMatrix, listMatrixTypes } from '../../services/matrixApi'
import { listOrgUnits } from '../../services/organizationApi'
import type { MatrixTypeMeta, OrgUnit } from '../../types/api'
import { useCurrentUser } from '../auth/AuthContext'
import { canWriteMatrices } from '../auth/permissions'
import { AccessDenied } from '../auth/RequireAuth'
import { attributeValueLabel } from './matrixLabels'
import { ScopeRows } from './ScopeRows'
import { COMPANY_WIDE, scopeInputs, type ScopeRow } from './scopes'

/** /matrices/new */
export function MatrixCreatePage() {
        const user = useCurrentUser()
        const allowed = canWriteMatrices(user)
        const types = useApiQuery(allowed ? 'matrix-types' : null, (signal) =>
                listMatrixTypes(signal),
        )
        const units = useApiQuery(allowed ? 'org-units' : null, (signal) =>
                listOrgUnits({}, signal),
        )
        if (!allowed) return <AccessDenied />
        const failed = [types, units].find((q) => q.error !== undefined)
        if (failed) return <ErrorState error={failed.error} onRetry={failed.reload} />
        if (!types.data || !units.data) return <LoadingState label="Loading matrix types…" />
        return <CreateForm types={types.data} units={units.data} />
}

function CreateForm({ types, units }: { types: MatrixTypeMeta[]; units: OrgUnit[] }) {
        const navigate = useNavigate()
        const save = useAction()
        const [typeCode, setTypeCode] = useState('')
        const [name, setName] = useState('')
        const [description, setDescription] = useState('')
        const [attributes, setAttributes] = useState<Record<string, string>>({})
        const [scopes, setScopes] = useState<ScopeRow[]>([{ ...COMPANY_WIDE }])
        const [touched, setTouched] = useState(false)
        const type = types.find((t) => t.code === typeCode)

        const scopeKeys = scopes.map((s) => `${s.plantId}|${s.departmentId}`)
        const errors = {
                type: type ? undefined : 'Choose the kind of matrix.',
                name: name.trim().length < 2 ? 'Enter a name (at least 2 characters).' : undefined,
                attributes: type?.attributes.some((a) => !attributes[a.key])
                        ? 'Choose every setting of this matrix type.'
                        : undefined,
                scopes:
                        scopes.length === 0
                                ? 'Add at least one place where the matrix applies.'
                                : new Set(scopeKeys).size !== scopeKeys.length
                                  ? 'Each place may be listed once.'
                                  : undefined,
        }
        const shown = (message: string | undefined) => (touched ? message : undefined)

        async function handleSubmit(event: FormEvent) {
                event.preventDefault()
                setTouched(true)
                if (!type || Object.values(errors).some(Boolean)) return
                const created = await save.run(() =>
                        createMatrix({
                                matrix_type: type.code,
                                name: name.trim(),
                                description: description.trim() || null,
                                attributes,
                                applicability: scopeInputs(scopes),
                        }),
                )
                if (created)
                        navigate(
                                `/matrices/${created.id}/versions/${created.latest_version.id}/edit`,
                        )
        }

        return (
                <>
                        <PageHeader
                                title="New matrix"
                                description="Choose the kind of matrix and where it applies. It starts as an empty draft (version 1) that you define, check and submit to the CHRO."
                                breadcrumbs={[
                                        { label: 'Matrices', to: '/matrices' },
                                        { label: 'New' },
                                ]}
                        />
                        <form onSubmit={handleSubmit} noValidate className="space-y-6">
                                <ActionError
                                        error={save.error}
                                        title="The matrix was not created"
                                />
                                <fieldset className={`${cardClasses} space-y-3 p-4`}>
                                        <legend className="px-1 text-base font-semibold text-slate-900">
                                                Kind of matrix
                                        </legend>
                                        {shown(errors.type) && (
                                                <p
                                                        role="alert"
                                                        className="text-sm font-medium text-red-700"
                                                >
                                                        {errors.type}
                                                </p>
                                        )}
                                        <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
                                                {types.map((t) => (
                                                        <label
                                                                key={t.code}
                                                                className={`flex cursor-pointer gap-3 rounded-lg border p-3 ${typeCode === t.code ? 'border-brand-500 bg-brand-50' : 'border-slate-200'}`}
                                                        >
                                                                <input
                                                                        type="radio"
                                                                        name="matrix-type"
                                                                        value={t.code}
                                                                        checked={
                                                                                typeCode === t.code
                                                                        }
                                                                        onChange={() => {
                                                                                setTypeCode(t.code)
                                                                                setAttributes({})
                                                                        }}
                                                                        className="mt-1 size-4 accent-brand-700"
                                                                />
                                                                <span className="space-y-1 text-sm">
                                                                        <span className="block font-semibold text-slate-900">
                                                                                {t.name}
                                                                        </span>
                                                                        <span className="block text-slate-700">
                                                                                {t.description}
                                                                        </span>
                                                                        {t.policy_note && (
                                                                                <span className="block text-amber-900">
                                                                                        {
                                                                                                t.policy_note
                                                                                        }
                                                                                </span>
                                                                        )}
                                                                </span>
                                                        </label>
                                                ))}
                                        </div>
                                </fieldset>

                                <fieldset
                                        className={`${cardClasses} grid grid-cols-1 gap-4 p-4 sm:grid-cols-2`}
                                >
                                        <legend className="px-1 text-base font-semibold text-slate-900">
                                                Matrix
                                        </legend>
                                        <TextField
                                                label="Name"
                                                maxLength={150}
                                                value={name}
                                                error={shown(errors.name)}
                                                onChange={(e) => setName(e.target.value)}
                                        />
                                        {type?.attributes.map((a) => (
                                                <SelectField
                                                        key={a.key}
                                                        label={a.label}
                                                        hint={a.description}
                                                        value={attributes[a.key] ?? ''}
                                                        error={shown(
                                                                attributes[a.key]
                                                                        ? undefined
                                                                        : errors.attributes,
                                                        )}
                                                        onChange={(e) =>
                                                                setAttributes({
                                                                        ...attributes,
                                                                        [a.key]: e.target.value,
                                                                })
                                                        }
                                                        options={[
                                                                { value: '', label: 'Choose…' },
                                                                ...a.allowed_values.map((v) => ({
                                                                        value: v,
                                                                        label: attributeValueLabel(
                                                                                v,
                                                                        ),
                                                                })),
                                                        ]}
                                                />
                                        ))}
                                        <div className="sm:col-span-2">
                                                <TextAreaField
                                                        label="Description (optional)"
                                                        maxLength={1000}
                                                        value={description}
                                                        onChange={(e) =>
                                                                setDescription(e.target.value)
                                                        }
                                                />
                                        </div>
                                </fieldset>

                                <fieldset className={`${cardClasses} space-y-3 p-4`}>
                                        <legend className="px-1 text-base font-semibold text-slate-900">
                                                Where it applies
                                        </legend>
                                        <p className="text-sm text-slate-600">
                                                Company-wide (all plants and all departments) needs
                                                company-wide HR Head access. Each version can narrow
                                                this later.
                                        </p>
                                        {shown(errors.scopes) && (
                                                <p
                                                        role="alert"
                                                        className="text-sm font-medium text-red-700"
                                                >
                                                        {errors.scopes}
                                                </p>
                                        )}
                                        <ScopeRows
                                                rows={scopes}
                                                units={units}
                                                onChange={setScopes}
                                        />
                                </fieldset>

                                {type?.code === 'KPI_SCORING' && (
                                        <Alert title="A scoring policy is created with it">
                                                KPIs refer to KPI-scoring matrices through a scoring
                                                policy of the same direction. The policy appears
                                                under Scoring rules once the matrix exists; it
                                                scores nothing until a version is approved and
                                                published.
                                        </Alert>
                                )}

                                <div className="flex flex-wrap gap-2">
                                        <Button
                                                type="submit"
                                                variant="primary"
                                                isLoading={save.busy}
                                        >
                                                Create and define version 1
                                        </Button>
                                        <Link to="/matrices" className={buttonClasses('ghost')}>
                                                Cancel
                                        </Link>
                                </div>
                        </form>
                </>
        )
}
