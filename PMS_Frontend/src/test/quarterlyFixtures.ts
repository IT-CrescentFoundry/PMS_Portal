/** Synthetic quarterly review data shaped like the API responses (Stage L). */
import type {
        Cohort,
        EmployeeResult,
        MatrixDefinition,
        MatrixField,
        MatrixFieldMeta,
        MatrixTypeMeta,
        OwnSheet,
        QuarterOverview,
} from '../types/api'
import { plantA, plantB, quality } from './fixtures'
import { assignmentBrief, q2, twoItems } from './kpiFixtures'
import { kpiScoringType } from './matrixFixtures'

export const scoringQuarter = { ...q2, status: 'OPEN' as const }

export function overview(overrides: Partial<QuarterOverview> = {}): QuarterOverview {
        return {
                quarter: scoringQuarter,
                next_status: 'DEPARTMENT_REVIEW',
                previous_status: null,
                sheets: {
                        locked: 9,
                        calculated: 9,
                        complete: 9,
                        stale: 0,
                        reviewed: 0,
                        pending_overrides: 0,
                        published: 0,
                },
                employees: { total: 8, ready: 0, multi_assignment: 1, weights_needed: 1 },
                cohorts: { total: 0, approved: 0, unresolved: 0 },
                unscorable_sheets: 0,
                blockers: [],
                feedback_enabled: true,
                published_at: null,
                published_by: null,
                actions: {
                        can_advance: true,
                        can_return: false,
                        can_publish: false,
                        can_request_correction: false,
                },
                published_version: null,
                open_correction: null,
                ...overrides,
        }
}

const tess = { id: 501, employee_code: 'T0001', full_name: 'Tess Person' }

export function employeeResult(overrides: Partial<EmployeeResult> = {}): EmployeeResult {
        return {
                employee: tess,
                quarter_id: scoringQuarter.id,
                status: 'LIVE',
                home_plant: plantA,
                home_department: quality,
                weights_source: 'MISSING',
                calculated_score: null,
                final_score: null,
                ready: false,
                issues: ['contribution weights are missing for Test Quality — Test Plant B'],
                components: [
                        {
                                assignment_id: 1,
                                sheet_id: 90,
                                plant: plantA,
                                department: quality,
                                is_primary: true,
                                result_status: 'REVIEWED',
                                score: '4',
                                score_source: 'final',
                                weight: null,
                                contribution: null,
                                problems: [],
                                can_open_sheet: true,
                        },
                        {
                                assignment_id: 2,
                                sheet_id: 91,
                                plant: plantB,
                                department: quality,
                                is_primary: false,
                                result_status: 'REVIEWED',
                                score: '3',
                                score_source: 'final',
                                weight: null,
                                contribution: null,
                                problems: [],
                                can_open_sheet: true,
                        },
                ],
                normalization: null,
                can_set_weights: true,
                version_no: null,
                versions: [],
                ...overrides,
        }
}

const member = (
        id: number,
        code: string,
        name: string,
        score: string,
        extra: Partial<Cohort['members'][number]> = {},
) => ({
        employee: { id, employee_code: code, full_name: name },
        home_plant: plantA,
        home_department: quality,
        final_score: score,
        calculated_score: score,
        rank: 1,
        group_key: 'MIDDLE',
        group_label: 'Middle 60%',
        placement: 'AUTO' as const,
        options: null,
        placement_reason: null,
        placed_by: null,
        normalized_rating: '3',
        rating_explanation: null,
        ...extra,
})

export function cohort(overrides: Partial<Cohort> = {}): Cohort {
        return {
                id: 7,
                status: 'DRAFT',
                version_no: 1,
                cohort_label: 'Test Quality: all plants',
                cohort_level: 'DEPARTMENT',
                policy: {
                        matrix_id: 40,
                        code: 'NRM-0040',
                        name: 'Test normalization',
                        version_id: 401,
                        version_no: 1,
                },
                population: 4,
                eligible: 4,
                small_cohort: false,
                distribution: [
                        {
                                key: 'TOP',
                                label: 'Top 20%',
                                target_percent: '20',
                                target_count: 1,
                                actual_count: 1,
                                actual_percent: '25',
                        },
                        {
                                key: 'MIDDLE',
                                label: 'Middle 60%',
                                target_percent: '60',
                                target_count: 2,
                                actual_count: 1,
                                actual_percent: '25',
                        },
                        {
                                key: 'BOTTOM',
                                label: 'Bottom 20%',
                                target_percent: '20',
                                target_count: 1,
                                actual_count: 0,
                                actual_percent: '0',
                        },
                ],
                matches_targets: false,
                unresolved: 2,
                rating_errors: 0,
                exceptions: 1,
                approved_by: null,
                approved_at: null,
                quarter: { ...scoringQuarter, status: 'NORMALIZATION' },
                settings: {
                        cohort_level: 'DEPARTMENT',
                        groups: [
                                { key: 'TOP', label: 'Top 20%', percent: '20', remainder: false },
                                {
                                        key: 'MIDDLE',
                                        label: 'Middle 60%',
                                        percent: '60',
                                        remainder: true,
                                },
                                {
                                        key: 'BOTTOM',
                                        label: 'Bottom 20%',
                                        percent: '20',
                                        remainder: false,
                                },
                        ],
                        size_rounding: 'NEAREST',
                        rank_by: 'FINAL_SCORE',
                        ties: 'REQUIRE_RESOLUTION',
                        min_cohort_size: 4,
                        small_cohort: 'DEFAULT_GROUP',
                        small_cohort_group: 'MIDDLE',
                        eligible_designations: [],
                },
                policy_problem: null,
                exception_list: [
                        {
                                type: 'tie',
                                message: '2 employees are tied at 2.2 across Middle 60% / Bottom 20%: an authorized reviewer must place each of them, with a reason.',
                                employee_ids: [503, 512],
                                groups: ['MIDDLE', 'BOTTOM'],
                        },
                ],
                members: [
                        member(502, 'T0002', 'Ravi Test', '5', {
                                group_key: 'TOP',
                                group_label: 'Top 20%',
                                normalized_rating: '5',
                        }),
                        member(501, 'T0001', 'Tess Person', '4.05', { rank: 2 }),
                        member(503, 'T0003', 'Meera Test', '2.2', {
                                rank: 3,
                                group_key: null,
                                group_label: null,
                                placement: 'NEEDS_RESOLUTION',
                                options: ['MIDDLE', 'BOTTOM'],
                                normalized_rating: null,
                        }),
                        member(512, 'T0012', 'Arun Test', '2.2', {
                                rank: 3,
                                group_key: null,
                                group_label: null,
                                placement: 'NEEDS_RESOLUTION',
                                options: ['MIDDLE', 'BOTTOM'],
                                normalized_rating: null,
                        }),
                ],
                approval_note: null,
                computed_at: '2026-10-26T10:00:00Z',
                actions: { can_place: true, can_approve: false, can_reopen: false },
                ...overrides,
        }
}

