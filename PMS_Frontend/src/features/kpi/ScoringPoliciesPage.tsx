import { useState, type FormEvent } from 'react'
import { Link } from 'react-router'
import { Alert } from '../../components/common/Alert'
import { ActionError } from '../../components/common/ActionError'
import { Badge } from '../../components/common/Badge'
import { Button } from '../../components/common/Button'
import { TextField } from '../../components/common/Fields'
import { PageHeader } from '../../components/common/PageHeader'
import { EmptyState, ErrorState, LoadingState } from '../../components/common/QueryStates'
import { cardClasses, linkClasses } from '../../components/common/styles'
import { Table, TBody, Td, Th } from '../../components/tables/Table'
import { useAction } from '../../hooks/useAction'
import { useApiQuery } from '../../hooks/useApiQuery'
import { listPolicies, previewPolicyScore } from '../../services/kpiApi'
import type { PolicyPreview, ScoringPolicy } from '../../types/api'
import { formatDate } from '../../utils/format'
import { useCurrentUser } from '../auth/AuthContext'
import { canReadMatrices } from '../auth/permissions'
import { DIRECTION_LABELS, describePolicy } from './kpiLabels'

export function ScoringPoliciesPage() {
        const policies = useApiQuery('policies', (signal) => listPolicies(signal))
        return (
                <>
                        <PageHeader
                                title="Scoring rules"
                                description="How a KPI's quarterly result turns into a score. Each scoring rule is a versioned KPI-scoring matrix approved by the CHRO; the version in force when a KPI sheet is published is frozen onto the sheet. Achievement % = actual ÷ quarterly target × 100, and every boundary states whether it is included."
                                breadcrumbs={[
                                        {
                                                label: 'KPI library',
                                                to: '/kpi/library',
                                        },
                                        { label: 'Scoring rules' },
                                ]}
                        />
                        {policies.isLoading ? (
                                <LoadingState label="Loading scoring rules…" />
                        ) : policies.error !== undefined || !policies.data ? (
                                <ErrorState error={policies.error} onRetry={policies.reload} />
                        ) : policies.data.length === 0 ? (
                                <EmptyState title="No scoring rules defined" />
                        ) : (
                                <div className="grid grid-cols-1 gap-4 xl:grid-cols-2">
                                        {policies.data.map((policy) => (
                                                <PolicyCard key={policy.id} policy={policy} />
                                        ))}
                                </div>
                        )}
                </>
        )
}

function MatrixLink({ policy }: { policy: ScoringPolicy }) {
        const user = useCurrentUser()
        const matrix = policy.matrix!
        const version = matrix.in_force ?? matrix.latest
        const label = `${matrix.code} version ${version.version_no}`
        return (
                <p className="text-sm text-slate-700">
                        Rules:{' '}
                        {canReadMatrices(user) ? (
                                <Link
                                        to={`/matrices/${matrix.id}/versions/${version.id}`}
                                        className={linkClasses}
                                >
                                        {label}
                                </Link>
                        ) : (
                                label
                        )}
                        {matrix.in_force
                                ? `, in force since ${formatDate(matrix.in_force.effective_from)}.`
                                : ' (not approved yet).'}
                </p>
        )
}

