/** Synthetic JD/KPI test data shaped exactly like the API responses (Stages J and K). */
import type {
        AssignmentBrief,
        CurrentUser,
        Deviation,
        JDDetail,
        JDVersion,
        Kpi,
        KpiSheet,
        Quarter,
        ScoringPolicy,
} from '../types/api'
import { plantA, quality } from './fixtures'

function user(
        id: number,
        username: string,
        roleCode: string,
        roleName: string,
        permissions: string[],
): CurrentUser {
        return {
                id,
                username,
                email: null,
                employee: null,
                roles: [
                        {
                                code: roleCode,
                                name: roleName,
                                scopes: [{ scope_type: 'PLANT', plant: plantA, department: null }],
                        },
                ],
                permissions,
                csrf_token: `csrf-${username}`,
        }
}

export const deptHeadUser = user(11, 'test.depthead', 'DEPT_HEAD', 'Department Head', [
        'org:read',
        'jd:write',
        'kpi:write',
])
export const plantHeadUser = user(12, 'test.planthead', 'PLANT_HEAD', 'Plant Head', [
        'org:read',
        'jd:authorise',
        'deviation:approve_plant',
])
export const hrHeadUser = user(13, 'test.hrhead', 'HR_HEAD', 'HR Head', [
        'org:read',
        'jd:write',
        'kpi:write',
        'quarter:start',
        'deviation:approve_hr',
])

export const q1: Quarter = {
        id: 41,
        cycle_code: 'TFY',
        cycle_name: 'Test FY',
        quarter_number: 1,
        name: 'TQ1',
        start_date: '2026-07-01',
        end_date: '2026-09-30',
        status: 'DRAFT',
}
export const q2: Quarter = {
        ...q1,
        id: 42,
        quarter_number: 2,
        name: 'TQ2',
        start_date: '2026-10-01',
        end_date: '2026-12-31',
}

const policyRefs = {
        higher: { id: 1, code: 'TP-A', name: 'Test higher' },
        lower: { id: 2, code: 'TP-B', name: 'Test lower' },
        zero: { id: 3, code: 'TP-Z', name: 'Test zero tolerance' },
}

export const policies: ScoringPolicy[] = [
        {
                ...policyRefs.higher,
                description: null,
                direction: 'HIGHER_IS_BETTER',
                bands: [
                        { threshold: 100, score: 5 },
                        { threshold: 90, score: 4 },
                ],
                fallback_score: 1,
                met_score: null,
                breached_score: null,
                is_active: true,
                matrix: null,
        },
        {
                ...policyRefs.lower,
                description: null,
                direction: 'LOWER_IS_BETTER',
                bands: [{ threshold: 100, score: 5 }],
                fallback_score: 1,
                met_score: null,
                breached_score: null,
                is_active: true,
                matrix: null,
        },
        {
                ...policyRefs.zero,
                description: null,
                direction: 'ZERO_TOLERANCE',
                bands: [],
                fallback_score: 0,
                met_score: 5,
                breached_score: 0,
                is_active: true,
                matrix: null,
        },
]

function kpi(
        id: number,
        name: string,
        direction: Kpi['direction'],
        policy: keyof typeof policyRefs,
): Kpi {
        return {
                id,
                code: `TK-${id}`,
                name,
                direction,
                description: null,
                unit: direction === 'LOWER_IS_BETTER' ? 'days' : '%',
                default_scoring_policy: policyRefs[policy],
                data_source: null,
                is_active: true,
                applicability: [{ plant: null, department: null, label: 'Company-wide' }],
                reporting_frequency: 'MONTHLY',
                aggregation: direction === 'ZERO_TOLERANCE' ? 'SUM' : 'AVERAGE',
                measurement_method: null,
        }
}

export const kpis: Kpi[] = [
        kpi(7, 'Test profit', 'HIGHER_IS_BETTER', 'higher'),
        kpi(8, 'Test claims', 'ZERO_TOLERANCE', 'zero'),
        kpi(9, 'Test inventory days', 'LOWER_IS_BETTER', 'lower'),
]

export const assignmentBrief: AssignmentBrief = {
        id: 1,
        employee: { id: 501, employee_code: 'T0001', full_name: 'Tess Person' },
        plant: plantA,
        department: quality,
        designation: { id: 100, code: 'ENG', name: 'Engineer' },
        is_primary: true,
}

export function kpiSheet(overrides: Partial<KpiSheet> = {}): KpiSheet {
        return {
                id: 90,
                status: 'DRAFT',
                quarter: q1,
                assignment: assignmentBrief,
                job_description: null,
                notes: null,
                items: [],
                total: 0,
                warnings: [],
                published_at: null,
                locked_at: null,
                can_edit: true,
                can_request_deviation: false,
                pending_deviation_id: null,
                ...overrides,
        }
}

