import { Link } from 'react-router'
import { Badge } from '../../components/common/Badge'
import { linkClasses } from '../../components/common/styles'
import { Table, TBody, Td, Th } from '../../components/tables/Table'
import type { ResultVersion } from '../../types/api'
import { formatDate } from '../../utils/format'
import { RESULT_STATUS, scoreText } from '../scores/scoreLabels'

/** Every version of a KPI sheet's result: the original and each correction. */
export function ResultVersions({ versions }: { versions: ResultVersion[] }) {
        if (versions.length < 2) return null
        return (
                <section aria-labelledby="result-versions-heading" className="space-y-2">
                        <h2
                                id="result-versions-heading"
                                className="text-base font-semibold text-slate-900"
                        >
                                Result versions
                        </h2>
                        <Table caption="Versions of this result">
                                <thead>
                                        <tr>
                                                <Th>Version</Th>
                                                <Th>Status</Th>
                                                <Th align="right">Final score</Th>
                                                <Th align="right">Published score</Th>
                                                <Th>Published</Th>
                                                <Th>Correction</Th>
                                        </tr>
                                </thead>
                                <TBody>
                                        {versions.map((v) => (
                                                <tr key={v.version_no}>
                                                        <Td>{v.version_no}</Td>
                                                        <Td>
                                                                <Badge
                                                                        tone={
                                                                                RESULT_STATUS[
                                                                                        v.status
                                                                                ].tone
                                                                        }
                                                                >
                                                                        {
                                                                                RESULT_STATUS[
                                                                                        v.status
                                                                                ].label
                                                                        }
                                                                </Badge>
                                                        </Td>
                                                        <Td align="right">
                                                                {scoreText(
                                                                        v.override_score ??
                                                                                v.final_score,
                                                                )}
                                                        </Td>
                                                        <Td align="right">
                                                                {scoreText(v.published_score)}
                                                        </Td>
                                                        <Td>
                                                                {v.published_at
                                                                        ? formatDate(v.published_at)
                                                                        : '—'}
                                                        </Td>
                                                        <Td>
                                                                {v.correction_id ? (
                                                                        <Link
                                                                                to={`/scores/corrections/${v.correction_id}`}
                                                                                className={
                                                                                        linkClasses
                                                                                }
                                                                        >
                                                                                Correction{' '}
                                                                                {v.correction_id}
                                                                        </Link>
                                                                ) : (
                                                                        'Original'
                                                                )}
                                                        </Td>
                                                </tr>
                                        ))}
                                </TBody>
                        </Table>
                </section>
        )
}
