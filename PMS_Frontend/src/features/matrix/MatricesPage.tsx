import { FileSpreadsheet, Plus } from 'lucide-react'
import { Link, useSearchParams } from 'react-router'
import { Alert } from '../../components/common/Alert'
import { Badge } from '../../components/common/Badge'
import { SelectField, TextField } from '../../components/common/Fields'
import { PageHeader } from '../../components/common/PageHeader'
import { EmptyState, ErrorState, LoadingState } from '../../components/common/QueryStates'
import { buttonClasses, cardClasses, linkClasses } from '../../components/common/styles'
import { Table, TBody, Td, Th } from '../../components/tables/Table'
import { useApiQuery } from '../../hooks/useApiQuery'
import { listMatrices, listMatrixTypes } from '../../services/matrixApi'
import type { MatrixTypeMeta, MatrixVersionStatus } from '../../types/api'
import { withParams } from '../../utils/params'
import { useCurrentUser } from '../auth/AuthContext'
import { canReadMatrices, canWriteMatrices } from '../auth/permissions'
import { AccessDenied } from '../auth/RequireAuth'
import { MatrixStatusBadge } from './controls'
import { effectiveLabel, VERSION_STATUS } from './matrixLabels'

const STATUSES = Object.keys(VERSION_STATUS) as MatrixVersionStatus[]

