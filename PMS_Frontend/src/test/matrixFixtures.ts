/** Synthetic matrix, monthly data and result test data shaped like the API (Stage K). */
import type {
        CurrentUser,
        MatrixDataType,
        MatrixDefinition,
        MatrixDetail,
        MatrixField,
        MatrixFieldMeta,
        MatrixSource,
        MatrixTypeMeta,
        MatrixVersion,
        MatrixVersionSummary,
        ResultDetail,
        ResultItem,
} from '../types/api'
import { plantA, quality } from './fixtures'
import { assignmentBrief, q2 } from './kpiFixtures'

function grant(id: number, username: string, code: string, name: string, permissions: string[]) {
        const user: CurrentUser = {
                id,
                username,
                email: null,
                employee: null,
                roles: [
                        {
                                code,
                                name,
                                scopes: [{ scope_type: 'GLOBAL', plant: null, department: null }],
                        },
                ],
                permissions,
                csrf_token: `csrf-${username}`,
        }
        return user
}

export const matrixHrHead = grant(21, 'test.hrhead.global', 'HR_HEAD', 'HR Head', [
        'org:read',
        'jd:write',
        'kpi:write',
        'quarter:start',
        'deviation:approve_hr',
        'matrix:read',
        'matrix:read_compensation',
        'matrix:write',
        'score:publish',
])

export const chroUser = grant(22, 'test.chro', 'CHRO', 'CHRO', [
        'org:read',
        'jd:approve',
        'quarter:start',
        'deviation:approve_hr',
        'matrix:read',
        'matrix:read_compensation',
        'matrix:approve',
        'score:publish',
])

export const matrixReader = grant(23, 'test.reader', 'DEPT_HEAD', 'Department Head', [
        'org:read',
        'kpi:write',
        'matrix:read',
])

const DATA_TYPE_LABELS: Record<MatrixDataType, string> = {
        DECIMAL: 'Number',
        INTEGER: 'Whole number',
        PERCENT: 'Percentage',
        CATEGORY: 'Category',
        BOOLEAN: 'Yes / No',
        DATE: 'Date',
}

const SOURCE_LABELS: Record<MatrixSource, string> = {
        MANUAL: 'Entered directly',
        ACTUAL: 'Quarterly actual',
        TARGET: 'Quarterly target',
        PERCENT_OF_TARGET: 'Actual ÷ target × 100',
        DIFFERENCE_FROM_TARGET: 'Actual − target',
        IMPORTED: 'Own column in the monthly data import',
}

function field(
        key: string,
        label: string,
        dataType: MatrixDataType,
        role: 'input' | 'output',
        extra: Partial<MatrixField> = {},
): MatrixField {
        return {
                key,
                label,
                role,
                data_type: dataType,
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
        }
}

const meta = (f: MatrixField): MatrixFieldMeta => ({
        ...f,
        data_type_label: DATA_TYPE_LABELS[f.data_type],
        source_label: f.source ? SOURCE_LABELS[f.source] : null,
})

export const achievementField = field('achievement_percent', 'Achievement %', 'PERCENT', 'input', {
        unit: '%',
        source: 'PERCENT_OF_TARGET',
})
export const scoreField = field('score', 'Score', 'INTEGER', 'output', { min: '0', max: '5' })

