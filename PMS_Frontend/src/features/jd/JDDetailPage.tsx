import { CheckCircle2, Circle, Pencil } from 'lucide-react'
import { useState, type ReactNode } from 'react'
import { Link, useNavigate, useParams, useSearchParams } from 'react-router'
import { ActionError } from '../../components/common/ActionError'
import { Alert } from '../../components/common/Alert'
import { Badge } from '../../components/common/Badge'
import { Button } from '../../components/common/Button'
import { PageHeader } from '../../components/common/PageHeader'
import { ErrorState, LoadingState } from '../../components/common/QueryStates'
import { ReasonForm } from '../../components/common/ReasonForm'
import { buttonClasses, cardClasses } from '../../components/common/styles'
import { Table, TBody, Td, Th } from '../../components/tables/Table'
import { useAction } from '../../hooks/useAction'
import { useApiQuery } from '../../hooks/useApiQuery'
import {
        getJD,
        getJDVersion,
        returnJDVersion,
        signOffJDVersion,
        startJDRevision,
        type SignOffStep,
} from '../../services/jdApi'
import type { Competency, JDDetail, JDVersion, UserRef } from '../../types/api'
import { formatDate } from '../../utils/format'
import { parseId, withParams } from '../../utils/params'
import { useCurrentUser } from '../auth/AuthContext'
import { canApproveJD, canAuthoriseJD, canWriteJD } from '../auth/permissions'
import { InvalidLink } from '../common/InvalidLink'
import { E_SCALE, NATURE_OF_JOB, VACANCY_TYPES } from './jdLabels'
import { JDStatusBadge } from './JDStatusBadge'

export function JDDetailPage() {
        const jdId = parseId(useParams().jdId)
        const [params, setParams] = useSearchParams()
        const requestedVersion = parseId(params.get('version'))
        const [reloadKey, setReloadKey] = useState(0)

        const jd = useApiQuery(jdId === undefined ? null : `jd|${jdId}|${reloadKey}`, (signal) =>
                getJD(jdId!, signal),
        )
        const versionId =
                requestedVersion ??
                jd.data?.open_version?.id ??
                jd.data?.approved_version?.id ??
                jd.data?.versions[0]?.id
        const version = useApiQuery(
                jdId === undefined || versionId === undefined
                        ? null
                        : `jd-version|${jdId}|${versionId}|${reloadKey}`,
                (signal) => getJDVersion(jdId!, versionId!, signal),
        )

        if (jdId === undefined)
                return <InvalidLink backTo="/jds" backLabel="Back to job descriptions" />
        if (jd.isLoading || (jd.data && version.isLoading && !version.data))
                return <LoadingState label="Loading job description…" />
        const failure = jd.error ?? version.error
        if (failure !== undefined || !jd.data || !version.data) {
                return (
                        <>
                                <PageHeader
                                        title="Job description"
                                        breadcrumbs={[
                                                {
                                                        label: 'Job descriptions',
                                                        to: '/jds',
                                                },
                                                { label: 'Job description' },
                                        ]}
                                />
                                <ErrorState
                                        error={failure}
                                        onRetry={() => setReloadKey((k) => k + 1)}
                                        action={
                                                <Link
                                                        to="/jds"
                                                        className={buttonClasses('secondary')}
                                                >
                                                        Back to job descriptions
                                                </Link>
                                        }
                                />
                        </>
                )
        }

        return (
                <JDView
                        jd={jd.data}
                        version={version.data}
                        onSelectVersion={(id) => setParams(withParams(params, { version: id }))}
                        onChanged={(next) => {
                                setParams(withParams(params, { version: next }))
                                setReloadKey((k) => k + 1)
                        }}
                />
        )
}

interface JDViewProps {
        jd: JDDetail
        version: JDVersion
        onSelectVersion: (versionId: number) => void
        /** After a sign-off or revision: show `versionId` and refresh. */
        onChanged: (versionId: number) => void
}

