import { Plus, Send, Trash2 } from 'lucide-react'
import { useState, type FormEvent } from 'react'
import { Link, useNavigate, useParams } from 'react-router'
import { ActionError } from '../../components/common/ActionError'
import { Alert } from '../../components/common/Alert'
import { Badge } from '../../components/common/Badge'
import { Button } from '../../components/common/Button'
import {
        CheckboxField,
        SelectField,
        TextAreaField,
        TextField,
} from '../../components/common/Fields'
import { PageHeader } from '../../components/common/PageHeader'
import { ErrorState, LoadingState } from '../../components/common/QueryStates'
import { ReasonForm } from '../../components/common/ReasonForm'
import { StatCard } from '../../components/common/StatCard'
import { cardClasses, linkClasses } from '../../components/common/styles'
import { Table, TBody, Td, Th } from '../../components/tables/Table'
import { useAction } from '../../hooks/useAction'
import { useApiQuery } from '../../hooks/useApiQuery'
import {
        getDistribution,
        publishDistribution,
        saveDistribution,
        startDistribution,
} from '../../services/allocationApi'
import { listOrgUnits } from '../../services/organizationApi'
import type { Distribution, DistributionMethod, OrgUnit } from '../../types/api'
import { formatDate } from '../../utils/format'
import { parseId } from '../../utils/params'
import { History } from '../annual/AnnualEmployeePage'
import { InvalidLink } from '../common/InvalidLink'
import { money, percent } from '../compensation/compensationLabels'
import { DISTRIBUTION_STATUS, METHOD } from './allocationLabels'

/** /allocations/distributions/:distributionId */
export function DistributionPage() {
        const distributionId = parseId(useParams().distributionId)
        const query = useApiQuery(
                distributionId === undefined ? null : `distribution|${distributionId}`,
                (signal) => getDistribution(distributionId!, signal),
        )
        if (distributionId === undefined)
                return <InvalidLink backTo="/allocations" backLabel="Back to allocations" />
        if (query.isLoading) return <LoadingState label="Loading the distribution…" />
        if (query.error !== undefined || !query.data)
                return <ErrorState error={query.error} onRetry={query.reload} />
        return (
                <DistributionView
                        key={`${query.data.id}-${query.data.status}`}
                        initial={query.data}
                />
        )
}

