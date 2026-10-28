import { Link } from 'react-router'
import { linkClasses } from '../../components/common/styles'
import type { BudgetLine } from '../../types/api'
import { scoreText } from '../scores/scoreLabels'
import { EXCLUSIONS, MATRIX_TYPE_LABELS, money, percent } from './compensationLabels'

function values(record: Record<string, unknown>): string {
        const entries = Object.entries(record).filter(([, v]) => v !== null && v !== undefined)
        return entries.length ? entries.map(([k, v]) => `${k} = ${String(v)}`).join(', ') : '—'
}

/** How one employee's proposal was calculated, step by step, from the stored trace. */
export function ProposalExplanation({ line, currency }: { line: BudgetLine; currency: string }) {
        const t = line.trace
        return (
                <ol
                        aria-label={`How the proposal for ${line.employee.full_name} was calculated`}
                        className="space-y-2 text-sm"
                >
                        {t.annual && (
                                <li>
                                        <span className="font-medium">Approved annual score:</span>{' '}
                                        {scoreText(t.annual.final_score)} (annual result version{' '}
                                        {t.annual.version_no})
                                </li>
                        )}
                        {t.compa_ratio && (
                                <li>
                                        <span className="font-medium">Compa-ratio:</span>{' '}
                                        {money(t.compa_ratio.current_salary, currency)} ÷{' '}
                                        {money(t.compa_ratio.reference_salary, currency)} ={' '}
                                        {t.compa_ratio.exact} →{' '}
                                        <strong>{t.compa_ratio.rounded}</strong> (
                                        {t.compa_ratio.rounding})
                                </li>
                        )}
                        {(t.steps ?? []).map((step) => (
                                <li key={`${step.type}-${step.matrix.version_id}`}>
                                        <span className="font-medium">
                                                {MATRIX_TYPE_LABELS[step.type] ?? step.type}:
                                        </span>{' '}
                                        <Link
                                                to={`/matrices/${step.matrix.matrix_id}/versions/${step.matrix.version_id}`}
                                                className={linkClasses}
                                        >
                                                {step.matrix.code} version {step.matrix.version_no}
                                        </Link>
                                        {step.matrix.status !== 'PUBLISHED' &&
                                                ` (${step.matrix.status.toLowerCase()})`}
                                        <div className="text-slate-700">
                                                Inputs: {values(step.inputs)}. Rule:{' '}
                                                {step.rule
                                                        ? `${step.rule.label ?? `row ${step.rule.priority}`} — ${step.rule.description}`
                                                        : 'no rule matched; the default result applied'}
                                                . Result: {values(step.outputs)}.
                                        </div>
                                </li>
                        ))}
                        {t.result && (
                                <li>
                                        <span className="font-medium">Increment:</span>{' '}
                                        {percent(t.result.base_increment_percent)} ×{' '}
                                        {t.result.multiplier} ={' '}
                                        <strong>{percent(t.result.increment_percent)}</strong>;
                                        amount {money(t.result.increment_amount_exact)} →{' '}
                                        <strong>
                                                {money(t.result.increment_amount, currency)}
                                        </strong>
                                        ; new salary {money(t.result.new_salary, currency)}.
                                        Rounding: {t.result.rounding}.
                                </li>
                        )}
                        {t.excluded && (
                                <li className="text-amber-900">
                                        <span className="font-medium">Excluded:</span>{' '}
                                        {EXCLUSIONS[t.excluded.code] ?? t.excluded.code} —{' '}
                                        {t.excluded.reason}
                                </li>
                        )}
                </ol>
        )
}