export function ownSheet(overrides: Partial<OwnSheet> = {}): OwnSheet {
        return {
                id: 90,
                status: 'LOCKED',
                quarter: scoringQuarter,
                assignment: assignmentBrief,
                items: twoItems,
                total: 100,
                published_score: null,
                published_at: null,
                outcome: null,
                feedback: [],
                ...overrides,
        }
}

const normalizationField = (
        key: string,
        label: string,
        role: 'input' | 'output',
        extra: Partial<MatrixField>,
): MatrixField => ({
        key,
        label,
        role,
        data_type: 'DECIMAL',
        unit: null,
        description: null,
        required: true,
        min: null,
        max: null,
        allowed_values: null,
        source: null,
        aggregation: null,
        round_to: null,
        ...extra,
})

export const groupField = normalizationField('group', 'Performance group', 'input', {
        data_type: 'CATEGORY',
        allowed_values: ['TOP', 'MIDDLE', 'BOTTOM'],
        source: 'MANUAL',
})
export const ratingField = normalizationField('rating', 'Normalized rating', 'output', {
        min: '0',
        max: '5',
})

/** A synthetic normalization policy definition (demo ratings, not company policy). */
export const normalizationDefinition: MatrixDefinition = {
        fields: [groupField, ratingField],
        rules: [
                {
                        priority: 1,
                        label: 'Top',
                        conditions: { group: { values: ['TOP'] } },
                        outputs: { rating: '5' },
                },
                {
                        priority: 2,
                        label: 'Middle',
                        conditions: { group: { values: ['MIDDLE'] } },
                        outputs: { rating: '3' },
                },
                {
                        priority: 3,
                        label: 'Bottom',
                        conditions: { group: { values: ['BOTTOM'] } },
                        outputs: { rating: '1' },
                },
        ],
        no_match: null,
        test_cases: [],
        settings: cohort().settings!,
}

const fieldMeta = (f: MatrixField, typeLabel: string): MatrixFieldMeta => ({
        ...f,
        data_type_label: typeLabel,
        source_label: f.source ? 'Entered directly' : null,
})

export const normalizationType: MatrixTypeMeta = {
        ...kpiScoringType,
        code: 'NORMALIZATION',
        name: 'Normalization policy',
        description: 'Places each employee of a cohort in a performance group.',
        standard_inputs: [fieldMeta(groupField, 'Category')],
        outputs: [fieldMeta(ratingField, 'Number')],
        allow_custom_inputs: false,
        custom_input_types: [],
        allow_custom_outputs: false,
        selection: 'APPLICABILITY',
        attributes: [],
        excel_templates: false,
        settings: {
                kind: 'normalization',
                cohort_levels: {
                        COMPANY: 'Whole company',
                        PLANT: 'Each plant',
                        DEPARTMENT: 'Each department across all plants',
                        PLANT_DEPARTMENT: 'Each department at each plant',
                },
                size_rounding: {
                        NEAREST: 'Nearest whole number (half up)',
                        DOWN: 'Round down',
                        UP: 'Round up',
                },
                rank_by: {
                        FINAL_SCORE: 'Final score (2 decimals)',
                        EXACT_SCORE: 'Exact (unrounded) score',
                },
                ties: {
                        REQUIRE_RESOLUTION: 'An authorized reviewer places tied employees',
                        HIGHER_GROUP: 'Tied employees all go to the better group',
                        LOWER_GROUP: 'Tied employees all go to the lower group',
                },
                small_cohort: {
                        REQUIRE_RESOLUTION: 'An authorized reviewer places everyone',
                        DEFAULT_GROUP: 'Everyone goes to one named group (no forced distribution)',
                },
                max_groups: 7,
        },
}
