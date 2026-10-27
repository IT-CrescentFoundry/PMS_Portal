import { FilePen } from 'lucide-react'
import { Link } from 'react-router'
import { Badge } from '../../components/common/Badge'
import { ErrorState, LoadingState } from '../../components/common/QueryStates'
import { buttonClasses, cardClasses, linkClasses } from '../../components/common/styles'
import { useApiQuery } from '../../hooks/useApiQuery'
import { listQuarterVersions } from '../../services/correctionsApi'
import type { QuarterOverview } from '../../types/api'
import { formatDate } from '../../utils/format'
import { CORRECTION_STATUS } from '../annual/annualLabels'

/** A published quarter's versions, its open correction, and the way to request one. */
export function QuarterVersions({ overview }: { overview: QuarterOverview }) {
        const q = overview.quarter.id
        const versions = useApiQuery(
                `quarter-versions|${q}|${overview.published_version}`,
                (signal) => listQuarterVersions(q, signal),
        )
        const open = overview.open_correction
        return (
                <section
                        aria-labelledby="versions-heading"
                        className={`${cardClasses} space-y-3 p-4`}
                >
                        <h2
                                id="versions-heading"
                                className="text-base font-semibold text-slate-900"
                        >
                                Published versions and corrections
                        </h2>
                        <p className="text-sm text-slate-700">
                                A published quarter never changes. A correction requested by an HR
                                Head and approved by the CHRO becomes a new version, reviewed and
                                published again; earlier versions stay available.
                        </p>
                        {versions.isLoading ? (
                                <LoadingState label="Loading versions…" />
                        ) : versions.error !== undefined || !versions.data ? (
                                <ErrorState error={versions.error} onRetry={versions.reload} />
                        ) : (
                                <ol aria-label="Published versions" className="space-y-1 text-sm">
                                        {versions.data.map((v) => (
                                                <li
                                                        key={v.version_no}
                                                        className="flex flex-wrap items-center gap-2"
                                                >
                                                        <span className="font-medium text-slate-900">
                                                                Version {v.version_no}
                                                        </span>
                                                        {v.current ? (
                                                                <Badge tone="success">
                                                                        Current
                                                                </Badge>
                                                        ) : (
                                                                <Badge>Superseded</Badge>
                                                        )}
                                                        <span className="text-slate-600">
                                                                published by{' '}
                                                                {v.published_by?.username ?? '—'} on{' '}
                                                                {formatDate(v.published_at)}
                                                        </span>
                                                        {v.correction_id && (
                                                                <Link
                                                                        to={`/scores/corrections/${v.correction_id}`}
                                                                        className={linkClasses}
                                                                >
                                                                        Correction {v.correction_id}
                                                                </Link>
                                                        )}
                                                </li>
                                        ))}
                                </ol>
                        )}
                        {open && (
                                <p className="flex flex-wrap items-center gap-2 text-sm">
                                        <Link
                                                to={`/scores/corrections/${open.id}`}
                                                className={linkClasses}
                                        >
                                                Correction {open.id}
                                        </Link>
                                        <Badge tone={CORRECTION_STATUS[open.status].tone}>
                                                {CORRECTION_STATUS[open.status].label}
                                        </Badge>
                                </p>
                        )}
                        {overview.actions.can_request_correction && (
                                <Link
                                        to={`/scores/corrections/new?quarter=${q}`}
                                        className={buttonClasses('secondary', 'sm')}
                                >
                                        <FilePen aria-hidden="true" className="size-4" />
                                        Request a correction…
                                </Link>
                        )}
                </section>
        )
}