export const kpiScoringType: MatrixTypeMeta = {
        code: 'KPI_SCORING',
        name: 'KPI scoring matrix',
        description: 'Turns a KPI’s quarterly result into a score from 0 to 5.',
        schema_version: 1,
        standard_inputs: [
                meta(achievementField),
                meta(
                        field('incident_count', 'Number of incidents', 'INTEGER', 'input', {
                                min: '0',
                                source: 'ACTUAL',
                        }),
                ),
        ],
        outputs: [meta(scoreField)],
        allow_custom_inputs: true,
        custom_input_types: ['BOOLEAN', 'CATEGORY', 'DATE', 'DECIMAL', 'INTEGER', 'PERCENT'],
        custom_input_source: 'IMPORTED',
        allow_custom_outputs: false,
        custom_output_types: [],
        aggregations: {
                DECIMAL: ['AVERAGE', 'FIRST', 'LAST', 'MAX', 'MIN', 'SUM'],
                PERCENT: ['AVERAGE', 'FIRST', 'LAST', 'MAX', 'MIN'],
                INTEGER: ['FIRST', 'LAST', 'MAX', 'MIN', 'SUM'],
                CATEGORY: ['FIRST', 'LAST'],
                BOOLEAN: ['ALL', 'ANY', 'FIRST', 'LAST'],
                DATE: ['FIRST', 'LAST', 'MAX', 'MIN'],
        },
        max_inputs: 4,
        max_outputs: 4,
        max_rules: 200,
        selection: 'REFERENCE',
        attributes: [
                {
                        key: 'direction',
                        label: 'What good looks like',
                        allowed_values: ['HIGHER_IS_BETTER', 'LOWER_IS_BETTER', 'ZERO_TOLERANCE'],
                        description: 'Chosen explicitly; never inferred from a KPI’s title.',
                },
        ],
        policy_note: null,
        data_type_labels: DATA_TYPE_LABELS,
        source_labels: SOURCE_LABELS,
        excel_templates: true,
        settings: null,
}

export const incrementType: MatrixTypeMeta = {
        ...kpiScoringType,
        code: 'INCREMENT',
        name: 'Increment matrix',
        description: 'Gives the increment percentage for a rating and compa-ratio position.',
        standard_inputs: [],
        outputs: [],
        custom_input_source: 'MANUAL',
        selection: 'APPLICABILITY',
        attributes: [],
        policy_note:
                'Awaiting approved configuration: increment percentages and budget rules have not been defined or approved.',
}

export const definition: MatrixDefinition = {
        fields: [achievementField, scoreField],
        rules: [
                {
                        priority: 1,
                        label: 'Above target',
                        conditions: {
                                achievement_percent: {
                                        min: '100',
                                        min_inclusive: false,
                                        max: null,
                                        max_inclusive: null,
                                },
                        },
                        outputs: { score: 5 },
                },
                {
                        priority: 2,
                        label: 'Near target',
                        conditions: {
                                achievement_percent: {
                                        min: '90',
                                        min_inclusive: false,
                                        max: '100',
                                        max_inclusive: true,
                                },
                        },
                        outputs: { score: 4 },
                },
        ],
        no_match: { mode: 'default', outputs: { score: 1 } },
        test_cases: [
                {
                        label: 'Exactly 100%',
                        inputs: { achievement_percent: '100' },
                        expected: { score: 4 },
                },
        ],
}

const by = (user: CurrentUser) => ({ id: user.id, username: user.username })

export function versionSummary(
        overrides: Partial<MatrixVersionSummary> = {},
): MatrixVersionSummary {
        return {
                id: 301,
                version_no: 1,
                status: 'DRAFT',
                schema_version: 1,
                effective_from: '2026-10-01',
                effective_to: null,
                change_summary: null,
                source: 'PORTAL',
                source_file_name: null,
                template_version: null,
                created_by: by(matrixHrHead),
                created_at: '2026-10-10T09:00:00Z',
                updated_at: '2026-10-10T09:00:00Z',
                submitted_by: null,
                submitted_at: null,
                approved_by: null,
                approved_at: null,
                approval_note: null,
                rejected_by: null,
                rejected_at: null,
                rejection_reason: null,
                published_by: null,
                published_at: null,
                superseded_at: null,
                applicability: [{ plant: null, department: null, label: 'Company-wide' }],
                ...overrides,
        }
}

