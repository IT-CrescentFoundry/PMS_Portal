/** Synthetic annual results, deviations and corrections shaped like the API (Stage M). */
import type {
        AnnualCycle,
        AnnualDetail,
        AnnualRow,
        AnnualVersion,
        Correction,
        CurrentUser,
        Quarter,
} from '../types/api'
import { plantA, quality } from './fixtures'

function grant(
        id: number,
        username: string,
        code: string,
        permissions: string[],
        employee = false,
) {
        const user: CurrentUser = {
                id,
                username,
                email: null,
                employee: employee
                        ? { id: 501, employee_code: 'T0001', full_name: 'Tess Person' }
                        : null,
                roles: [
                        {
                                code,
                                name: code,
                                scopes: [{ scope_type: 'GLOBAL', plant: null, department: null }],
                        },
                ],
                permissions,
                csrf_token: `csrf-${username}`,
        }
        return user
}

export const annualHrHead = grant(31, 'test.hrhead', 'HR_HEAD', [
        'org:read',
        'kpi:write',
        'quarter:start',
        'score:publish',
        'annual:read',
        'quarter:correction_request',
])
export const annualAdmin = grant(32, 'test.admin', 'ADMIN', [
        'org:read',
        'annual:read',
        'annual:deviation_request',
])
export const annualChro = grant(33, 'test.chro', 'CHRO', [
        'org:read',
        'quarter:start',
        'score:publish',
        'annual:read',
        'annual:approve',
        'quarter:correction_approve',
])

const quarter = (n: number, status: Quarter['status'] = 'PUBLISHED'): Quarter => ({
        id: 700 + n,
        cycle_code: 'TST-AN',
        cycle_name: 'Test annual cycle',
        quarter_number: n,
        name: `TA${n}`,
        start_date: `2026-0${3 + n}-01`,
        end_date: `2026-0${3 + n}-28`,
        status,
})

export const annualCycle: AnnualCycle = {
        id: 70,
        code: 'TST-AN',
        name: 'Test annual cycle',
        start_date: '2026-04-01',
        end_date: '2026-07-31',
        status: 'ACTIVE',
        quarters: [1, 2, 3, 4].map((n) => quarter(n)),
        rule: {
                code: 'QUARTERLY_WEIGHTED_AVERAGE',
                version: 1,
                quarter_weights: { '1': '25', '2': '25', '3': '25', '4': '25' },
                decimals: 2,
                rounding: 'HALF_UP',
                description:
                        'Equally weighted average of the four published quarterly scores (initial default).',
                sha256: 'a'.repeat(64),
        },
        can_set_rule: false,
}

export function annualVersion(overrides: Partial<AnnualVersion> = {}): AnnualVersion {
        return {
                id: 900,
                version_no: 1,
                status: 'CALCULATED',
                calculated_exact: '3.95',
                calculated_score: '3.95',
                adjusted_score: null,
                final_score: '3.95',
                recalculation_required: false,
                recalculation_reason: null,
                calculated_by: { id: 31, username: 'test.hrhead' },
                calculated_at: '2026-10-26T10:00:00Z',
                published_by: null,
                published_at: null,
                approval_note: null,
                previous_id: null,
                superseded_at: null,
                rule_version: 1,
                rule_sha256: 'a'.repeat(64),
                ...overrides,
        }
}

const scores = ['4.6', '3.6', '3.8', '3.8']

export function annualRow(overrides: Partial<AnnualRow> = {}): AnnualRow {
        return {
                employee: { id: 501, employee_code: 'T0001', full_name: 'Tess Person' },
                cycle_id: annualCycle.id,
                home_plant: plantA,
                home_department: quality,
                quarters: [1, 2, 3, 4].map((n) => ({
                        quarter_id: 700 + n,
                        quarter_number: n,
                        name: `TA${n}`,
                        status: 'PUBLISHED',
                        weight: '25',
                        required: true,
                        published: true,
                        score: scores[n - 1],
                        version_no: 1,
                        employee_result_id: 800 + n,
                        correction_ids: [],
                })),
                complete: true,
                issues: [],
                draft: annualVersion(),
                published: null,
                pending_deviation: null,
                actions: {
                        can_calculate: true,
                        can_request_deviation: false,
                        can_decide_deviation: false,
                        can_finalize: false,
                },
                ...overrides,
        }
}

