/** Synthetic distributions and allocation proposals shaped like the API (Stage O). */
import type {
        AllocationCycle,
        AllocationOverview,
        AllocationProposal,
        CurrentUser,
        Distribution,
        DistributionSummary,
} from '../types/api'
import { plantA, plantB, quality } from './fixtures'

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

export const allocHead: CurrentUser = {
        ...grant(51, 'test.al.head', 'DEPT_HEAD', ['org:read', 'allocation:propose']),
        roles: [
                {
                        code: 'DEPT_HEAD',
                        name: 'DEPT_HEAD',
                        scopes: [
                                {
                                        scope_type: 'PLANT_DEPARTMENT',
                                        plant: plantA,
                                        department: quality,
                                },
                        ],
                },
        ],
}
export const allocBudget = grant(52, 'test.al.budget', 'BUDGET_USER', [
        'org:read',
        'budget:read',
        'budget:record',
        'budget:distribute',
])
export const allocChro = grant(53, 'test.al.chro', 'CHRO', [
        'org:read',
        'compensation:read',
        'budget:read',
        'budget:approve',
        'allocation:approve',
])

export const allocCycle: AllocationCycle = {
        id: 90,
        code: 'TST-CMP',
        name: 'Test compensation cycle',
        status: 'FINALIZED',
        currency: 'INR',
        effective_date: '2031-04-01',
        revision_no: 0,
        budget_finalized: true,
        distribution_version: 1,
}

const budgetUser = { id: 52, username: 'test.al.budget' }

export const publishedSummary: DistributionSummary = {
        id: 600,
        version_no: 1,
        status: 'PUBLISHED',
        budget_amount: '160000',
        totals: {
                budget: '160000',
                plants_total: '160000',
                units_total: '155000',
                unallocated: '0',
                plants_unallocated: '5000',
                rounding_residual: '0',
        },
        revision_reason: null,
        created_by: budgetUser,
        created_at: '2031-04-02T09:00:00Z',
        published_by: budgetUser,
        published_at: '2031-04-02T10:00:00Z',
}

export function draftDistribution(overrides: Partial<Distribution> = {}): Distribution {
        return {
                ...publishedSummary,
                id: 601,
                version_no: 2,
                status: 'DRAFT',
                published_by: null,
                published_at: null,
                revision_reason: 'Plant B needs a larger share',
                cycle: allocCycle,
                allow_mixed_methods: false,
                note: null,
                scenario_id: 300,
                budget_decision_id: 7,
                plants: [
                        {
                                id: 1,
                                plant: plantA,
                                method: 'AMOUNT',
                                percent: null,
                                amount: '137000',
                                amount_exact: '137000',
                                units_total: '132000',
                                unallocated: '5000',
                                rounding_residual: '0',
                                units: [
                                        {
                                                id: 2,
                                                department: quality,
                                                method: 'AMOUNT',
                                                percent: null,
                                                amount: '132000',
                                                amount_exact: '132000',
                                        },
                                ],
                        },
                ],
                stale_reasons: [],
                versions: [],
                actions: { can_edit: true, can_publish: true, can_start_revision: false },
                history: [],
                ...overrides,
        }
}