function DistributionView({ initial }: { initial: Distribution }) {
        const navigate = useNavigate()
        const [d, setD] = useState(initial)
        const [message, setMessage] = useState<string | null>(null)
        const [revising, setRevising] = useState(false)
        const publish = useAction()
        const revise = useAction()
        const t = d.totals
        const currency = d.cycle.currency
        const status = DISTRIBUTION_STATUS[d.status]

        async function handlePublish() {
                const saved = await publish.run(() => publishDistribution(d.id))
                if (saved) {
                        setD(saved)
                        setMessage('Published. Departments now propose against this version.')
                }
        }

        async function handleRevise(reason: string) {
                const created = await revise.run(() => startDistribution(d.cycle.id, reason))
                if (created) navigate(`/allocations/distributions/${created.id}`)
        }

        return (
                <>
                        <PageHeader
                                title={`Budget distribution version ${d.version_no}`}
                                description={`${d.cycle.name}: the approved company budget split to plants and then to plant departments. A percentage is of the parent amount and is rounded down to the cent; what is left stays unallocated and is never redistributed.`}
                                breadcrumbs={[
                                        { label: 'Increment allocations', to: '/allocations' },
                                        {
                                                label: d.cycle.name,
                                                to: `/allocations/cycles/${d.cycle.id}`,
                                        },
                                        { label: `Distribution ${d.version_no}` },
                                ]}
                                meta={<Badge tone={status.tone}>{status.label}</Badge>}
                        />
                        <div className="space-y-4">
                                {message && <Alert title={message} />}
                                {d.stale_reasons.length > 0 && (
                                        <Alert
                                                tone="warning"
                                                title="This version no longer matches the approved budget"
                                        >
                                                {d.stale_reasons.join(' ')}
                                        </Alert>
                                )}
                                {d.revision_reason && (
                                        <p className="text-sm text-slate-700">
                                                <span className="font-medium">
                                                        Reason for this version:
                                                </span>{' '}
                                                {d.revision_reason}
                                        </p>
                                )}
                                <dl className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
                                        <StatCard
                                                label={`Company budget (${currency})`}
                                                value={money(d.budget_amount)}
                                        />
                                        <StatCard
                                                label="Distributed to plants"
                                                value={money(t.plants_total)}
                                                hint={`Unallocated ${money(t.unallocated)} (rounding ${money(t.rounding_residual)})`}
                                        />
                                        <StatCard
                                                label="Distributed to departments"
                                                value={money(t.units_total)}
                                                hint={`Left at plant level ${money(t.plants_unallocated)}`}
                                        />
                                </dl>
                                {d.actions.can_edit ? (
                                        <Editor
                                                distribution={d}
                                                onSaved={(saved) => {
                                                        setD(saved)
                                                        setMessage('Draft saved.')
                                                }}
                                        />
                                ) : (
                                        <PlantsTable distribution={d} />
                                )}
                                {(d.actions.can_publish || d.actions.can_start_revision) && (
                                        <section
                                                aria-labelledby="dist-actions"
                                                className={`${cardClasses} space-y-3 p-4`}
                                        >
                                                <h2
                                                        id="dist-actions"
                                                        className="text-base font-semibold text-slate-900"
                                                >
                                                        {d.actions.can_publish
                                                                ? 'Publish'
                                                                : 'Revise'}
                                                </h2>
                                                <ActionError
                                                        error={publish.error ?? revise.error}
                                                        title="Nothing was changed"
                                                />
                                                {d.actions.can_publish && (
                                                        <>
                                                                <p className="text-sm text-slate-700">
                                                                        Publishing replaces the
                                                                        version in force; proposals
                                                                        made against a unit whose
                                                                        amount changes must be
                                                                        refreshed and resubmitted.
                                                                </p>
                                                                <Button
                                                                        variant="primary"
                                                                        isLoading={publish.busy}
                                                                        onClick={handlePublish}
                                                                >
                                                                        <Send
                                                                                aria-hidden="true"
                                                                                className="size-4"
                                                                        />
                                                                        Publish this version
                                                                </Button>
                                                        </>
                                                )}
                                                {d.actions.can_start_revision &&
                                                        (revising ? (
                                                                <ReasonForm
                                                                        label="Why does the distribution change?"
                                                                        hint="At least 10 characters; recorded with the new version."
                                                                        minLength={10}
                                                                        submitLabel="Start a revised version"
                                                                        busy={revise.busy}
                                                                        onSubmit={handleRevise}
                                                                        onCancel={() =>
                                                                                setRevising(false)
                                                                        }
                                                                />
                                                        ) : (
                                                                <Button
                                                                        onClick={() =>
                                                                                setRevising(true)
                                                                        }
                                                                >
                                                                        Revise the distribution…
                                                                </Button>
                                                        ))}
                                        </section>
                                )}
                                <section aria-labelledby="dist-versions" className="space-y-2">
                                        <h2
                                                id="dist-versions"
                                                className="text-base font-semibold text-slate-900"
                                        >
                                                Versions
                                        </h2>
                                        <ul
                                                aria-label="Distribution versions"
                                                className="space-y-1 text-sm"
                                        >
                                                {d.versions.map((v) => (
                                                        <li key={v.id}>
                                                                <Link
                                                                        to={`/allocations/distributions/${v.id}`}
                                                                        className={linkClasses}
                                                                >
                                                                        Version {v.version_no}
                                                                </Link>{' '}
                                                                <Badge
                                                                        tone={
                                                                                DISTRIBUTION_STATUS[
                                                                                        v.status
                                                                                ].tone
                                                                        }
                                                                >
                                                                        {
                                                                                DISTRIBUTION_STATUS[
                                                                                        v.status
                                                                                ].label
                                                                        }
                                                                </Badge>{' '}
                                                                {v.published_at
                                                                        ? `published ${formatDate(v.published_at)} by ${v.published_by?.username ?? '—'}`
                                                                        : `started ${formatDate(v.created_at)} by ${v.created_by?.username ?? '—'}`}
                                                        </li>
                                                ))}
                                        </ul>
                                </section>
                                <History entries={d.history} />
                        </div>
                </>
        )
}