export function annualDetail(overrides: Partial<AnnualDetail> = {}): AnnualDetail {
        const row = annualRow()
        return {
                ...row,
                versions: [
                        {
                                ...annualVersion(),
                                rule: {},
                                sources: [1, 2, 3, 4].map((n) => ({
                                        quarter_id: 700 + n,
                                        quarter_number: n,
                                        quarter_name: `TA${n}`,
                                        weight: '25',
                                        employee_result_id: 800 + n,
                                        version_no: 1,
                                        final_score: scores[n - 1],
                                        calculated_score: scores[n - 1],
                                        weights_source: 'SINGLE',
                                        published_at: '2026-10-20T10:00:00Z',
                                        components: [],
                                        scoring: [],
                                        normalization: null,
                                })),
                        },
                ],
                deviations: [],
                finalize_blockers: [],
                history: [
                        {
                                id: 1,
                                action: 'annual_result.calculate',
                                summary: 'Calculated the Test annual cycle annual result of T0001 (version 1): 3.95',
                                reason: null,
                                actor: 'test.hrhead',
                                occurred_at: '2026-10-26T10:00:00Z',
                        },
                ],
                ...overrides,
        }
}

export const publishedQ2 = quarter(2)

export function correction(overrides: Partial<Correction> = {}): Correction {
        return {
                id: 55,
                status: 'REQUESTED',
                quarter: publishedQ2,
                base_version: 1,
                version_no: null,
                reason: 'May dispatch excluded a late delivery note',
                requested_by: { id: 31, username: 'test.hrhead' },
                requested_at: '2026-10-26T11:00:00Z',
                items: 1,
                decided_by: null,
                decided_at: null,
                decision_reason: null,
                published_by: null,
                published_at: null,
                changes: [
                        {
                                id: 1,
                                kind: 'VALUE',
                                employee: {
                                        id: 501,
                                        employee_code: 'T0001',
                                        full_name: 'Tess Person',
                                },
                                unit: 'Test Quality — Test Plant A',
                                sheet_id: 90,
                                kpi_code: 'TK-7',
                                kpi_name: 'Test profit',
                                period: '2026-05',
                                had_value: true,
                                before_actual: '95',
                                after_actual: '101',
                                before_inputs: null,
                                after_inputs: null,
                                before_weights: [],
                                after_weights: [],
                        },
                ],
                preview: {
                        sheets: [
                                {
                                        sheet_id: 90,
                                        employee: 'T0001 Tess Person',
                                        unit: 'Test Quality — Test Plant A',
                                        before: '3.6',
                                        after: '4.2',
                                        complete: true,
                                },
                        ],
                        employees: [
                                {
                                        employee_id: 501,
                                        employee: 'T0001 Tess Person',
                                        before: '3.6',
                                        after: '4.2',
                                },
                        ],
                        problems: [],
                        affected: {
                                employees: [
                                        {
                                                id: 501,
                                                employee_code: 'T0001',
                                                full_name: 'Tess Person',
                                        },
                                ],
                                dependents: [],
                                cohorts: [
                                        {
                                                run_id: 7,
                                                label: 'Test Quality: all plants',
                                                members: 1,
                                        },
                                ],
                                annual_results_flagged: [],
                        },
                },
                affected: null,
                sheets: [],
                cohorts: [],
                next_status: null,
                previous_status: null,
                blockers: [],
                actions: {
                        can_decide: false,
                        can_advance: false,
                        can_return: false,
                        can_publish: false,
                },
                history: [],
                ...overrides,
        }
}