/** /matrices */
export function MatricesPage() {
        const user = useCurrentUser()
        const allowed = canReadMatrices(user)
        const [params, setParams] = useSearchParams()
        const type = params.get('type') ?? ''
        const status = (params.get('status') ?? '') as MatrixVersionStatus | ''
        const search = params.get('q') ?? ''
        const types = useApiQuery(allowed ? 'matrix-types' : null, (signal) =>
                listMatrixTypes(signal),
        )
        const matrices = useApiQuery(
                allowed ? `matrices|${type}|${status}|${search}` : null,
                (signal) =>
                        listMatrices(
                                {
                                        matrixType: type || undefined,
                                        status: status || undefined,
                                        search: search || undefined,
                                },
                                signal,
                        ),
                { keepPreviousData: true },
        )
        if (!allowed) return <AccessDenied />
        const writable = canWriteMatrices(user)
        const set = (updates: Record<string, string>) =>
                setParams(withParams(params, updates), { replace: true })

        return (
                <>
                        <PageHeader
                                title="Configurable matrices"
                                description="Rules that turn results into scores and ratings. The HR Head drafts each version in the portal or in Excel; the CHRO approves it before it can be published. Every change is a new version, and published versions are never edited."
                                actions={
                                        writable ? (
                                                <>
                                                        <Link
                                                                to="/matrices/upload"
                                                                className={buttonClasses(
                                                                        'secondary',
                                                                )}
                                                        >
                                                                <FileSpreadsheet
                                                                        aria-hidden="true"
                                                                        className="size-4"
                                                                />
                                                                Upload from Excel
                                                        </Link>
                                                        <Link
                                                                to="/matrices/new"
                                                                className={buttonClasses('primary')}
                                                        >
                                                                <Plus
                                                                        aria-hidden="true"
                                                                        className="size-4"
                                                                />
                                                                New matrix
                                                        </Link>
                                                </>
                                        ) : undefined
                                }
                        />
                        <div className="space-y-4">
                                {types.data && <AwaitingTypes types={types.data} />}
                                <div
                                        className={`${cardClasses} grid grid-cols-1 gap-4 p-4 md:grid-cols-3`}
                                >
                                        <SelectField
                                                label="Type"
                                                value={type}
                                                onChange={(e) => set({ type: e.target.value })}
                                                options={[
                                                        { value: '', label: 'All types' },
                                                        ...(types.data ?? []).map((t) => ({
                                                                value: t.code,
                                                                label: t.name,
                                                        })),
                                                ]}
                                        />
                                        <SelectField
                                                label="Latest version"
                                                value={status}
                                                onChange={(e) => set({ status: e.target.value })}
                                                options={[
                                                        { value: '', label: 'Any status' },
                                                        ...STATUSES.map((s) => ({
                                                                value: s,
                                                                label: VERSION_STATUS[s].label,
                                                        })),
                                                ]}
                                        />
                                        <TextField
                                                label="Search"
                                                type="search"
                                                placeholder="Name or code"
                                                defaultValue={search}
                                                onKeyDown={(e) => {
                                                        if (e.key === 'Enter')
                                                                set({
                                                                        q: e.currentTarget.value.trim(),
                                                                })
                                                }}
                                                onBlur={(e) =>
                                                        set({ q: e.currentTarget.value.trim() })
                                                }
                                        />
                                </div>
                                {matrices.isLoading ? (
                                        <LoadingState label="Loading matrices…" />
                                ) : matrices.error !== undefined || !matrices.data ? (
                                        <ErrorState
                                                error={matrices.error}
                                                onRetry={matrices.reload}
                                        />
                                ) : matrices.data.length === 0 ? (
                                        <EmptyState
                                                title={
                                                        type || status || search
                                                                ? 'No matrices match the filters'
                                                                : 'No matrices yet'
                                                }
                                                action={
                                                        writable && !(type || status || search) ? (
                                                                <Link
                                                                        to="/matrices/new"
                                                                        className={buttonClasses(
                                                                                'primary',
                                                                        )}
                                                                >
                                                                        Create the first matrix
                                                                </Link>
                                                        ) : undefined
                                                }
                                        />
                                ) : (
                                        <Table
                                                caption="Configurable matrices"
                                                busy={matrices.isStale}
                                        >
                                                <thead>
                                                        <tr>
                                                                <Th>Matrix</Th>
                                                                <Th className="hidden md:table-cell">
                                                                        Type
                                                                </Th>
                                                                <Th>Latest version</Th>
                                                                <Th>In force today</Th>
                                                                <Th className="hidden lg:table-cell">
                                                                        Used by
                                                                </Th>
                                                        </tr>
                                                </thead>
                                                <TBody>
                                                        {matrices.data.map((m) => (
                                                                <tr key={m.id}>
                                                                        <Td>
                                                                                <Link
                                                                                        to={`/matrices/${m.id}`}
                                                                                        className={
                                                                                                linkClasses
                                                                                        }
                                                                                >
                                                                                        {m.name}
                                                                                </Link>
                                                                                <div className="text-xs text-slate-600">
                                                                                        {m.code}
                                                                                </div>
                                                                        </Td>
                                                                        <Td className="hidden md:table-cell">
                                                                                {m.type_name}
                                                                        </Td>
                                                                        <Td>
                                                                                <div className="flex flex-wrap items-center gap-2">
                                                                                        <span>
                                                                                                v
                                                                                                {
                                                                                                        m
                                                                                                                .latest_version
                                                                                                                .version_no
                                                                                                }
                                                                                        </span>
                                                                                        <MatrixStatusBadge
                                                                                                status={
                                                                                                        m
                                                                                                                .latest_version
                                                                                                                .status
                                                                                                }
                                                                                        />
                                                                                </div>
                                                                        </Td>
                                                                        <Td>
                                                                                {m.in_force
                                                                                        ? `v${m.in_force.version_no} · ${effectiveLabel(m.in_force)}`
                                                                                        : '—'}
                                                                        </Td>
                                                                        <Td className="hidden lg:table-cell">
                                                                                {m.policy
                                                                                        ? `${m.policy.name} (${m.policy.code})`
                                                                                        : '—'}
                                                                        </Td>
                                                                </tr>
                                                        ))}
                                                </TBody>
                                        </Table>
                                )}
                        </div>
                </>
        )
}

/** Types prepared for later stages, shown without inventing any values. */
function AwaitingTypes({ types }: { types: MatrixTypeMeta[] }) {
        const awaiting = types.filter((t) => t.policy_note)
        if (awaiting.length === 0) return null
        return (
                <Alert tone="info" title="Prepared for later stages">
                        <ul className="list-disc space-y-1 pl-5">
                                {awaiting.map((t) => (
                                        <li key={t.code}>
                                                <span className="font-medium">{t.name}:</span>{' '}
                                                {t.policy_note} <Badge>{t.code}</Badge>
                                        </li>
                                ))}
                        </ul>
                </Alert>
        )
}