function PlantsTable({ distribution }: { distribution: Distribution }) {
        if (distribution.plants.length === 0)
                return (
                        <p className="text-sm text-slate-700">
                                Nothing is allocated in this version.
                        </p>
                )
        return (
                <Table caption="Distribution by plant and department">
                        <thead>
                                <tr>
                                        <Th>Plant / department</Th>
                                        <Th>Method</Th>
                                        <Th align="right">Amount</Th>
                                        <Th align="right">Unallocated</Th>
                                </tr>
                        </thead>
                        <TBody>
                                {distribution.plants.flatMap((p) => [
                                        <tr key={`p-${p.id}`} className="bg-slate-50">
                                                <Td className="font-medium">{p.plant.name}</Td>
                                                <Td>
                                                        {p.percent
                                                                ? percent(p.percent)
                                                                : METHOD[p.method]}
                                                </Td>
                                                <Td align="right">{money(p.amount)}</Td>
                                                <Td align="right">
                                                        {money(p.unallocated)}
                                                        <div className="text-xs text-slate-600">
                                                                rounding{' '}
                                                                {money(p.rounding_residual)}
                                                        </div>
                                                </Td>
                                        </tr>,
                                        ...p.units.map((u) => (
                                                <tr key={`u-${u.id}`}>
                                                        <Td>
                                                                <span className="pl-4">
                                                                        {u.department.name}
                                                                </span>
                                                        </Td>
                                                        <Td>
                                                                {u.percent
                                                                        ? percent(u.percent)
                                                                        : METHOD[u.method]}
                                                        </Td>
                                                        <Td align="right">
                                                                {money(u.amount)}
                                                                {u.percent && (
                                                                        <div className="text-xs text-slate-600">
                                                                                exact{' '}
                                                                                {u.amount_exact}
                                                                        </div>
                                                                )}
                                                        </Td>
                                                        <Td align="right">—</Td>
                                                </tr>
                                        )),
                                ])}
                        </TBody>
                </Table>
        )
}

interface UnitDraft {
        departmentId: number
        method: DistributionMethod
        value: string
}

interface PlantDraft {
        plantId: number
        method: DistributionMethod
        value: string
        units: UnitDraft[]
}

function toDraft(d: Distribution): PlantDraft[] {
        return d.plants.map((p) => ({
                plantId: p.plant.id,
                method: p.method,
                value: p.method === 'PERCENT' ? (p.percent ?? '') : p.amount,
                units: p.units.map((u) => ({
                        departmentId: u.department.id,
                        method: u.method,
                        value: u.method === 'PERCENT' ? (u.percent ?? '') : u.amount,
                })),
        }))
}

const METHOD_OPTIONS = [
        { value: 'PERCENT', label: METHOD.PERCENT },
        { value: 'AMOUNT', label: METHOD.AMOUNT },
]