export function matrixVersion(overrides: Partial<MatrixVersion> = {}): MatrixVersion {
        return {
                ...versionSummary(),
                matrix_id: 30,
                definition,
                definition_hash: 'a'.repeat(64),
                check: {
                        ok: true,
                        errors: [],
                        warnings: [],
                        test_results: [
                                {
                                        label: 'Exactly 100%',
                                        passed: true,
                                        expected: { score: 4 },
                                        actual: { score: 4 },
                                        rule: 2,
                                        error: null,
                                },
                        ],
                        gaps: [],
                        readiness: [],
                        ready_to_submit: true,
                },
                rule_summaries: [
                        {
                                priority: 1,
                                label: 'Above target',
                                description: 'Achievement % is more than 100 %',
                                outputs: { score: 5 },
                        },
                        {
                                priority: 2,
                                label: 'Near target',
                                description: 'Achievement % is more than 90 % and at most 100 %',
                                outputs: { score: 4 },
                        },
                ],
                actions: {
                        can_edit: true,
                        can_submit: true,
                        can_withdraw: false,
                        can_approve: false,
                        can_publish: false,
                },
                ...overrides,
        }
}

export function matrixDetail(overrides: Partial<MatrixDetail> = {}): MatrixDetail {
        const latest = versionSummary()
        return {
                id: 30,
                code: 'KSM-0030',
                matrix_type: 'KPI_SCORING',
                type_name: 'KPI scoring matrix',
                name: 'Test delivery scoring',
                description: null,
                attributes: { direction: 'HIGHER_IS_BETTER' },
                latest_version: latest,
                open_version: latest,
                in_force: null,
                policy: { id: 9, code: 'POL-009', name: 'Test delivery scoring' },
                policy_note: null,
                versions: [latest],
                can_write: true,
                can_revise: false,
                ...overrides,
        }
}

export function resultItem(overrides: Partial<ResultItem> = {}): ResultItem {
        return {
                item_id: 1,
                kpi_id: 7,
                kpi_code: 'TK-7',
                kpi_name: 'Test profit',
                unit: '%',
                weightage: '40.00',
                target: '100',
                reporting_frequency: 'MONTHLY',
                aggregation: 'AVERAGE',
                months_expected: ['2026-10', '2026-11', '2026-12'],
                months_missing: [],
                monthly: [
                        { month: '2026-10', actual: '96', inputs: null, import_id: 4, row: 2 },
                        { month: '2026-11', actual: '102', inputs: null, import_id: 5, row: 2 },
                        { month: '2026-12', actual: '99', inputs: null, import_id: 6, row: 2 },
                ],
                quarterly_actual: '99',
                inputs: { achievement_percent: '99' },
                matrix: {
                        matrix_id: 30,
                        code: 'KSM-0030',
                        name: 'Test delivery scoring',
                        version_id: 301,
                        version_no: 2,
                        definition_hash: 'a'.repeat(64),
                },
                legacy_rule: false,
                rule: {
                        priority: 2,
                        label: 'Near target',
                        description: 'Achievement % is more than 90 % and at most 100 %',
                },
                used_default: false,
                score: 4,
                contribution: '1.60',
                status: 'scored',
                message: null,
                ...overrides,
        }
}

export function resultDetail(overrides: Partial<ResultDetail> = {}): ResultDetail {
        return {
                sheet: { id: 90, status: 'LOCKED' },
                quarter: { ...q2, status: 'OPEN' },
                assignment: { ...assignmentBrief, plant: plantA, department: quality },
                result: {
                        status: 'CALCULATED',
                        is_complete: true,
                        stale: false,
                        calculated_score: '3.4000',
                        final_score: '3.40',
                        override_score: null,
                        published_score: null,
                        calculated_at: '2027-01-05T10:00:00Z',
                        reviewed_at: null,
                        published_at: null,
                        pending_override_id: null,
                },
                months: ['2026-10', '2026-11', '2026-12'],
                items: [resultItem()],
                calculated_by: { id: 11, username: 'test.depthead' },
                reviewed_by: null,
                published_by: null,
                pending_override: null,
                applied_override: null,
                actions: {
                        can_calculate: true,
                        can_review: true,
                        can_publish: false,
                        can_request_override: true,
                },
                ...overrides,
        }
}
