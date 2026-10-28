import { Calculator } from 'lucide-react'
import { useState, type FormEvent } from 'react'
import { useParams } from 'react-router'
import { ActionError } from '../../components/common/ActionError'
import { Alert } from '../../components/common/Alert'
import { Badge } from '../../components/common/Badge'
import { Button } from '../../components/common/Button'
import { CheckboxField, SelectField } from '../../components/common/Fields'
import { PageHeader } from '../../components/common/PageHeader'
import { ErrorState, LoadingState } from '../../components/common/QueryStates'
import { cardClasses } from '../../components/common/styles'
import { useAction } from '../../hooks/useAction'
import { useApiQuery } from '../../hooks/useApiQuery'
import {
        getBaselineRows,
        getCompensationCycle,
        previewProposal,
} from '../../services/compensationApi'
import type { BudgetLine, CompensationCycleDetail } from '../../types/api'
import { parseId } from '../../utils/params'
import { AccessDenied } from '../auth/RequireAuth'
import { InvalidLink } from '../common/InvalidLink'
import { ProposalExplanation } from './ProposalExplanation'
import { EXCLUSIONS, chosenVersions, money, percent } from './compensationLabels'
import { VersionChoices } from './VersionChoices'

/** /compensation/cycles/:cycleId/preview */
export function ProposalPreviewPage() {
        const cycleId = parseId(useParams().cycleId)
        const query = useApiQuery(
                cycleId === undefined ? null : `compensation-cycle|${cycleId}`,
                (signal) => getCompensationCycle(cycleId!, signal),
        )
        if (cycleId === undefined)
                return <InvalidLink backTo="/compensation" backLabel="Back to compensation" />
        if (query.isLoading) return <LoadingState label="Loading the compensation cycle…" />
        if (query.error !== undefined || !query.data)
                return <ErrorState error={query.error} onRetry={query.reload} />
        if (!query.data.actions.can_read_employees) return <AccessDenied />
        return <Preview cycle={query.data} />
}