function Editor({
        distribution,
        onSaved,
}: {
        distribution: Distribution
        onSaved: (d: Distribution) => void
}) {
        const units = useApiQuery('org-units', (signal) => listOrgUnits({}, signal))
        const [plants, setPlants] = useState<PlantDraft[]>(() => toDraft(distribution))
        const [mixed, setMixed] = useState(distribution.allow_mixed_methods)
        const [note, setNote] = useState(distribution.note ?? '')
        const [addPlant, setAddPlant] = useState('')
        const action = useAction()
        const all: OrgUnit[] = (units.data ?? []).filter((u) => u.is_active)
        const plantNames = new Map(all.map((u) => [u.plant.id, u.plant.name]))
        const deptNames = new Map(all.map((u) => [u.department.id, u.department.name]))

        function update(index: number, change: Partial<PlantDraft>) {
                setPlants(plants.map((p, i) => (i === index ? { ...p, ...change } : p)))
        }

        async function handleSave(event: FormEvent) {
                event.preventDefault()
                const saved = await action.run(() =>
                        saveDistribution(distribution.id, {
                                allow_mixed_methods: mixed,
                                note: note.trim() || null,
                                plants: plants.map((p) => ({
                                        plant_id: p.plantId,
                                        method: p.method,
                                        value: p.value.trim(),
                                        units: p.units.map((u) => ({
                                                department_id: u.departmentId,
                                                method: u.method,
                                                value: u.value.trim(),
                                        })),
                                })),
                        }),
                )
                if (saved) onSaved(saved)
        }

        if (units.isLoading) return <LoadingState label="Loading plants and departments…" />
        if (units.error !== undefined)
                return <ErrorState error={units.error} onRetry={units.reload} />
        const freePlants = [...plantNames].filter(([id]) => !plants.some((p) => p.plantId === id))
        return (
                <form
                        onSubmit={handleSave}
                        noValidate
                        aria-label="Edit the distribution"
                        className={`${cardClasses} space-y-4 p-4`}
                >
                        <h2 className="text-base font-semibold text-slate-900">
                                Allocate the budget
                        </h2>
                        <CheckboxField
                                label="Allow percentages and fixed amounts side by side"
                                checked={mixed}
                                onChange={(e) => setMixed(e.target.checked)}
                        />
                        {plants.map((p, index) => {
                                const freeUnits = all.filter(
                                        (u) =>
                                                u.plant.id === p.plantId &&
                                                !p.units.some(
                                                        (x) => x.departmentId === u.department.id,
                                                ),
                                )
                                const name = plantNames.get(p.plantId) ?? `Plant ${p.plantId}`
                                return (
                                        <fieldset
                                                key={p.plantId}
                                                className="space-y-2 rounded-md border border-slate-200 p-3"
                                        >
                                                <legend className="px-1 text-sm font-semibold text-slate-900">
                                                        {name}
                                                </legend>
                                                <div className="flex flex-wrap items-end gap-2">
                                                        <div className="w-44">
                                                                <SelectField
                                                                        label={`${name}: method`}
                                                                        value={p.method}
                                                                        onChange={(e) =>
                                                                                update(index, {
                                                                                        method: e
                                                                                                .target
                                                                                                .value as DistributionMethod,
                                                                                })
                                                                        }
                                                                        options={METHOD_OPTIONS}
                                                                />
                                                        </div>
                                                        <div className="w-44">
                                                                <TextField
                                                                        label={`${name}: ${p.method === 'PERCENT' ? '% of the company budget' : 'amount'}`}
                                                                        inputMode="decimal"
                                                                        value={p.value}
                                                                        onChange={(e) =>
                                                                                update(index, {
                                                                                        value: e
                                                                                                .target
                                                                                                .value,
                                                                                })
                                                                        }
                                                                />
                                                        </div>
                                                        <Button
                                                                size="sm"
                                                                variant="ghost"
                                                                onClick={() =>
                                                                        setPlants(
                                                                                plants.filter(
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
                                                                Remove {name}
                                                        </Button>
                                                </div>
                                                {p.units.map((u, ui) => {
                                                        const dept =
                                                                deptNames.get(u.departmentId) ??
                                                                `Department ${u.departmentId}`
                                                        const setUnit = (
                                                                change: Partial<UnitDraft>,
                                                        ) =>
                                                                update(index, {
                                                                        units: p.units.map(
                                                                                (x, j) =>
                                                                                        j === ui
                                                                                                ? {
                                                                                                          ...x,
                                                                                                          ...change,
                                                                                                  }
                                                                                                : x,
                                                                        ),
                                                                })
                                                        return (
                                                                <div
                                                                        key={u.departmentId}
                                                                        className="flex flex-wrap items-end gap-2 pl-4"
                                                                >
                                                                        <div className="w-44">
                                                                                <SelectField
                                                                                        label={`${dept} — ${name}: method`}
                                                                                        value={
                                                                                                u.method
                                                                                        }
                                                                                        onChange={(
                                                                                                e,
                                                                                        ) =>
                                                                                                setUnit(
                                                                                                        {
                                                                                                                method: e
                                                                                                                        .target
                                                                                                                        .value as DistributionMethod,
                                                                                                        },
                                                                                                )
                                                                                        }
                                                                                        options={
                                                                                                METHOD_OPTIONS
                                                                                        }
                                                                                />
                                                                        </div>
                                                                        <div className="w-44">
                                                                                <TextField
                                                                                        label={`${dept} — ${name}: ${u.method === 'PERCENT' ? '% of the plant' : 'amount'}`}
                                                                                        inputMode="decimal"
                                                                                        value={
                                                                                                u.value
                                                                                        }
                                                                                        onChange={(
                                                                                                e,
                                                                                        ) =>
                                                                                                setUnit(
                                                                                                        {
                                                                                                                value: e
                                                                                                                        .target
                                                                                                                        .value,
                                                                                                        },
                                                                                                )
                                                                                        }
                                                                                />
                                                                        </div>
                                                                        <Button
                                                                                size="sm"
                                                                                variant="ghost"
                                                                                onClick={() =>
                                                                                        update(
                                                                                                index,
                                                                                                {
                                                                                                        units: p.units.filter(
                                                                                                                (
                                                                                                                        _,
                                                                                                                        j,
                                                                                                                ) =>
                                                                                                                        j !==
                                                                                                                        ui,
                                                                                                        ),
                                                                                                },
                                                                                        )
                                                                                }
                                                                        >
                                                                                Remove {dept}
                                                                        </Button>
                                                                </div>
                                                        )
                                                })}
                                                {freeUnits.length > 0 && (
                                                        <div className="w-64 pl-4">
                                                                <SelectField
                                                                        label={`Add a department of ${name}`}
                                                                        value=""
                                                                        onChange={(e) => {
                                                                                const id = Number(
                                                                                        e.target
                                                                                                .value,
                                                                                )
                                                                                if (id)
                                                                                        update(
                                                                                                index,
                                                                                                {
                                                                                                        units: [
                                                                                                                ...p.units,
                                                                                                                {
                                                                                                                        departmentId:
                                                                                                                                id,
                                                                                                                        method:
                                                                                                                                p
                                                                                                                                        .units[0]
                                                                                                                                        ?.method ??
                                                                                                                                'AMOUNT',
                                                                                                                        value: '',
                                                                                                                },
                                                                                                        ],
                                                                                                },
                                                                                        )
                                                                        }}
                                                                        options={[
                                                                                {
                                                                                        value: '',
                                                                                        label: 'Choose…',
                                                                                },
                                                                                ...freeUnits.map(
                                                                                        (u) => ({
                                                                                                value: String(
                                                                                                        u
                                                                                                                .department
                                                                                                                .id,
                                                                                                ),
                                                                                                label: u
                                                                                                        .department
                                                                                                        .name,
                                                                                        }),
                                                                                ),
                                                                        ]}
                                                                />
                                                        </div>
                                                )}
                                        </fieldset>
                                )
                        })}
                        {freePlants.length > 0 && (
                                <div className="flex flex-wrap items-end gap-2">
                                        <div className="w-64">
                                                <SelectField
                                                        label="Add a plant"
                                                        value={addPlant}
                                                        onChange={(e) =>
                                                                setAddPlant(e.target.value)
                                                        }
                                                        options={[
                                                                { value: '', label: 'Choose…' },
                                                                ...freePlants.map(
                                                                        ([id, label]) => ({
                                                                                value: String(id),
                                                                                label,
                                                                        }),
                                                                ),
                                                        ]}
                                                />
                                        </div>
                                        <Button
                                                disabled={!addPlant}
                                                onClick={() => {
                                                        setPlants([
                                                                ...plants,
                                                                {
                                                                        plantId: Number(addPlant),
                                                                        method:
                                                                                plants[0]?.method ??
                                                                                'AMOUNT',
                                                                        value: '',
                                                                        units: [],
                                                                },
                                                        ])
                                                        setAddPlant('')
                                                }}
                                        >
                                                <Plus aria-hidden="true" className="size-4" />
                                                Add
                                        </Button>
                                </div>
                        )}
                        <TextAreaField
                                label="Note (optional)"
                                maxLength={1000}
                                value={note}
                                onChange={(e) => setNote(e.target.value)}
                        />
                        <ActionError error={action.error} title="The draft was not saved" />
                        <Button type="submit" variant="primary" isLoading={action.busy}>
                                Save the draft
                        </Button>
                </form>
        )
}
