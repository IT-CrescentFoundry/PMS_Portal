/** Synthetic compensation cycles, baselines and budget scenarios shaped like the API (Stage N). */
import type {
        BaselinePreview,
        BudgetLine,
        BudgetScenario,
        BudgetVariance,
        CompensationCycleDetail,
        CurrentUser,
} from '../types/api'
import { plantA, quality } from './fixtures'

function grant(id: number, username: string, code: string, permissions: string[]): CurrentUser {
        return {
                id,
                username,
                email: null,
                employee: null,
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
}

export const compHrHead = grant(41, 'test.comp.hrhead', 'HR_HEAD', [
        'org:read',
        'annual:read',
        'matrix:read',
        'matrix:read_compensation',
        'compensation:read',
        'compensation:manage',
        'budget:read',
])
export const compBudgetUser = grant(42, 'test.comp.budget', 'BUDGET_USER', [
        'org:read',
        'matrix:read',
        'budget:read',
        'budget:record',
])
export const compChro = grant(43, 'test.comp.chro', 'CHRO', [
        'org:read',
        'annual:read',
        'matrix:read',
        'matrix:read_compensation',
        'compensation:read',
        'budget:read',
        'budget:approve',
])

const hr = { id: 41, username: 'test.comp.hrhead' }

export const compCycle: CompensationCycleDetail = {
        id: 90,
        code: 'TST-CMP',
        name: 'Test compensation cycle',
        status: 'OPEN',
        pms_cycle: { id: 70, code: 'TST-AN', name: 'Test annual cycle' },
        currency: 'INR',
        effective_date: '2031-04-01',
        cr_method: 'MATRIX_INPUT',
        reference_label: 'Test reference salary',
        notes: null,
        finalized_at: null,
        finalized_by: null,
        revision_no: 0,
        reopened_at: null,
        reopened_by: null,
        reopen_reason: null,
        policy: [
                {
                        type: 'KRA_PERFORMANCE',
                        label: 'KRA performance matrix',
                        status: 'APPROVED',
                        versions: [
                                {
                                        version_id: 801,
                                        matrix_id: 81,
                                        code: 'KRM-TST',
                                        name: 'Test KRA matrix',
                                        version_no: 1,
                                        status: 'PUBLISHED',
                                },
                        ],
                },
                {
                        type: 'INCREMENT',
                        label: 'Increment matrix',
                        status: 'AWAITING_CONFIGURATION',
                        versions: [],
                },
        ],
        baselines: [
                {
                        id: 95,
                        version_no: 1,
                        file_name: 'baseline.xlsx',
                        row_count: 2,
                        imported_by: hr,
                        created_at: '2031-03-01T09:00:00Z',
                },
        ],
        decisions: [],
        scenarios: [],
        actions: {
                can_manage: true,
                can_record_budget: false,
                can_approve: false,
                can_read_employees: true,
                can_reopen: false,
        },
        history: [],
}

export const validBaselinePreview: BaselinePreview = {
        file_name: 'baseline.csv',
        file_format: 'csv',
        rows: 2,
        eligible: 1,
        not_eligible: 1,
        issues: [],
        warnings: ['1 employee has no approved annual result yet.'],
        lines: [
                {
                        row: 2,
                        employee: { id: 501, employee_code: 'T0001', full_name: 'Tess Person' },
                        current_salary: '100000.00',
                        reference_salary: '125000.00',
                        grade: 'G1',
                        eligible: true,
                        exclusion_reason: null,
                },
                {
                        row: 3,
                        employee: { id: 502, employee_code: 'T0002', full_name: 'Theo Tester' },
                        current_salary: '90000.00',
                        reference_salary: '90000.00',
                        grade: null,
                        eligible: false,
                        exclusion_reason: 'Joined after the cut-off',
                },
        ],
        lines_truncated: false,
        ready: true,
}

export const includedLine: BudgetLine = {
        employee: { id: 501, employee_code: 'T0001', full_name: 'Tess Person' },
        status: 'INCLUDED',
        exclusion_code: null,
        exclusion_reason: null,
        plant: plantA,
        department: quality,
        annual_score: '4.2000',
        current_salary: '100000.00',
        reference_salary: '125000.00',
        compa_ratio: '0.8000',
        performance_rating: 5,
        base_increment_percent: '12.0000',
        cr_multiplier: '1.0000',
        increment_percent: '12.00',
        increment_amount: '12000.00',
        increment_amount_exact: '12000.000000',
        new_salary: '112000.00',
        trace: {
                annual: { annual_result_id: 1, version_no: 1, final_score: '4.2000' },
                compa_ratio: {
                        current_salary: '100000.00',
                        reference_salary: '125000.00',
                        exact: '0.8',
                        rounded: '0.8000',
                        rounding: 'half up to 4 decimals',
                },
                steps: [
                        {
                                type: 'KRA_PERFORMANCE',
                                matrix: {
                                        version_id: 801,
                                        matrix_id: 81,
                                        code: 'KRM-TST',
                                        name: 'Test KRA matrix',
                                        version_no: 1,
                                        status: 'PUBLISHED',
                                        content_sha256: 'abc',
                                },
                                inputs: { weighted_score: '4.2000' },
                                outputs: { rating: 5 },
                                rule: {
                                        priority: 1,
                                        label: 'Top band',
                                        description: 'weighted_score ≥ 3.95',
                                },
                                used_default: false,
                        },
                ],
                result: {
                        method: 'MATRIX_INPUT',
                        base_increment_percent: '12',
                        multiplier: '1',
                        increment_percent: '12.00',
                        increment_amount_exact: '12000.000000',
                        increment_amount: '12000.00',
                        new_salary: '112000.00',
                        rounding: 'half up to 2 decimals',
                },
        },
}

export const excludedLine: BudgetLine = {
        ...includedLine,
        employee: { id: 502, employee_code: 'T0002', full_name: 'Theo Tester' },
        status: 'EXCLUDED',
        exclusion_code: 'NOT_ELIGIBLE',
        exclusion_reason: 'Joined after the cut-off',
        annual_score: null,
        compa_ratio: null,
        performance_rating: null,
        base_increment_percent: null,
        cr_multiplier: null,
        increment_percent: null,
        increment_amount: null,
        increment_amount_exact: null,
        new_salary: null,
        trace: { excluded: { code: 'NOT_ELIGIBLE', reason: 'Joined after the cut-off' } },
}

export const overBudget: BudgetVariance = {
        decision_id: 7,
        decision_version: 1,
        approved_budget: '10000.00',
        requirement: '12000.00',
        difference: '-2000.00',
        difference_percent: '-16.67',
        state: 'OVER_BUDGET',
        unallocated_balance: '0.00',
        overspend: '2000.00',
}

export function compScenario(overrides: Partial<BudgetScenario> = {}): BudgetScenario {
        return {
                id: 300,
                scenario_no: 1,
                name: 'Initial requirement',
                status: 'SUBMITTED',
                analysis_only: false,
                baseline_version_no: 1,
                included_count: 1,
                excluded_count: 1,
                total_increment: '12000.00',
                calculated_by: hr,
                calculated_at: '2031-03-02T09:00:00Z',
                submitted_by: hr,
                submitted_at: '2031-03-02T10:00:00Z',
                decided_by: null,
                decided_at: null,
                decision_reason: null,
                variance: overBudget,
                cycle: compCycle,
                note: null,
                cr_method: 'MATRIX_INPUT',
                effective_date: '2031-04-01',
                currency: 'INR',
                overrides: null,
                matrix_versions: [
                        {
                                type: 'KRA_PERFORMANCE',
                                version_id: 801,
                                matrix_id: 81,
                                code: 'KRM-TST',
                                name: 'Test KRA matrix',
                                version_no: 1,
                                status: 'PUBLISHED',
                        },
                ],
                totals: {
                        population: 2,
                        included: 1,
                        excluded: 1,
                        excluded_by_reason: { NOT_ELIGIBLE: 1 },
                        excluded_salary: '90000.00',
                        total_current_salary: '100000.00',
                        total_increment: '12000.00',
                        total_increment_exact: '12000.000000',
                        rounding_difference: '0.000000',
                        average_increment_percent: '12.00',
                        negative_adjustments: 0,
                        by_unit: [
                                {
                                        plant: plantA,
                                        department: quality,
                                        included: 1,
                                        excluded: 1,
                                        current_salary: '100000.00',
                                        increment: '12000.00',
                                        suppressed: false,
                                },
                        ],
                        reconciliation: {
                                lines_total: '12000.00',
                                units_total: '12000.00',
                                employees_counted_once: true,
                                every_employee_accounted: true,
                        },
                },
                stale_reasons: [],
                lines: [includedLine, excludedLine],
                actions: { can_submit: false, can_approve: true, can_reject: true },
                history: [],
                ...overrides,
        }
}

/** What a budget-only reader receives: totals without employee lines; small units hidden. */
export function budgetOnlyScenario(): BudgetScenario {
        const s = compScenario({
                actions: { can_submit: false, can_approve: false, can_reject: false },
        })
        return {
                ...s,
                lines: null,
                totals: {
                        ...s.totals,
                        excluded_salary: null,
                        by_unit: [
                                {
                                        ...s.totals.by_unit[0],
                                        current_salary: null,
                                        increment: null,
                                        suppressed: true,
                                },
                        ],
                },
        }
}
