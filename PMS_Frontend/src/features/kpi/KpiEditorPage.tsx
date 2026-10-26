import { Plus, Trash2 } from 'lucide-react'
import { useState, type FormEvent } from 'react'
import { Link, useNavigate, useParams } from 'react-router'
import { ActionError } from '../../components/common/ActionError'
import { Alert } from '../../components/common/Alert'
import { Button } from '../../components/common/Button'
import {
        CheckboxField,
        SelectField,
        TextAreaField,
        TextField,
} from '../../components/common/Fields'
import { PageHeader } from '../../components/common/PageHeader'
import { ErrorState, LoadingState } from '../../components/common/QueryStates'
import { buttonClasses, cardClasses } from '../../components/common/styles'
import { useAction } from '../../hooks/useAction'
import { useApiQuery } from '../../hooks/useApiQuery'
import { createKpi, getKpi, listPolicies, updateKpi } from '../../services/kpiApi'
import { listOrgUnits } from '../../services/organizationApi'
import type {
        Kpi,
        KpiAggregation,
        KpiDirection,
        OrgUnit,
        ReportingFrequency,
        ScoringPolicy,
} from '../../types/api'
import { parseId } from '../../utils/params'
import { useCurrentUser } from '../auth/AuthContext'
import { canWriteKpi } from '../auth/permissions'
import { InvalidLink } from '../common/InvalidLink'
import { departmentsOf, plantsOf } from '../organization/orgUnits'
import { AGGREGATION_LABELS, DIRECTION_LABELS, FREQUENCY_LABELS, describePolicy } from './kpiLabels'

/** /kpi/library/new */
export function KpiCreatePage() {
        return <KpiEditorLoader />
}

/** /kpi/library/:kpiId */
export function KpiEditPage() {
        const kpiId = parseId(useParams().kpiId)
        if (kpiId === undefined)
                return <InvalidLink backTo="/kpi/library" backLabel="Back to the KPI library" />
        return <KpiEditorLoader kpiId={kpiId} />
}

function KpiEditorLoader({ kpiId }: { kpiId?: number }) {
        const units = useApiQuery('org-units', (signal) => listOrgUnits({}, signal))
        const policies = useApiQuery('policies', (signal) => listPolicies(signal))
        const kpi = useApiQuery(kpiId === undefined ? null : `kpi|${kpiId}`, (signal) =>
                getKpi(kpiId!, signal),
        )
        const failed = [units, policies, kpi].find((q) => q.error !== undefined)
        if (failed) return <ErrorState error={failed.error} onRetry={failed.reload} />
        if (!units.data || !policies.data || (kpiId !== undefined && !kpi.data))
                return <LoadingState label="Loading KPI…" />
        return (
                <KpiEditor
                        key={kpi.data?.id ?? 'new'}
                        units={units.data}
                        policies={policies.data}
                        kpi={kpi.data}
                />
        )
}

interface ScopeRow {
        plantId: string
        departmentId: string
}

interface EditorProps {
        units: OrgUnit[]
        policies: ScoringPolicy[]
        kpi?: Kpi
}

