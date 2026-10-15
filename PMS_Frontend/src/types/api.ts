/**
 * Response types mirroring the backend's Pydantic schemas (see
 * docs/api.md and GET /openapi.json). Dates are ISO strings ("2026-08-01").
 */

export interface PlantRef {
        id: number
        code: string
        name: string
}

export interface DepartmentRef {
        id: number
        code: string
        name: string
}

export interface DesignationRef {
        id: number
        code: string
        name: string
}

export interface EmployeeRef {
        id: number
        employee_code: string
        full_name: string
}

export interface Plant extends PlantRef {
        location: string | null
        is_active: boolean
}

export interface Department extends DepartmentRef {
        description: string | null
        is_active: boolean
}

/** A department at one plant (plant_departments row), e.g. Quality — Plant A. */
export interface OrgUnit {
        plant_department_id: number
        plant: PlantRef
        department: DepartmentRef
        is_active: boolean
}

export interface PlantDetail extends Plant {
        units: OrgUnit[]
}

export interface DepartmentDetail extends Department {
        units: OrgUnit[]
}

export interface Assignment {
        id: number
        plant_department_id: number
        plant: PlantRef
        department: DepartmentRef
        designation: DesignationRef
        reporting_manager: EmployeeRef | null
        is_primary: boolean
        effective_from: string
        effective_to: string | null
        /** Relative to the response's as_of date. */
        is_current: boolean
}

export interface EmployeeSummary {
        id: number
        employee_code: string
        full_name: string
        email: string | null
        is_active: boolean
        /** A current primary assignment exists, possibly outside the caller's access. */
        has_primary_assignment: boolean
        /** Null when there is none OR it is outside the caller's access. */
        primary_assignment: Assignment | null
        /** Current assignments inside the filter and the caller's access. */
        matching_assignments: Assignment[]
}

export interface EmployeeList {
        items: EmployeeSummary[]
        total: number
        limit: number
        offset: number
        as_of: string
}

export interface EmployeeDetail {
        id: number
        employee_code: string
        full_name: string
        email: string | null
        date_of_joining: string | null
        date_of_exit: string | null
        is_active: boolean
        as_of: string
        has_primary_assignment: boolean
        current_assignments: Assignment[]
        assignment_history: Assignment[]
}

export interface ReportScope {
        plant_id: number | null
        department_id: number | null
        label: string
        /** The caller's access covers only part of the requested scope. */
        access_limited: boolean
}

export interface UnitHeadcount {
        plant_department_id: number
        plant: PlantRef
        department: DepartmentRef
        headcount: number
        supporting: number
}

export interface HeadcountReport {
        scope: ReportScope
        as_of: string
        /** Unique employees, each counted once at their primary assignment. */
        headcount: number
        supporting_employees: number
        employees_without_primary: number
        by_unit: UnitHeadcount[]
}

export type ScopeType = 'GLOBAL' | 'PLANT' | 'DEPARTMENT' | 'PLANT_DEPARTMENT'

export interface RoleScope {
        scope_type: ScopeType
        plant: PlantRef | null
        department: DepartmentRef | null
}

export interface RoleGrant {
        code: string
        name: string
        scopes: RoleScope[]
}

export interface CurrentUser {
        id: number
        username: string
        email: string | null
        employee: EmployeeRef | null
        roles: RoleGrant[]
        /** e.g. "org:read", "self:read" */
        permissions: string[]
        /** CSRF token bound to the session cookie; held in memory only. */
        csrf_token: string | null
}

export interface LoginResponse {
        user: CurrentUser
        expires_at: string
}

// --- Job descriptions (Stage J) ----------------------------------------------------------

export interface UserRef {
        id: number
        username: string
}

/** Draft → Proposed (HOD) → Authorised (Plant Head) → Approved (CHRO); then Superseded. */
export type JDVersionStatus = 'DRAFT' | 'PROPOSED' | 'AUTHORISED' | 'APPROVED' | 'SUPERSEDED'
export type VacancyType = 'NEW' | 'REPLACEMENT' | 'EXISTING'
export type NatureOfJob = 'PERMANENT' | 'TEMPORARY' | 'CONTRACTUAL'

export interface ResponsibilitySection {
        heading: string
        points: string[]
}

/** Required proficiency, E-Scale 1 (Awareness) to 5 (Expert). */
export interface Competency {
        name: string
        level: number
}

/** Every field of the current JD format (Manpower Requisition + JD). */
export interface JDContent {
        format_no: string | null
        rev_issue_no: string | null
        effective_date: string | null
        vacancies: number | null
        vacancy_type: VacancyType | null
        nature_of_job: NatureOfJob | null
        hiring_reason: string | null
        replacement_of: string | null
        proposed_ctc: string | null
        /** Filled by HR only. */
        available_budget: string | null
        min_qualification: string | null
        age_band_gender: string | null
        work_experience: string | null
        languages: string | null
        reports_to: string | null
        supervises: string | null
        hr_remarks: string | null
        responsibilities: ResponsibilitySection[]
        technical_competencies: Competency[]
        behavioural_competencies: Competency[]
}

export interface JDVersionSummary {
        id: number
        version_no: number
        status: JDVersionStatus
        effective_date: string | null
        updated_at: string
}

export interface JDVersion extends JDContent {
        id: number
        job_description_id: number
        version_no: number
        status: JDVersionStatus
        created_at: string
        updated_at: string
        created_by: UserRef | null
        proposed_by: UserRef | null
        proposed_at: string | null
        authorised_by: UserRef | null
        authorised_at: string | null
        approved_by: UserRef | null
        approved_at: string | null
        returned_reason: string | null
}

