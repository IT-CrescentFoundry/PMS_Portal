import { Table, TBody, Td, Th } from '../../components/tables/Table'
import type { MatrixField, MatrixRuleSummary } from '../../types/api'
import { describeValues } from './matrixLabels'

/** The rules in words, as the engine reads them ("more than 100 % → Score: 5"). */
export function RuleSummaryTable({
        rules,
        fields,
        caption = 'Rules in words',
}: {
        rules: MatrixRuleSummary[]
        fields: MatrixField[]
        caption?: string
}) {
        if (rules.length === 0) return <p className="text-sm text-slate-600">No rules yet.</p>
        return (
                <Table caption={caption}>
                        <thead>
                                <tr>
                                        <Th align="right">Priority</Th>
                                        <Th>Rule</Th>
                                        <Th>When</Th>
                                        <Th>Then</Th>
                                </tr>
                        </thead>
                        <TBody>
                                {rules.map((rule) => (
                                        <tr key={rule.priority}>
                                                <Td align="right">{rule.priority}</Td>
                                                <Td>{rule.label ?? '—'}</Td>
                                                <Td>{rule.description || 'Any value'}</Td>
                                                <Td>{describeValues(fields, rule.outputs)}</Td>
                                        </tr>
                                ))}
                        </TBody>
                </Table>
        )
}