function PolicyCard({ policy }: { policy: ScoringPolicy }) {
        const zero = policy.direction === 'ZERO_TOLERANCE'
        if (policy.matrix) {
                return (
                        <section
                                aria-labelledby={`policy-${policy.id}`}
                                className={`${cardClasses} space-y-3 p-4`}
                        >
                                <div className="flex flex-wrap items-center gap-2">
                                        <h2
                                                id={`policy-${policy.id}`}
                                                className="text-base font-semibold text-slate-900"
                                        >
                                                {policy.name}
                                        </h2>
                                        <Badge>{policy.code}</Badge>
                                        <Badge tone="info">
                                                {DIRECTION_LABELS[policy.direction]}
                                        </Badge>
                                        {!policy.is_active && <Badge>Inactive</Badge>}
                                </div>
                                {policy.description && (
                                        <p className="text-sm text-slate-700">
                                                {policy.description}
                                        </p>
                                )}
                                <MatrixLink policy={policy} />
                                {!policy.matrix.in_force && (
                                        <Alert tone="warning" title="No approved version in force">
                                                KPI sheets using this rule cannot be published until
                                                the CHRO approves a version and it is published.
                                        </Alert>
                                )}
                                <ScoreTry policy={policy} />
                        </section>
                )
        }
        const word = policy.direction === 'HIGHER_IS_BETTER' ? 'Above' : 'Below'
        return (
                <section
                        aria-labelledby={`policy-${policy.id}`}
                        className={`${cardClasses} space-y-3 p-4`}
                >
                        <div className="flex flex-wrap items-center gap-2">
                                <h2
                                        id={`policy-${policy.id}`}
                                        className="text-base font-semibold text-slate-900"
                                >
                                        {policy.name}
                                </h2>
                                <Badge>{policy.code}</Badge>
                                <Badge tone="info">{DIRECTION_LABELS[policy.direction]}</Badge>
                                {!policy.is_active && <Badge>Inactive</Badge>}
                        </div>
                        {policy.description && (
                                <p className="text-sm text-slate-700">{policy.description}</p>
                        )}
                        <p className="text-sm text-slate-700">{describePolicy(policy)}</p>
                        {!zero && (
                                <Table caption={`${policy.name}: score bands`}>
                                        <thead>
                                                <tr>
                                                        <Th>Achievement</Th>
                                                        <Th align="right">Score</Th>
                                                </tr>
                                        </thead>
                                        <TBody>
                                                {policy.bands.map((band) => (
                                                        <tr key={band.threshold}>
                                                                <Td>
                                                                        {word} {band.threshold}%
                                                                </Td>
                                                                <Td align="right">{band.score}</Td>
                                                        </tr>
                                                ))}
                                                <tr>
                                                        <Td>Otherwise</Td>
                                                        <Td align="right">
                                                                {policy.fallback_score}
                                                        </Td>
                                                </tr>
                                        </TBody>
                                </Table>
                        )}
                        <ScoreTry policy={policy} />
                </section>
        )
}

function ScoreTry({ policy }: { policy: ScoringPolicy }) {
        const zero = policy.direction === 'ZERO_TOLERANCE'
        const [value, setValue] = useState('')
        const [score, setScore] = useState<PolicyPreview | null>(null)
        const action = useAction()
        const number = Number(value)
        const valid = value.trim() !== '' && Number.isFinite(number) && number >= 0

        async function handleSubmit(event: FormEvent) {
                event.preventDefault()
                if (!valid) return
                const result = await action.run(() =>
                        previewPolicyScore(
                                policy.id,
                                zero ? { actual: number } : { achievement_percent: number },
                        ),
                )
                setScore(result ?? null)
        }

        return (
                <form onSubmit={handleSubmit} className="flex flex-wrap items-end gap-2">
                        <div className="w-48">
                                <TextField
                                        label={
                                                zero
                                                        ? 'Try an actual count'
                                                        : 'Try an achievement %'
                                        }
                                        inputMode="decimal"
                                        value={value}
                                        onChange={(e) => {
                                                setValue(e.target.value)
                                                setScore(null)
                                        }}
                                />
                        </div>
                        <Button type="submit" disabled={!valid} isLoading={action.busy}>
                                Show score
                        </Button>
                        <p
                                aria-live="polite"
                                className="h-10 content-center text-sm font-semibold text-slate-900"
                        >
                                {score !== null &&
                                        `Score: ${score.score}${score.version_no !== null ? ` (version ${score.version_no}${score.status !== 'PUBLISHED' ? ', not yet in force' : ''})` : ''}`}
                        </p>
                        <div className="w-full">
                                <ActionError
                                        error={action.error}
                                        title="The score could not be calculated"
                                />
                        </div>
                </form>
        )
}