function JDView({ jd, version, onSelectVersion, onChanged }: JDViewProps) {
        return (
                <>
                        <PageHeader
                                title={jd.title}
                                breadcrumbs={[
                                        {
                                                label: 'Job descriptions',
                                                to: '/jds',
                                        },
                                        { label: jd.title },
                                ]}
                                meta={
                                        <>
                                                <Badge>{jd.code}</Badge>
                                                <span className="text-sm text-slate-700">
                                                        {jd.department.name} ·{' '}
                                                        {jd.plant?.name ?? 'All plants'}
                                                </span>
                                                {jd.designation && (
                                                        <span className="text-sm text-slate-700">
                                                                Designation: {jd.designation.name}
                                                        </span>
                                                )}
                                        </>
                                }
                        />
                        <div className="grid grid-cols-1 gap-6 lg:grid-cols-[16rem_1fr]">
                                <aside className="space-y-4">
                                        <nav aria-label="Versions" className={`${cardClasses} p-3`}>
                                                <h2 className="mb-2 text-sm font-semibold text-slate-900">
                                                        Versions
                                                </h2>
                                                <ul className="space-y-1">
                                                        {jd.versions.map((v) => (
                                                                <li key={v.id}>
                                                                        <button
                                                                                type="button"
                                                                                onClick={() =>
                                                                                        onSelectVersion(
                                                                                                v.id,
                                                                                        )
                                                                                }
                                                                                aria-current={
                                                                                        v.id ===
                                                                                        version.id
                                                                                                ? 'true'
                                                                                                : undefined
                                                                                }
                                                                                className={`w-full rounded-md px-2 py-1.5 text-left hover:bg-slate-50 ${v.id === version.id ? 'bg-brand-50 ring-1 ring-brand-200' : ''}`}
                                                                        >
                                                                                <JDStatusBadge
                                                                                        version={v}
                                                                                />
                                                                                <span className="mt-0.5 block text-xs text-slate-600">
                                                                                        Effective{' '}
                                                                                        {formatDate(
                                                                                                v.effective_date,
                                                                                                'date not set',
                                                                                        )}
                                                                                </span>
                                                                        </button>
                                                                </li>
                                                        ))}
                                                </ul>
                                        </nav>
                                        <SignOffPanel version={version} />
                                </aside>
                                <div className="min-w-0 space-y-6">
                                        <WorkflowActions
                                                jd={jd}
                                                version={version}
                                                onChanged={onChanged}
                                        />
                                        <JDContentView version={version} />
                                </div>
                        </div>
                </>
        )
}

const STEPS: {
        label: string
        who: string
        by: keyof JDVersion
        at: keyof JDVersion
}[] = [
        { label: 'Proposed', who: 'HOD', by: 'proposed_by', at: 'proposed_at' },
        {
                label: 'Authorised',
                who: 'Plant Head',
                by: 'authorised_by',
                at: 'authorised_at',
        },
        {
                label: 'Approved',
                who: 'COO / CHRO',
                by: 'approved_by',
                at: 'approved_at',
        },
]

function SignOffPanel({ version }: { version: JDVersion }) {
        return (
                <section aria-labelledby="sign-off-heading" className={`${cardClasses} p-3`}>
                        <h2
                                id="sign-off-heading"
                                className="mb-2 text-sm font-semibold text-slate-900"
                        >
                                Sign-off
                        </h2>
                        <ol className="space-y-2">
                                {STEPS.map((step) => {
                                        const by = version[step.by] as UserRef | null
                                        const at = version[step.at] as string | null
                                        return (
                                                <li key={step.label} className="flex gap-2 text-sm">
                                                        {by ? (
                                                                <CheckCircle2
                                                                        aria-hidden="true"
                                                                        className="mt-0.5 size-4 shrink-0 text-emerald-700"
                                                                />
                                                        ) : (
                                                                <Circle
                                                                        aria-hidden="true"
                                                                        className="mt-0.5 size-4 shrink-0 text-slate-400"
                                                                />
                                                        )}
                                                        <div>
                                                                <p className="font-medium text-slate-900">
                                                                        {step.label} by {step.who}
                                                                </p>
                                                                <p className="text-slate-600">
                                                                        {by
                                                                                ? `${by.username}, ${formatDate(at)}`
                                                                                : 'Pending'}
                                                                </p>
                                                        </div>
                                                </li>
                                        )
                                })}
                        </ol>
                </section>
        )
}

