import { CheckCircle2, XCircle } from 'lucide-react'
import { Alert } from '../../components/common/Alert'
import { Table, TBody, Td, Th } from '../../components/tables/Table'
import type { MatrixField, MatrixProblem, MatrixReport, MatrixVersionCheck } from '../../types/api'
import { plural } from '../../utils/format'
import { describeValues, problemLocation } from './matrixLabels'

type Report = MatrixReport & Partial<Pick<MatrixVersionCheck, 'readiness' | 'ready_to_submit'>>

function ProblemList({ problems }: { problems: MatrixProblem[] }) {
        return (
                <ul className="list-disc space-y-0.5 pl-5">
                        {problems.map((p, index) => (
                                <li key={index}>
                                        {p.path && (
                                                <span className="font-medium">
                                                        {problemLocation(p.path)}:{' '}
                                                </span>
                                        )}
                                        {p.message}
                                </li>
                        ))}
                </ul>
        )
}

/** The rule engine's verdict: errors, readiness, warnings, uncovered values and tests. */
export function CheckReport({
        report,
        fields,
        headingId,
        heading = 'Check results',
        showStatus = true,
}: {
        report: Report
        fields: MatrixField[]
        headingId: string
        heading?: string
        /** False when the caller already shows the overall verdict. */
        showStatus?: boolean
}) {
        const readiness = report.readiness ?? []
        const coveredByWarning = report.warnings.some((w) => w.path.startsWith('no_match'))
        return (
                <section aria-labelledby={headingId} className="space-y-3">
                        <h3 id={headingId} className="text-base font-semibold text-slate-900">
                                {heading}
                        </h3>
                        {!showStatus ? null : report.errors.length > 0 ? (
                                <Alert
                                        tone="danger"
                                        assertive
                                        title={`${plural(report.errors.length, 'problem')} to fix`}
                                >
                                        <ProblemList problems={report.errors} />
                                </Alert>
                        ) : readiness.length > 0 ? (
                                <Alert
                                        tone="warning"
                                        title="The rules are valid. Before submitting:"
                                >
                                        <ProblemList problems={readiness} />
                                </Alert>
                        ) : (
                                <Alert
                                        title={
                                                report.ready_to_submit
                                                        ? 'No problems found · ready to submit for approval'
                                                        : 'No problems found'
                                        }
                                />
                        )}
                        {report.warnings.length > 0 && (
                                <Alert
                                        tone="warning"
                                        title={plural(report.warnings.length, 'warning')}
                                >
                                        <ProblemList problems={report.warnings} />
                                </Alert>
                        )}
                        {report.gaps.length > 0 && !coveredByWarning && (
                                <Alert title="Values no rule covers">
                                        <p>
                                                The “when no rule matches” setting applies to:{' '}
                                                {report.gaps.join('; ')}.
                                        </p>
                                </Alert>
                        )}
                        {report.test_results.length > 0 && (
                                <Table caption="Test case results">
                                        <thead>
                                                <tr>
                                                        <Th>Test case</Th>
                                                        <Th>Expected</Th>
                                                        <Th>Result</Th>
                                                        <Th>Outcome</Th>
                                                </tr>
                                        </thead>
                                        <TBody>
                                                {report.test_results.map((t, index) => (
                                                        <tr key={index}>
                                                                <Td>{t.label}</Td>
                                                                <Td>
                                                                        {describeValues(
                                                                                fields,
                                                                                t.expected,
                                                                        )}
                                                                </Td>
                                                                <Td>
                                                                        {t.error ??
                                                                                `${describeValues(fields, t.actual)}${t.rule !== null ? ` (rule ${t.rule})` : ' (default output)'}`}
                                                                </Td>
                                                                <Td>
                                                                        {t.passed ? (
                                                                                <span className="inline-flex items-center gap-1 font-medium text-emerald-800">
                                                                                        <CheckCircle2
                                                                                                aria-hidden="true"
                                                                                                className="size-4"
                                                                                        />
                                                                                        Passed
                                                                                </span>
                                                                        ) : (
                                                                                <span className="inline-flex items-center gap-1 font-medium text-red-700">
                                                                                        <XCircle
                                                                                                aria-hidden="true"
                                                                                                className="size-4"
                                                                                        />
                                                                                        Failed
                                                                                </span>
                                                                        )}
                                                                </Td>
                                                        </tr>
                                                ))}
                                        </TBody>
                                </Table>
                        )}
                </section>
        )
}