/** Two KPIs, 40 / 60, as the API returns them. */
export const twoItems: KpiSheet['items'] = [
        {
                id: 1,
                kpi: { id: 7, code: 'TK-7', name: 'Test profit', direction: 'HIGHER_IS_BETTER' },
                weightage: 40,
                target_value: 120,
                target_note: null,
                unit: '%',
                scoring_policy: policyRefs.higher,
                frozen: true,
                matrix_version: { id: 301, matrix_id: 30, matrix_code: 'KSM-0030', version_no: 2 },
                measurement: { reporting_frequency: 'MONTHLY', aggregation: 'AVERAGE' },
        },
        {
                id: 2,
                kpi: {
                        id: 9,
                        code: 'TK-9',
                        name: 'Test inventory days',
                        direction: 'LOWER_IS_BETTER',
                },
                weightage: 60,
                target_value: 30,
                target_note: null,
                unit: 'days',
                scoring_policy: policyRefs.lower,
                frozen: true,
                matrix_version: null,
                measurement: null,
        },
]

export function deviation(overrides: Partial<Deviation> = {}): Deviation {
        return {
                id: 70,
                status: 'PENDING',
                sheet_id: 90,
                employee: assignmentBrief.employee,
                plant: plantA,
                department: quality,
                quarter_name: 'TQ1',
                reason: 'Customer schedule changed mid-quarter',
                original_items: [
                        {
                                kpi_definition_id: 7,
                                kpi: 'Test profit',
                                weightage: '40.00',
                                target_value: '120.0000',
                                target_note: null,
                                unit: '%',
                                scoring_policy_id: 1,
                        },
                        {
                                kpi_definition_id: 9,
                                kpi: 'Test inventory days',
                                weightage: '60.00',
                                target_value: '30.0000',
                                target_note: null,
                                unit: 'days',
                                scoring_policy_id: 2,
                        },
                ],
                proposed_items: [
                        {
                                kpi_definition_id: 7,
                                kpi: 'Test profit',
                                weightage: '50.00',
                                target_value: '120.0000',
                                target_note: null,
                                unit: null,
                                scoring_policy_id: null,
                        },
                        {
                                kpi_definition_id: 9,
                                kpi: 'Test inventory days',
                                weightage: '50.00',
                                target_value: '30.0000',
                                target_note: null,
                                unit: null,
                                scoring_policy_id: null,
                        },
                ],
                requested_by: { id: deptHeadUser.id, username: deptHeadUser.username },
                requested_at: '2026-08-10T09:00:00Z',
                hr_approved_by: null,
                hr_approved_at: null,
                plant_approved_by: null,
                plant_approved_at: null,
                rejected_by: null,
                rejected_at: null,
                rejection_reason: null,
                applied_at: null,
                ...overrides,
        }
}

export const jdDetail: JDDetail = {
        id: 5,
        code: 'JD-00005',
        title: 'Quality Engineer — Inspection',
        department: quality,
        plant: plantA,
        designation: null,
        is_active: true,
        approved_version: null,
        open_version: {
                id: 50,
                version_no: 1,
                status: 'PROPOSED',
                effective_date: null,
                updated_at: '2026-08-01T00:00:00Z',
        },
        updated_at: '2026-08-01T00:00:00Z',
        versions: [
                {
                        id: 50,
                        version_no: 1,
                        status: 'PROPOSED',
                        effective_date: null,
                        updated_at: '2026-08-01T00:00:00Z',
                },
        ],
}

export function jdVersion(overrides: Partial<JDVersion> = {}): JDVersion {
        return {
                id: 50,
                job_description_id: 5,
                version_no: 1,
                status: 'PROPOSED',
                created_at: '2026-08-01T00:00:00Z',
                updated_at: '2026-08-01T00:00:00Z',
                created_by: { id: deptHeadUser.id, username: deptHeadUser.username },
                proposed_by: { id: deptHeadUser.id, username: deptHeadUser.username },
                proposed_at: '2026-08-01T00:00:00Z',
                authorised_by: null,
                authorised_at: null,
                approved_by: null,
                approved_at: null,
                returned_reason: null,
                format_no: 'HR-F-01',
                rev_issue_no: '01',
                effective_date: null,
                vacancies: 1,
                vacancy_type: 'NEW',
                nature_of_job: 'PERMANENT',
                hiring_reason: 'Synthetic reason',
                replacement_of: null,
                proposed_ctc: null,
                available_budget: null,
                min_qualification: 'B.Tech',
                age_band_gender: null,
                work_experience: '5+ years',
                languages: 'English',
                reports_to: 'Synthetic manager role',
                supervises: null,
                hr_remarks: null,
                responsibilities: [{ heading: 'Inspection', points: ['Oversee inspection'] }],
                technical_competencies: [{ name: 'Measurement systems', level: 4 }],
                behavioural_competencies: [{ name: 'Attention to detail', level: 3 }],
                ...overrides,
        }
}