function WorkflowActions({
        jd,
        version,
        onChanged,
}: {
        jd: JDDetail
        version: JDVersion
        onChanged: (versionId: number) => void
}) {
        const user = useCurrentUser()
        const navigate = useNavigate()
        const action = useAction()
        const [returning, setReturning] = useState(false)

        const status = version.status
        const canEdit = status === 'DRAFT' && canWriteJD(user)
        const canPropose = status === 'DRAFT' && canWriteJD(user)
        const canAuthorise = status === 'PROPOSED' && canAuthoriseJD(user)
        const canApprove = status === 'AUTHORISED' && canApproveJD(user)
        const canReturn =
                (status === 'PROPOSED' && (canAuthoriseJD(user) || canApproveJD(user))) ||
                (status === 'AUTHORISED' && canApproveJD(user))
        const canRevise = status === 'APPROVED' && jd.open_version === null && canWriteJD(user)

        async function step(name: SignOffStep) {
                const done = await action.run(() => signOffJDVersion(jd.id, version.id, name))
                if (done) onChanged(done.id)
        }

        async function revise() {
                const created = await action.run(() => startJDRevision(jd.id))
                if (created) navigate(`/jds/${jd.id}/versions/${created.id}/edit`)
        }

        async function sendBack(reason: string) {
                const done = await action.run(() => returnJDVersion(jd.id, version.id, reason))
                if (done) {
                        setReturning(false)
                        onChanged(done.id)
                }
        }

        const nothingToDo =
                !canEdit && !canPropose && !canAuthorise && !canApprove && !canReturn && !canRevise

        return (
                <section aria-label="Actions" className="space-y-3">
                        {status === 'DRAFT' && version.returned_reason && (
                                <Alert tone="warning" title="Returned for changes">
                                        {version.returned_reason}
                                </Alert>
                        )}
                        {status === 'SUPERSEDED' && (
                                <Alert>
                                        This version has been replaced by a later approved version.
                                        It is kept for the record and cannot change.
                                </Alert>
                        )}
                        <ActionError
                                error={action.error}
                                title="The action could not be completed"
                        />
                        {!nothingToDo && (
                                <div className="flex flex-wrap gap-2">
                                        {canEdit && (
                                                <Link
                                                        to={`/jds/${jd.id}/versions/${version.id}/edit`}
                                                        className={buttonClasses('secondary')}
                                                >
                                                        <Pencil
                                                                aria-hidden="true"
                                                                className="size-4"
                                                        />
                                                        Edit draft
                                                </Link>
                                        )}
                                        {canPropose && (
                                                <Button
                                                        variant="primary"
                                                        isLoading={action.busy}
                                                        onClick={() => step('propose')}
                                                >
                                                        Propose (HOD)
                                                </Button>
                                        )}
                                        {canAuthorise && (
                                                <Button
                                                        variant="primary"
                                                        isLoading={action.busy}
                                                        onClick={() => step('authorise')}
                                                >
                                                        Authorise (Plant Head)
                                                </Button>
                                        )}
                                        {canApprove && (
                                                <Button
                                                        variant="primary"
                                                        isLoading={action.busy}
                                                        onClick={() => step('approve')}
                                                >
                                                        Approve (CHRO)
                                                </Button>
                                        )}
                                        {canReturn && !returning && (
                                                <Button
                                                        disabled={action.busy}
                                                        onClick={() => setReturning(true)}
                                                >
                                                        Return to draft
                                                </Button>
                                        )}
                                        {canRevise && (
                                                <Button
                                                        variant="primary"
                                                        isLoading={action.busy}
                                                        onClick={revise}
                                                >
                                                        Start a new revision
                                                </Button>
                                        )}
                                </div>
                        )}
                        {returning && (
                                <ReasonForm
                                        label="What needs to change?"
                                        hint="The author sees this reason on the returned draft."
                                        submitLabel="Return to draft"
                                        busy={action.busy}
                                        onSubmit={sendBack}
                                        onCancel={() => setReturning(false)}
                                />
                        )}
                </section>
        )
}

function Fact({ label, children }: { label: string; children: ReactNode }) {
        return (
                <div>
                        <dt className="text-xs font-medium tracking-wide text-slate-600 uppercase">
                                {label}
                        </dt>
                        <dd className="mt-0.5 text-sm whitespace-pre-line text-slate-900">
                                {children === null || children === undefined || children === ''
                                        ? '—'
                                        : children}
                        </dd>
                </div>
        )
}

function Block({ title, children }: { title: string; children: ReactNode }) {
        return (
                <section className={`${cardClasses} p-4`}>
                        <h2 className="mb-3 text-base font-semibold text-slate-900">{title}</h2>
                        {children}
                </section>
        )
}