export function overview(overrides: Partial<AllocationOverview> = {}): AllocationOverview {
        return {
                cycle: allocCycle,
                policy: {
                        mode: 'RECOMMENDATION_ONLY',
                        max_increase_points: null,
                        max_decrease_points: null,
                        version: 0,
                        configured: false,
                },
                distribution: publishedSummary,
                summary: {
                        budget: '160000',
                        distributed_to_plants: '160000',
                        distributed_to_units: '155000',
                        unallocated_company: '0',
                        unallocated_plants: '5000',
                        rounding_residual: '0',
                        recommended_total: '154500.03',
                        proposed_total: '132000',
                        approved_total: '0',
                        by_status: { ADMIN_REVIEW: 1, NOT_STARTED: 1 },
                        stale: 0,
                        excluded_by_reason: { NO_ANNUAL_RESULT: 1 },
                        reconciliation: {
                                units_recommended_total: '154500.03',
                                scenario_recommended_total: '154500.03',
                                every_included_employee_in_one_unit: true,
                                no_employee_in_two_approved_proposals: true,
                                approved_within_unit_budgets: true,
                        },
                },
                units: [
                        {
                                plant: plantA,
                                department: quality,
                                distributed: '132000',
                                included: 2,
                                excluded: 0,
                                excluded_by_reason: {},
                                recommended: '132000',
                                proposed: '132000',
                                approved: null,
                                difference: '0',
                                suppressed: false,
                                latest: {
                                        id: 700,
                                        version_no: 1,
                                        status: 'ADMIN_REVIEW',
                                        proposed_total: '132000',
                                        changed_count: 0,
                                        stale_reasons: [],
                                        submitted_at: '2031-04-03T09:00:00Z',
                                        decided_at: null,
                                },
                                approved_proposal: null,
                                can_start: false,
                        },
                        {
                                plant: plantB,
                                department: quality,
                                distributed: '23000',
                                included: 1,
                                excluded: 1,
                                excluded_by_reason: { NO_ANNUAL_RESULT: 1 },
                                recommended: '22500.03',
                                proposed: null,
                                approved: null,
                                difference: '499.97',
                                suppressed: false,
                                latest: null,
                                approved_proposal: null,
                                can_start: true,
                        },
                ],
                excluded: [],
                actions: {
                        can_distribute: false,
                        can_set_policy: false,
                        can_read_employees: true,
                        draft_distribution_id: null,
                },
                ...overrides,
        }
}

export function proposal(overrides: Partial<AllocationProposal> = {}): AllocationProposal {
        return {
                id: 700,
                cycle: allocCycle,
                plant: plantA,
                department: quality,
                version_no: 1,
                status: 'DRAFT',
                scenario_id: 300,
                budget_decision_id: 7,
                distribution_id: 600,
                distribution_version: 1,
                unit_budget: '132000',
                current_unit_budget: '132000',
                included_count: 2,
                changed_count: 0,
                recommended_total: '132000',
                proposed_total: '132000',
                remaining_budget: '0',
                suppressed: false,
                policy: {
                        mode: 'WITH_REASON',
                        max_increase_points: null,
                        max_decrease_points: null,
                        version: 1,
                        configured: true,
                },
                note: null,
                prepared_by: { id: 51, username: 'test.al.head' },
                created_at: '2031-04-03T08:00:00Z',
                submitted_by: null,
                submitted_at: null,
                admin_reviewed_by: null,
                admin_reviewed_at: null,
                admin_note: null,
                decided_by: null,
                decided_at: null,
                decision_reason: null,
                stale_reasons: [],
                lines: [
                        {
                                employee: {
                                        id: 510,
                                        employee_code: 'T0010',
                                        full_name: 'Tara Tester',
                                },
                                own: false,
                                annual_result_id: 1,
                                current_salary: '600000',
                                recommended_percent: '12',
                                recommended_amount: '72000',
                                proposed_percent: '12',
                                proposed_amount: '72000',
                                new_salary: '672000',
                                difference: '0',
                                reason: null,
                        },
                        {
                                employee: {
                                        id: 511,
                                        employee_code: 'T0011',
                                        full_name: 'Omar Owner',
                                },
                                own: true,
                                annual_result_id: 2,
                                current_salary: '800000',
                                recommended_percent: '7.5',
                                recommended_amount: '60000',
                                proposed_percent: '7.5',
                                proposed_amount: '60000',
                                new_salary: '860000',
                                difference: '0',
                                reason: null,
                        },
                ],
                excluded: [],
                versions: [],
                actions: {
                        can_edit: true,
                        can_refresh: false,
                        can_submit: true,
                        can_forward: false,
                        can_return: false,
                        can_approve: false,
                        can_reject: false,
                        can_start_next: false,
                },
                history: [],
                ...overrides,
        }
}
