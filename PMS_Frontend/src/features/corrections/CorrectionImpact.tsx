import { Table, TBody, Td, Th } from '../../components/tables/Table'
import type { CorrectionAffected, CorrectionChange, CorrectionPreview } from '../../types/api'
import { plural } from '../../utils/format'
import { monthLabel, scoreText } from '../scores/scoreLabels'

function weights(list: { unit: string; weight: string }[]): string {
        return list.length ? list.map((w) => `${w.unit} ${w.weight} %`).join(' · ') : '—'
}

/** What a correction changes and what depends on it (request, preview and detail). */
export function CorrectionImpact({
        changes,
        preview,
        affected,
}: {
        changes: CorrectionChange[] | null
        preview: CorrectionPreview
        affected: CorrectionAffected | null
}) {
        const dependents = affected ?? preview.affected
        return (
                <div className="space-y-4">
                        {changes && changes.length > 0 && (
                                <Table caption="Requested changes">
                                        <thead>
                                                <tr>
                                                        <Th>Employee</Th>
                                                        <Th>What</Th>
                                                        <Th>Before</Th>
                                                        <Th>After</Th>
                                                </tr>
                                        </thead>
                                        <TBody>
                                                {changes.map((ch, i) => (
                                                        <tr key={ch.id ?? i}>
                                                                <Td>
                                                                        {ch.employee?.full_name ??
                                                                                '—'}
                                                                        <div className="text-xs text-slate-600">
                                                                                {
                                                                                        ch.employee
                                                                                                ?.employee_code
                                                                                }
                                                                                {ch.unit
                                                                                        ? ` · ${ch.unit}`
                                                                                        : ''}
                                                                        </div>
                                                                </Td>
                                                                <Td>
                                                                        {ch.kind === 'VALUE'
                                                                                ? `${ch.kpi_code} ${ch.kpi_name} · ${ch.period ? monthLabel(ch.period) : '—'}`
                                                                                : 'Contribution weights'}
                                                                </Td>
                                                                <Td>
                                                                        {ch.kind === 'VALUE'
                                                                                ? ch.had_value
                                                                                        ? (ch.before_actual ??
                                                                                          '—')
                                                                                        : 'No value'
                                                                                : weights(
                                                                                          ch.before_weights,
                                                                                  )}
                                                                </Td>
                                                                <Td>
                                                                        {ch.kind === 'VALUE'
                                                                                ? (ch.after_actual ??
                                                                                  '—')
                                                                                : weights(
                                                                                          ch.after_weights,
                                                                                  )}
                                                                </Td>
                                                        </tr>
                                                ))}
                                        </TBody>
                                </Table>
                        )}
                        {preview.sheets.length > 0 && (
                                <Table caption="Projected KPI sheet scores">
                                        <thead>
                                                <tr>
                                                        <Th>Employee</Th>
                                                        <Th align="right">Published</Th>
                                                        <Th align="right">Corrected</Th>
                                                </tr>
                                        </thead>
                                        <TBody>
                                                {preview.sheets.map((s) => (
                                                        <tr key={s.sheet_id}>
                                                                <Td>
                                                                        {s.employee}
                                                                        <div className="text-xs text-slate-600">
                                                                                {s.unit}
                                                                        </div>
                                                                </Td>
                                                                <Td align="right">
                                                                        {scoreText(s.before)}
                                                                </Td>
                                                                <Td align="right">
                                                                        {scoreText(s.after)}
                                                                </Td>
                                                        </tr>
                                                ))}
                                        </TBody>
                                </Table>
                        )}
                        {preview.employees.length > 0 && (
                                <Table caption="Projected employee quarterly scores">
                                        <thead>
                                                <tr>
                                                        <Th>Employee</Th>
                                                        <Th align="right">Published</Th>
                                                        <Th align="right">Corrected</Th>
                                                </tr>
                                        </thead>
                                        <TBody>
                                                {preview.employees.map((e) => (
                                                        <tr key={e.employee_id}>
                                                                <Td>{e.employee}</Td>
                                                                <Td align="right">
                                                                        {scoreText(e.before)}
                                                                </Td>
                                                                <Td align="right">
                                                                        {scoreText(e.after)}
                                                                </Td>
                                                        </tr>
                                                ))}
                                        </TBody>
                                </Table>
                        )}
                        <div className="rounded-md border border-slate-200 bg-slate-50 p-3 text-sm text-slate-800">
                                <p className="font-medium">
                                        Results that depend on this correction
                                </p>
                                <ul className="mt-1 list-disc space-y-0.5 pl-5">
                                        <li>
                                                Affected:{' '}
                                                {dependents.employees
                                                        .map((e) => e.full_name)
                                                        .join(', ') || 'none'}
                                        </li>
                                        <li>
                                                {dependents.cohorts.length
                                                        ? `Renormalized: ${dependents.cohorts.map((c) => `${c.label} (${plural(c.members, 'member')})`).join(', ')}`
                                                        : 'No normalization cohort is renormalized.'}
                                                {dependents.dependents.length > 0 &&
                                                        ` — whose other members are reviewed again: ${dependents.dependents.map((e) => e.full_name).join(', ')}`}
                                        </li>
                                        <li>
                                                {dependents.annual_results_flagged.length
                                                        ? `${plural(dependents.annual_results_flagged.length, 'annual result')} marked for recalculation`
                                                        : 'Annual results calculated from this quarter are marked for recalculation when the correction is approved.'}
                                        </li>
                                </ul>
                        </div>
                </div>
        )
}