export interface JDSummary {
        id: number
        code: string
        title: string
        department: DepartmentRef
        /** Null: the role applies at every plant where the department exists. */
        plant: PlantRef | null
        designation: DesignationRef | null
        is_active: boolean
        approved_version: JDVersionSummary | null
        open_version: JDVersionSummary | null
        updated_at: string
}

export interface JDDetail extends JDSummary {
        versions: JDVersionSummary[]
}

export interface JDCreate extends JDContent {
        title: string
        department_id: number
        plant_id: number | null
        designation_id: number | null
}

export interface JDUpdate extends JDContent {
        title: string
        designation_id: number | null
}

// --- KPI management (Stage J) ------------------------------------------------------------

export type KpiDirection = 'HIGHER_IS_BETTER' | 'LOWER_IS_BETTER' | 'ZERO_TOLERANCE'
export type KpiSheetStatus = 'DRAFT' | 'PUBLISHED' | 'LOCKED'
export type QuarterStatus = 'DRAFT' | 'OPEN' | 'CLOSED'
export type DeviationStatus = 'PENDING' | 'APPLIED' | 'REJECTED'

export interface Band {
        /** Achievement % boundary (strict comparison). */
        threshold: number
        score: number
}

export interface PolicyRef {
        id: number
        code: string
        name: string
}

export interface ScoringPolicy extends PolicyRef {
        description: string | null
        direction: KpiDirection
        bands: Band[]
        fallback_score: number
        met_score: number | null
        breached_score: number | null
        is_active: boolean
}

export interface Applicability {
        plant: PlantRef | null
        department: DepartmentRef | null
        label: string
}

export interface KpiRef {
        id: number
        code: string
        name: string
        direction: KpiDirection
}

export interface Kpi extends KpiRef {
        description: string | null
        unit: string
        default_scoring_policy: PolicyRef
        data_source: string | null
        is_active: boolean
        applicability: Applicability[]
}

export interface KpiWrite {
        name: string
        description: string | null
        unit: string
        direction: KpiDirection
        default_scoring_policy_id: number
        data_source: string | null
        applicability: {
                plant_id: number | null
                department_id: number | null
        }[]
        is_active: boolean
}

export interface Quarter {
        id: number
        cycle_code: string
        cycle_name: string
        quarter_number: number
        name: string
        start_date: string
        end_date: string
        /** DRAFT: KPIs configurable. OPEN: scoring started, KPIs locked. */
        status: QuarterStatus
}

export interface StartScoringResult {
        quarter: Quarter
        locked_sheets: number
        unpublished_sheets: number
}

export interface AssignmentBrief {
        id: number
        employee: EmployeeRef
        plant: PlantRef
        department: DepartmentRef
        designation: DesignationRef
        is_primary: boolean
}

export interface SheetBrief {
        id: number
        status: KpiSheetStatus
        item_count: number
        total: number
}

export interface SheetRow {
        assignment: AssignmentBrief
        sheet: SheetBrief | null
}

export interface SheetList {
        quarter: Quarter
        rows: SheetRow[]
}

export interface SheetItem {
        id: number
        kpi: KpiRef
        weightage: number
        target_value: number | null
        target_note: string | null
        unit: string
        scoring_policy: PolicyRef
        /** The scoring rule was frozen when the sheet was published. */
        frozen: boolean
}

export interface SheetItemInput {
        kpi_definition_id: number
        /** Sent as text so 33.33 stays exactly 33.33. */
        weightage: string
        target_value: string | null
        target_note: string | null
        unit: string | null
        scoring_policy_id: number | null
}

export interface KpiSheet {
        id: number
        status: KpiSheetStatus
        quarter: Quarter
        assignment: AssignmentBrief
        job_description: { id: number; code: string; title: string } | null
        notes: string | null
        items: SheetItem[]
        total: number
        warnings: string[]
        published_at: string | null
        locked_at: string | null
        can_edit: boolean
        can_request_deviation: boolean
        pending_deviation_id: number | null
}

export interface SheetSaved {
        sheet: KpiSheet
        warnings: string[]
}

export interface UploadIssue {
        message: string
        field: string | null
        row: number | null
}

export interface UploadPreview {
        quarter: Quarter
        row_count: number
        issues: UploadIssue[]
        sheets: {
                employee: EmployeeRef
                plant: PlantRef
                department: DepartmentRef
                action: 'create' | 'replace'
                items: {
                        row: number
                        kpi_name: string
                        weightage: number
                        target_value: number | null
                        unit: string | null
                        scoring_policy: string | null
                        target_note: string | null
                }[]
                total: number
        }[]
}

export interface UploadConfirmed {
        sheets_created: number
        sheets_updated: number
        items: number
        rows: number
}

/** A sheet item as recorded on a deviation (decimals as text). */
export interface DeviationItem {
        kpi_definition_id: number
        kpi: string | null
        weightage: string
        target_value: string | null
        target_note: string | null
        unit: string | null
        scoring_policy_id: number | null
}

export type ApproverSide = 'HR_HEAD' | 'PLANT_HEAD'

export interface Deviation {
        id: number
        status: DeviationStatus
        sheet_id: number
        employee: EmployeeRef
        plant: PlantRef
        department: DepartmentRef
        quarter_name: string
        reason: string
        original_items: DeviationItem[]
        proposed_items: DeviationItem[]
        requested_by: UserRef | null
        requested_at: string
        hr_approved_by: UserRef | null
        hr_approved_at: string | null
        plant_approved_by: UserRef | null
        plant_approved_at: string | null
        rejected_by: UserRef | null
        rejected_at: string | null
        rejection_reason: string | null
        applied_at: string | null
}
