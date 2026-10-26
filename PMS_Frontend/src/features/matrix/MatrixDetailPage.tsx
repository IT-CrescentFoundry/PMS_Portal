import { GitBranchPlus } from 'lucide-react'
import { Link, useNavigate, useParams } from 'react-router'
import { ActionError } from '../../components/common/ActionError'
import { Alert } from '../../components/common/Alert'
import { Badge } from '../../components/common/Badge'
import { Button } from '../../components/common/Button'
import { PageHeader } from '../../components/common/PageHeader'
import { ErrorState, LoadingState } from '../../components/common/QueryStates'
import { buttonClasses, cardClasses, linkClasses } from '../../components/common/styles'
import { Table, TBody, Td, Th } from '../../components/tables/Table'
import { useAction } from '../../hooks/useAction'
import { useApiQuery } from '../../hooks/useApiQuery'
import { getMatrix, reviseMatrix } from '../../services/matrixApi'
import type { MatrixDetail } from '../../types/api'
import { formatDate } from '../../utils/format'
import { parseId } from '../../utils/params'
import { useCurrentUser } from '../auth/AuthContext'
import { canReadMatrices } from '../auth/permissions'
import { AccessDenied } from '../auth/RequireAuth'
import { InvalidLink } from '../common/InvalidLink'
import { MatrixStatusBadge } from './controls'
import { attributeValueLabel, effectiveLabel, VERSION_SOURCE } from './matrixLabels'

/** /matrices/:matrixId */
export function MatrixDetailPage() {
        const matrixId = parseId(useParams().matrixId)
        const user = useCurrentUser()
        const query = useApiQuery(
                matrixId !== undefined && canReadMatrices(user) ? `matrix|${matrixId}` : null,
                (signal) => getMatrix(matrixId!, signal),
        )
        if (matrixId === undefined)
                return <InvalidLink backTo="/matrices" backLabel="Back to matrices" />
        if (!canReadMatrices(user)) return <AccessDenied />
        if (query.isLoading) return <LoadingState label="Loading the matrix…" />
        if (query.error !== undefined || !query.data) {
                return (
                        <>
                                <PageHeader
                                        title="Matrix"
                                        breadcrumbs={[
                                                { label: 'Matrices', to: '/matrices' },
                                                { label: 'Matrix' },
                                        ]}
                                />
                                <ErrorState error={query.error} onRetry={query.reload} />
                        </>
                )
        }
        return <MatrixView matrix={query.data} />
}