function JDContentView({ version }: { version: JDVersion }) {
        return (
                <>
                        <Block title="Document control">
                                <dl className="grid grid-cols-1 gap-4 sm:grid-cols-3">
                                        <Fact label="Format no.">{version.format_no}</Fact>
                                        <Fact label="Rev / issue no.">{version.rev_issue_no}</Fact>
                                        <Fact label="Effective date">
                                                {formatDate(version.effective_date)}
                                        </Fact>
                                </dl>
                        </Block>
                        <Block title="Manpower requisition">
                                <dl className="grid grid-cols-1 gap-4 sm:grid-cols-3">
                                        <Fact label="No. of vacancies">{version.vacancies}</Fact>
                                        <Fact label="Vacancy type">
                                                {version.vacancy_type &&
                                                        VACANCY_TYPES[version.vacancy_type]}
                                        </Fact>
                                        <Fact label="Nature of job">
                                                {version.nature_of_job &&
                                                        NATURE_OF_JOB[version.nature_of_job]}
                                        </Fact>
                                        {version.vacancy_type === 'REPLACEMENT' && (
                                                <Fact label="Replacement of">
                                                        {version.replacement_of}
                                                </Fact>
                                        )}
                                        <div className="sm:col-span-3">
                                                <Fact label="Reason for hiring">
                                                        {version.hiring_reason}
                                                </Fact>
                                        </div>
                                </dl>
                        </Block>
                        <Block title="Candidate requirements">
                                <dl className="grid grid-cols-1 gap-4 sm:grid-cols-3">
                                        <Fact label="Proposed CTC">{version.proposed_ctc}</Fact>
                                        <Fact label="Available budget (HR)">
                                                {version.available_budget}
                                        </Fact>
                                        <Fact label="Minimum qualification">
                                                {version.min_qualification}
                                        </Fact>
                                        <Fact label="Work experience">
                                                {version.work_experience}
                                        </Fact>
                                        <Fact label="Languages">{version.languages}</Fact>
                                        <Fact label="Age band & gender">
                                                {version.age_band_gender}
                                        </Fact>
                                </dl>
                        </Block>
                        <Block title="Job relationship">
                                <dl className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                                        <Fact label="Reports to">{version.reports_to}</Fact>
                                        <Fact label="Supervises">{version.supervises}</Fact>
                                </dl>
                        </Block>
                        <Block title="Key responsibilities">
                                {version.responsibilities.length === 0 ? (
                                        <p className="text-sm text-slate-600">None recorded yet.</p>
                                ) : (
                                        <div className="space-y-4">
                                                {version.responsibilities.map((section, index) => (
                                                        <div key={index}>
                                                                <h3 className="text-sm font-semibold text-slate-900">
                                                                        {section.heading}
                                                                </h3>
                                                                <ul className="mt-1 list-disc space-y-0.5 pl-5 text-sm text-slate-800">
                                                                        {section.points.map(
                                                                                (point, i) => (
                                                                                        <li key={i}>
                                                                                                {
                                                                                                        point
                                                                                                }
                                                                                        </li>
                                                                                ),
                                                                        )}
                                                                </ul>
                                                        </div>
                                                ))}
                                        </div>
                                )}
                        </Block>
                        <div className="grid grid-cols-1 gap-6 xl:grid-cols-2">
                                <CompetencyTable
                                        title="Technical competencies"
                                        rows={version.technical_competencies}
                                />
                                <CompetencyTable
                                        title="Behavioural competencies"
                                        rows={version.behavioural_competencies}
                                />
                        </div>
                        <Block title="Remarks by HR">
                                <p className="text-sm whitespace-pre-line text-slate-800">
                                        {version.hr_remarks || '—'}
                                </p>
                        </Block>
                </>
        )
}

function CompetencyTable({ title, rows }: { title: string; rows: Competency[] }) {
        return (
                <section className="space-y-2">
                        <h2 className="text-base font-semibold text-slate-900">{title}</h2>
                        {rows.length === 0 ? (
                                <p className={`${cardClasses} p-4 text-sm text-slate-600`}>
                                        None recorded yet.
                                </p>
                        ) : (
                                <Table caption={title}>
                                        <thead>
                                                <tr>
                                                        <Th>Competency</Th>
                                                        <Th>Required level (E-Scale)</Th>
                                                </tr>
                                        </thead>
                                        <TBody>
                                                {rows.map((row, index) => (
                                                        <tr key={index}>
                                                                <Td>{row.name}</Td>
                                                                <Td>
                                                                        {E_SCALE[row.level] ??
                                                                                row.level}
                                                                </Td>
                                                        </tr>
                                                ))}
                                        </TBody>
                                </Table>
                        )}
                </section>
        )
}