function Preview({ cycle }: { cycle: CompensationCycleDetail }) {
        const [baselineId, setBaselineId] = useState(String(cycle.baselines[0]?.id ?? ''))
        const [employeeId, setEmployeeId] = useState('')
        const [analysis, setAnalysis] = useState(false)
        const [overrides, setOverrides] = useState<Record<string, string>>({})
        const [touched, setTouched] = useState(false)
        const [line, setLine] = useState<BudgetLine | null>(null)
        const rows = useApiQuery(
                baselineId ? `baseline-rows|${cycle.id}|${baselineId}` : null,
                (signal) => getBaselineRows(cycle.id, Number(baselineId), signal),
        )
        const action = useAction()
        const error = employeeId ? undefined : 'Choose an employee.'

        async function handleSubmit(event: FormEvent) {
                event.preventDefault()
                setTouched(true)
                if (error) return
                setLine(null)
                const result = await action.run(() =>
                        previewProposal(cycle.id, {
                                employee_id: Number(employeeId),
                                baseline_id: Number(baselineId) || null,
                                overrides: analysis ? chosenVersions(overrides) : null,
                        }),
                )
                if (result) setLine(result)
        }

        return (
                <>
                        <PageHeader
                                title="Preview a proposal"
                                description="Calculates one employee’s increment proposal exactly as a scenario would, with the approved matrices in force or chosen versions. Nothing is saved."
                                breadcrumbs={[
                                        { label: 'Compensation & budget', to: '/compensation' },
                                        {
                                                label: cycle.name,
                                                to: `/compensation/cycles/${cycle.id}`,
                                        },
                                        { label: 'Preview a proposal' },
                                ]}
                        />
                        <div className="space-y-4">
                                {cycle.baselines.length === 0 ? (
                                        <Alert tone="warning" title="No salary baseline yet">
                                                Import a salary baseline for this cycle first.
                                        </Alert>
                                ) : (
                                        <form
                                                noValidate
                                                onSubmit={handleSubmit}
                                                aria-label="Preview a proposal"
                                                className={`${cardClasses} space-y-3 p-4`}
                                        >
                                                <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
                                                        <SelectField
                                                                label="Salary baseline"
                                                                value={baselineId}
                                                                onChange={(e) => {
                                                                        setBaselineId(
                                                                                e.target.value,
                                                                        )
                                                                        setEmployeeId('')
                                                                }}
                                                                options={cycle.baselines.map(
                                                                        (b) => ({
                                                                                value: String(b.id),
                                                                                label: `Version ${b.version_no} (${b.row_count} employees)`,
                                                                        }),
                                                                )}
                                                        />
                                                        <SelectField
                                                                label="Employee"
                                                                value={employeeId}
                                                                error={touched ? error : undefined}
                                                                onChange={(e) =>
                                                                        setEmployeeId(
                                                                                e.target.value,
                                                                        )
                                                                }
                                                                options={[
                                                                        {
                                                                                value: '',
                                                                                label: rows.data
                                                                                        ? 'Choose…'
                                                                                        : rows.error
                                                                                          ? 'Could not load'
                                                                                          : 'Loading…',
                                                                        },
                                                                        ...(
                                                                                rows.data?.rows ??
                                                                                []
                                                                        ).map((r) => ({
                                                                                value: String(
                                                                                        r.employee
                                                                                                .id,
                                                                                ),
                                                                                label: `${r.employee.full_name} (${r.employee.employee_code})`,
                                                                        })),
                                                                ]}
                                                        />
                                                </div>
                                                <CheckboxField
                                                        label="Use chosen matrix versions (for example a draft revision)"
                                                        checked={analysis}
                                                        onChange={(e) =>
                                                                setAnalysis(e.target.checked)
                                                        }
                                                />
                                                {analysis && (
                                                        <VersionChoices
                                                                method={cycle.cr_method}
                                                                value={overrides}
                                                                onChange={setOverrides}
                                                        />
                                                )}
                                                <ActionError
                                                        error={rows.error ?? action.error}
                                                        title="The proposal could not be calculated"
                                                />
                                                <Button
                                                        type="submit"
                                                        variant="primary"
                                                        isLoading={action.busy}
                                                >
                                                        <Calculator
                                                                aria-hidden="true"
                                                                className="size-4"
                                                        />
                                                        Calculate
                                                </Button>
                                        </form>
                                )}
                                {line && <Result line={line} currency={cycle.currency} />}
                        </div>
                </>
        )
}

function Result({ line, currency }: { line: BudgetLine; currency: string }) {
        return (
                <section
                        aria-labelledby="result-heading"
                        className={`${cardClasses} space-y-3 p-4`}
                >
                        <h2 id="result-heading" className="text-base font-semibold text-slate-900">
                                {line.employee.full_name} ({line.employee.employee_code})
                        </h2>
                        {line.status === 'EXCLUDED' ? (
                                <p className="text-sm">
                                        <Badge tone="warning">Excluded</Badge>{' '}
                                        {EXCLUSIONS[line.exclusion_code ?? ''] ??
                                                line.exclusion_code}
                                        : {line.exclusion_reason}
                                </p>
                        ) : (
                                <dl className="grid grid-cols-1 gap-3 text-sm sm:grid-cols-3">
                                        <div>
                                                <dt className="font-medium text-slate-700">
                                                        Increment
                                                </dt>
                                                <dd className="text-lg font-semibold tabular-nums">
                                                        {percent(line.increment_percent)}
                                                </dd>
                                        </div>
                                        <div>
                                                <dt className="font-medium text-slate-700">
                                                        Amount
                                                </dt>
                                                <dd className="text-lg font-semibold tabular-nums">
                                                        {money(line.increment_amount, currency)}
                                                </dd>
                                        </div>
                                        <div>
                                                <dt className="font-medium text-slate-700">
                                                        New salary
                                                </dt>
                                                <dd className="text-lg font-semibold tabular-nums">
                                                        {money(line.new_salary, currency)}
                                                </dd>
                                        </div>
                                </dl>
                        )}
                        <ProposalExplanation line={line} currency={currency} />
                </section>
        )
}