function KpiEditor({ units, policies, kpi: loaded }: EditorProps) {
        const user = useCurrentUser()
        const navigate = useNavigate()
        const writable = canWriteKpi(user)
        const save = useAction()
        const [kpi, setKpi] = useState(loaded)
        const [saved, setSaved] = useState(false)
        const [touched, setTouched] = useState(false)
        const [name, setName] = useState(kpi?.name ?? '')
        const [description, setDescription] = useState(kpi?.description ?? '')
        const [unit, setUnit] = useState(kpi?.unit ?? '%')
        const [direction, setDirection] = useState<KpiDirection>(
                kpi?.direction ?? 'HIGHER_IS_BETTER',
        )
        const [policyId, setPolicyId] = useState(kpi ? String(kpi.default_scoring_policy.id) : '')
        const [dataSource, setDataSource] = useState(kpi?.data_source ?? '')
        const [active, setActive] = useState(kpi?.is_active ?? true)
        const [frequency, setFrequency] = useState<ReportingFrequency | ''>(
                kpi?.reporting_frequency ?? '',
        )
        const [aggregation, setAggregation] = useState<KpiAggregation | ''>(kpi?.aggregation ?? '')
        const [method, setMethod] = useState(kpi?.measurement_method ?? '')
        const [scopes, setScopes] = useState<ScopeRow[]>(
                kpi
                        ? kpi.applicability.map((a) => ({
                                  plantId: a.plant ? String(a.plant.id) : '',
                                  departmentId: a.department ? String(a.department.id) : '',
                          }))
                        : [{ plantId: '', departmentId: '' }],
        )

        const matchingPolicies = policies.filter((p) => p.direction === direction && p.is_active)
        const policy = policies.find((p) => String(p.id) === policyId)
        const plants = plantsOf(units)

        const scopeKeys = scopes.map((s) => `${s.plantId}|${s.departmentId}`)
        const errors = {
                name:
                        name.trim().length < 2
                                ? 'Enter the KPI name (at least 2 characters).'
                                : undefined,
                unit: unit.trim() === '' ? 'Enter the unit, e.g. %, days, nos.' : undefined,
                policy:
                        policy === undefined || policy.direction !== direction
                                ? 'Choose a scoring rule for this direction.'
                                : undefined,
                scopes:
                        scopes.length === 0
                                ? 'Add at least one place where the KPI applies.'
                                : new Set(scopeKeys).size !== scopeKeys.length
                                  ? 'Each place may be listed once.'
                                  : undefined,
        }
        const hasErrors = Object.values(errors).some(Boolean)

        async function handleSubmit(event: FormEvent) {
                event.preventDefault()
                setTouched(true)
                setSaved(false)
                if (hasErrors) return
                const body = {
                        name: name.trim(),
                        description: description.trim() || null,
                        unit: unit.trim(),
                        direction,
                        default_scoring_policy_id: Number(policyId),
                        data_source: dataSource.trim() || null,
                        applicability: scopes.map((s) => ({
                                plant_id: s.plantId ? Number(s.plantId) : null,
                                department_id: s.departmentId ? Number(s.departmentId) : null,
                        })),
                        is_active: active,
                        reporting_frequency: frequency || null,
                        aggregation: frequency === 'MONTHLY' ? aggregation || null : null,
                        measurement_method: method.trim() || null,
                }
                const result = await save.run(() =>
                        kpi ? updateKpi(kpi.id, body) : createKpi(body),
                )
                if (!result) return
                if (kpi) {
                        setKpi(result)
                        setSaved(true)
                } else {
                        navigate(`/kpi/library/${result.id}`)
                }
        }

        const shown = (message: string | undefined) => (touched ? message : undefined)

        return (
                <>
                        <PageHeader
                                title={kpi ? kpi.name : 'New KPI'}
                                description={
                                        kpi
                                                ? `${kpi.code} · ${DIRECTION_LABELS[kpi.direction]}`
                                                : 'Define the KPI once and reuse it on many employees’ sheets. Check the library first: a KPI with the same meaning should be reused, not duplicated.'
                                }
                                breadcrumbs={[
                                        {
                                                label: 'KPI library',
                                                to: '/kpi/library',
                                        },
                                        { label: kpi ? kpi.name : 'New KPI' },
                                ]}
                        />
                        {saved && <Alert title="Saved">The KPI has been updated.</Alert>}
                        <form onSubmit={handleSubmit} noValidate className="mt-4 space-y-6">
                                <ActionError error={save.error} />
                                <fieldset
                                        disabled={!writable}
                                        className={`${cardClasses} grid grid-cols-1 gap-4 p-4 sm:grid-cols-2`}
                                >
                                        <legend className="px-1 text-base font-semibold text-slate-900">
                                                Definition
                                        </legend>
                                        <TextField
                                                label="KPI name"
                                                maxLength={150}
                                                value={name}
                                                error={shown(errors.name)}
                                                onChange={(e) => setName(e.target.value)}
                                        />
                                        <TextField
                                                label="Unit"
                                                hint="e.g. %, days, nos., ₹ lakh"
                                                maxLength={30}
                                                value={unit}
                                                error={shown(errors.unit)}
                                                onChange={(e) => setUnit(e.target.value)}
                                        />
                                        <SelectField
                                                label="Direction"
                                                hint={
                                                        kpi
                                                                ? 'Fixed once the KPI exists.'
                                                                : 'Choose explicitly; it is never inferred from the name.'
                                                }
                                                value={direction}
                                                disabled={kpi !== undefined}
                                                onChange={(e) => {
                                                        setDirection(e.target.value as KpiDirection)
                                                        setPolicyId('')
                                                }}
                                                options={Object.entries(DIRECTION_LABELS).map(
                                                        ([value, label]) => ({
                                                                value,
                                                                label,
                                                        }),
                                                )}
                                        />
                                        <SelectField
                                                label="Default scoring rule"
                                                hint={
                                                        policy
                                                                ? describePolicy(policy)
                                                                : 'Can be changed per employee on the KPI sheet.'
                                                }
                                                value={policyId}
                                                error={shown(errors.policy)}
                                                onChange={(e) => setPolicyId(e.target.value)}
                                                options={[
                                                        {
                                                                value: '',
                                                                label: 'Choose…',
                                                        },
                                                        ...matchingPolicies.map((p) => ({
                                                                value: String(p.id),
                                                                label: `${p.name} (${p.code})`,
                                                        })),
                                                ]}
                                        />
                                        <TextAreaField
                                                label="Description (optional)"
                                                maxLength={1000}
                                                className="sm:col-span-2"
                                                value={description}
                                                onChange={(e) => setDescription(e.target.value)}
                                        />
                                        <TextField
                                                label="Data source (optional)"
                                                hint="Where actual values will come from, e.g. Manual or SAP (for information only)."
                                                maxLength={50}
                                                value={dataSource}
                                                onChange={(e) => setDataSource(e.target.value)}
                                        />
                                        {kpi && (
                                                <CheckboxField
                                                        label="Active (inactive KPIs cannot be added to new sheets)"
                                                        checked={active}
                                                        onChange={(e) =>
                                                                setActive(e.target.checked)
                                                        }
                                                />
                                        )}
                                </fieldset>

                                <fieldset
                                        disabled={!writable}
                                        className={`${cardClasses} grid grid-cols-1 gap-4 p-4 sm:grid-cols-2`}
                                >
                                        <legend className="px-1 text-base font-semibold text-slate-900">
                                                Measurement
                                        </legend>
                                        <p className="text-sm text-slate-600 sm:col-span-2">
                                                How the actual is measured. Needed before a KPI
                                                sheet using this KPI can be published; it is then
                                                frozen on the sheet with the scoring matrix version.
                                        </p>
                                        <SelectField
                                                label="Reporting frequency"
                                                value={frequency}
                                                onChange={(e) =>
                                                        setFrequency(
                                                                e.target.value as
                                                                        ReportingFrequency | '',
                                                        )
                                                }
                                                options={[
                                                        { value: '', label: 'Not set yet' },
                                                        ...Object.entries(FREQUENCY_LABELS).map(
                                                                ([value, label]) => ({
                                                                        value,
                                                                        label,
                                                                }),
                                                        ),
                                                ]}
                                        />
                                        {frequency === 'MONTHLY' && (
                                                <SelectField
                                                        label="Monthly values combine into the quarter by"
                                                        hint="Chosen explicitly for each KPI, e.g. sum for counts, average for rates."
                                                        value={aggregation}
                                                        onChange={(e) =>
                                                                setAggregation(
                                                                        e.target.value as
                                                                                KpiAggregation | '',
                                                                )
                                                        }
                                                        options={[
                                                                { value: '', label: 'Not set yet' },
                                                                ...Object.entries(
                                                                        AGGREGATION_LABELS,
                                                                ).map(([value, label]) => ({
                                                                        value,
                                                                        label,
                                                                })),
                                                        ]}
                                                />
                                        )}
                                        <div className="sm:col-span-2">
                                                <TextAreaField
                                                        label="Measurement method (optional)"
                                                        hint="e.g. the report or formula the actual comes from."
                                                        maxLength={500}
                                                        value={method}
                                                        onChange={(e) => setMethod(e.target.value)}
                                                />
                                        </div>
                                </fieldset>

                                <fieldset
                                        disabled={!writable}
                                        className={`${cardClasses} space-y-3 p-4`}
                                >
                                        <legend className="px-1 text-base font-semibold text-slate-900">
                                                Where it applies
                                        </legend>
                                        <p className="text-sm text-slate-600">
                                                Leave the plant as “All plants” for a
                                                department-wide KPI. Company-wide KPIs (all plants
                                                and all departments) need company-wide access.
                                        </p>
                                        {shown(errors.scopes) && (
                                                <p
                                                        className="text-sm font-medium text-red-700"
                                                        role="alert"
                                                >
                                                        {errors.scopes}
                                                </p>
                                        )}
                                        {scopes.map((row, index) => (
                                                <div
                                                        key={index}
                                                        className="grid grid-cols-1 items-end gap-2 sm:grid-cols-[1fr_1fr_auto]"
                                                >
                                                        <SelectField
                                                                label={`Plant (place ${index + 1})`}
                                                                value={row.plantId}
                                                                onChange={(e) =>
                                                                        setScopes(
                                                                                scopes.map(
                                                                                        (s, i) =>
                                                                                                i ===
                                                                                                index
                                                                                                        ? {
                                                                                                                  plantId: e
                                                                                                                          .target
                                                                                                                          .value,
                                                                                                                  departmentId:
                                                                                                                          '',
                                                                                                          }
                                                                                                        : s,
                                                                                ),
                                                                        )
                                                                }
                                                                options={[
                                                                        {
                                                                                value: '',
                                                                                label: 'All plants',
                                                                        },
                                                                        ...plants.map((p) => ({
                                                                                value: String(p.id),
                                                                                label: p.name,
                                                                        })),
                                                                ]}
                                                        />
                                                        <SelectField
                                                                label={`Department (place ${index + 1})`}
                                                                value={row.departmentId}
                                                                onChange={(e) =>
                                                                        setScopes(
                                                                                scopes.map(
                                                                                        (s, i) =>
                                                                                                i ===
                                                                                                index
                                                                                                        ? {
                                                                                                                  ...s,
                                                                                                                  departmentId:
                                                                                                                          e
                                                                                                                                  .target
                                                                                                                                  .value,
                                                                                                          }
                                                                                                        : s,
                                                                                ),
                                                                        )
                                                                }
                                                                options={[
                                                                        {
                                                                                value: '',
                                                                                label: 'All departments',
                                                                        },
                                                                        ...departmentsOf(
                                                                                units,
                                                                                row.plantId
                                                                                        ? Number(
                                                                                                  row.plantId,
                                                                                          )
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
                                                                onClick={() =>
                                                                        setScopes(
                                                                                scopes.filter(
                                                                                        (_, i) =>
                                                                                                i !==
                                                                                                index,
                                                                                ),
                                                                        )
                                                                }
                                                        >
                                                                <Trash2
                                                                        aria-hidden="true"
                                                                        className="size-4"
                                                                />
                                                        </Button>
                                                </div>
                                        ))}
                                        <Button
                                                size="sm"
                                                onClick={() =>
                                                        setScopes([
                                                                ...scopes,
                                                                {
                                                                        plantId: '',
                                                                        departmentId: '',
                                                                },
                                                        ])
                                                }
                                        >
                                                <Plus aria-hidden="true" className="size-4" />
                                                Add a place
                                        </Button>
                                </fieldset>

                                {writable ? (
                                        <div className="flex flex-wrap gap-2">
                                                <Button
                                                        type="submit"
                                                        variant="primary"
                                                        isLoading={save.busy}
                                                >
                                                        {kpi ? 'Save changes' : 'Create KPI'}
                                                </Button>
                                                <Link
                                                        to="/kpi/library"
                                                        className={buttonClasses('ghost')}
                                                >
                                                        Back to the library
                                                </Link>
                                        </div>
                                ) : (
                                        <Link
                                                to="/kpi/library"
                                                className={buttonClasses('secondary')}
                                        >
                                                Back to the library
                                        </Link>
                                )}
                        </form>
                </>
        )
}