function MatrixView({ matrix }: { matrix: MatrixDetail }) {
        const navigate = useNavigate()
        const revise = useAction()
        const open = matrix.open_version

        async function handleRevise() {
                const version = await revise.run(() => reviseMatrix(matrix.id))
                if (version) navigate(`/matrices/${matrix.id}/versions/${version.id}/edit`)
        }

        return (
                <>
                        <PageHeader
                                title={matrix.name}
                                description={matrix.description ?? undefined}
                                breadcrumbs={[
                                        { label: 'Matrices', to: '/matrices' },
                                        { label: matrix.name },
                                ]}
                                meta={
                                        <>
                                                <Badge>{matrix.code}</Badge>
                                                <Badge tone="info">{matrix.type_name}</Badge>
                                                {Object.entries(matrix.attributes).map(
                                                        ([key, value]) => (
                                                                <Badge key={key} tone="brand">
                                                                        {attributeValueLabel(value)}
                                                                </Badge>
                                                        ),
                                                )}
                                        </>
                                }
                                actions={
                                        matrix.can_revise ? (
                                                <Button
                                                        variant="primary"
                                                        isLoading={revise.busy}
                                                        onClick={handleRevise}
                                                >
                                                        <GitBranchPlus
                                                                aria-hidden="true"
                                                                className="size-4"
                                                        />
                                                        Start a new revision
                                                </Button>
                                        ) : undefined
                                }
                        />
                        <div className="space-y-4">
                                <ActionError
                                        error={revise.error}
                                        title="The revision was not started"
                                />
                                {matrix.policy_note && (
                                        <Alert tone="warning">{matrix.policy_note}</Alert>
                                )}
                                <section
                                        aria-labelledby="status-heading"
                                        className={`${cardClasses} space-y-2 p-4`}
                                >
                                        <h2
                                                id="status-heading"
                                                className="text-base font-semibold text-slate-900"
                                        >
                                                Status
                                        </h2>
                                        <dl className="grid grid-cols-1 gap-3 text-sm sm:grid-cols-3">
                                                <div>
                                                        <dt className="font-medium text-slate-700">
                                                                In force today
                                                        </dt>
                                                        <dd>
                                                                {matrix.in_force ? (
                                                                        <Link
                                                                                to={`/matrices/${matrix.id}/versions/${matrix.in_force.id}`}
                                                                                className={
                                                                                        linkClasses
                                                                                }
                                                                        >
                                                                                Version{' '}
                                                                                {
                                                                                        matrix
                                                                                                .in_force
                                                                                                .version_no
                                                                                }{' '}
                                                                                ·{' '}
                                                                                {effectiveLabel(
                                                                                        matrix.in_force,
                                                                                )}
                                                                        </Link>
                                                                ) : (
                                                                        'No published version is in force'
                                                                )}
                                                        </dd>
                                                </div>
                                                <div>
                                                        <dt className="font-medium text-slate-700">
                                                                Open version
                                                        </dt>
                                                        <dd>
                                                                {open ? (
                                                                        <Link
                                                                                to={`/matrices/${matrix.id}/versions/${open.id}`}
                                                                                className={
                                                                                        linkClasses
                                                                                }
                                                                        >
                                                                                Version{' '}
                                                                                {open.version_no} (
                                                                                {open.status ===
                                                                                'DRAFT'
                                                                                        ? 'draft'
                                                                                        : 'submitted'}
                                                                                )
                                                                        </Link>
                                                                ) : (
                                                                        'None'
                                                                )}
                                                        </dd>
                                                </div>
                                                {matrix.policy && (
                                                        <div>
                                                                <dt className="font-medium text-slate-700">
                                                                        Scoring policy
                                                                </dt>
                                                                <dd>
                                                                        <Link
                                                                                to="/kpi/policies"
                                                                                className={
                                                                                        linkClasses
                                                                                }
                                                                        >
                                                                                {matrix.policy.name}{' '}
                                                                                (
                                                                                {matrix.policy.code}
                                                                                )
                                                                        </Link>
                                                                </dd>
                                                        </div>
                                                )}
                                        </dl>
                                        {!matrix.can_revise && matrix.can_write && open && (
                                                <p className="text-sm text-slate-700">
                                                        Finish or withdraw the open version before
                                                        starting another revision.
                                                </p>
                                        )}
                                </section>

                                <section aria-labelledby="history-heading" className="space-y-2">
                                        <h2
                                                id="history-heading"
                                                className="text-base font-semibold text-slate-900"
                                        >
                                                Version history
                                        </h2>
                                        <p className="text-sm text-slate-700">
                                                Every change is a new version. Published versions
                                                are never edited, and a version stays attached to
                                                the KPI sheets that froze it.
                                        </p>
                                        <Table caption="Version history">
                                                <thead>
                                                        <tr>
                                                                <Th>Version</Th>
                                                                <Th>Status</Th>
                                                                <Th>In force</Th>
                                                                <Th className="hidden md:table-cell">
                                                                        Change
                                                                </Th>
                                                                <Th className="hidden lg:table-cell">
                                                                        Source
                                                                </Th>
                                                                <Th>Sign-off</Th>
                                                        </tr>
                                                </thead>
                                                <TBody>
                                                        {matrix.versions.map((v) => (
                                                                <tr key={v.id}>
                                                                        <Td>
                                                                                <Link
                                                                                        to={`/matrices/${matrix.id}/versions/${v.id}`}
                                                                                        className={
                                                                                                linkClasses
                                                                                        }
                                                                                >
                                                                                        Version{' '}
                                                                                        {
                                                                                                v.version_no
                                                                                        }
                                                                                </Link>
                                                                        </Td>
                                                                        <Td>
                                                                                <MatrixStatusBadge
                                                                                        status={
                                                                                                v.status
                                                                                        }
                                                                                />
                                                                        </Td>
                                                                        <Td>{effectiveLabel(v)}</Td>
                                                                        <Td className="hidden md:table-cell">
                                                                                {v.change_summary ??
                                                                                        '—'}
                                                                        </Td>
                                                                        <Td className="hidden lg:table-cell">
                                                                                {
                                                                                        VERSION_SOURCE[
                                                                                                v
                                                                                                        .source
                                                                                        ]
                                                                                }
                                                                        </Td>
                                                                        <Td>
                                                                                {v.approved_by
                                                                                        ? `Approved by ${v.approved_by.username}, ${formatDate(v.approved_at)}`
                                                                                        : v.rejected_by
                                                                                          ? `Rejected by ${v.rejected_by.username}, ${formatDate(v.rejected_at)}`
                                                                                          : v.submitted_by
                                                                                            ? `Submitted by ${v.submitted_by.username}`
                                                                                            : '—'}
                                                                        </Td>
                                                                </tr>
                                                        ))}
                                                </TBody>
                                        </Table>
                                </section>
                                <Link to="/matrices" className={buttonClasses('secondary')}>
                                        Back to matrices
                                </Link>
                        </div>
                </>
        )
}
