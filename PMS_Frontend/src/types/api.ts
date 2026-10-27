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

/** Never inferred from a title: chosen explicitly per KPI and scoring policy. */
export type KpiDirection =
        | 'HIGHER_IS_BETTER'
        | 'LOWER_IS_BETTER'
        | 'ZERO_TOLERANCE'
        | 'TARGET_RANGE'
        | 'CATEGORICAL'
        | 'COMPOSITE'
/** How a KPI's monthly values combine into the quarterly actual. */
export type KpiAggregation = 'SUM' | 'AVERAGE' | 'LAST' | 'MIN' | 'MAX'
export type ReportingFrequency = 'MONTHLY' | 'QUARTERLY'
export type KpiSheetStatus = 'DRAFT' | 'PUBLISHED' | 'LOCKED'
/** DRAFT: KPI setup. OPEN: data collection. Then department review, normalization,
 *  ready, and published (locked). CLOSED: historic. */
export type QuarterStatus =
        'DRAFT' | 'OPEN' | 'DEPARTMENT_REVIEW' | 'NORMALIZATION' | 'READY' | 'PUBLISHED' | 'CLOSED'
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

export interface MatrixVersionBrief {
        id: number
        version_no: number
        status: MatrixVersionStatus
        effective_from: string | null
        effective_to: string | null
}

/** The versioned KPI-scoring matrix behind a policy (Stage K). */
export interface PolicyMatrix {
        id: number
        code: string
        /** The published version in force today; null when none is. */
        in_force: MatrixVersionBrief | null
        latest: MatrixVersionBrief
}

export interface ScoringPolicy extends PolicyRef {
        description: string | null
        direction: KpiDirection
        /** Stage J band representation of the policy's first version. */
        bands: Band[]
        fallback_score: number
        met_score: number | null
        breached_score: number | null
        is_active: boolean
        matrix: PolicyMatrix | null
}

export interface PolicyPreview {
        score: number
        /** The version used: the one in force today, else the latest (possibly a draft). */
        matrix_version_id: number | null
        version_no: number | null
        status: MatrixVersionStatus | null
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
        reporting_frequency: ReportingFrequency | null
        aggregation: KpiAggregation | null
        measurement_method: string | null
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
        reporting_frequency: ReportingFrequency | null
        aggregation: KpiAggregation | null
        measurement_method: string | null
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
        /** The exact approved matrix version bound at publication (Stage K). */
        matrix_version: {
                id: number
                matrix_id: number
                matrix_code: string
                version_no: number
        } | null
        /** How the KPI is measured, frozen at publication. */
        measurement: {
                reporting_frequency?: ReportingFrequency | null
                aggregation?: KpiAggregation | null
                measurement_method?: string | null
        } | null
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

// --- Configurable matrices (Stage K) -------------------------------------------------------

export type MatrixVersionStatus =
        'DRAFT' | 'SUBMITTED' | 'APPROVED' | 'REJECTED' | 'PUBLISHED' | 'SUPERSEDED'
export type MatrixVersionSource = 'PORTAL' | 'UPLOAD' | 'SEED'
export type MatrixDataType = 'DECIMAL' | 'INTEGER' | 'PERCENT' | 'CATEGORY' | 'BOOLEAN' | 'DATE'
export type MatrixFieldRole = 'input' | 'output'
/** Where an input value comes from (an allow-list; there are no expressions). */
export type MatrixSource =
        'MANUAL' | 'ACTUAL' | 'TARGET' | 'PERCENT_OF_TARGET' | 'DIFFERENCE_FROM_TARGET' | 'IMPORTED'
export type MatrixAggregation = 'SUM' | 'AVERAGE' | 'MIN' | 'MAX' | 'FIRST' | 'LAST' | 'ANY' | 'ALL'
/** Values in a definition: numbers and dates travel as text so decimals stay exact. */
export type MatrixValue = string | number | boolean | null

/** A field as stored in a version's definition. */
export interface MatrixField {
        key: string
        label: string
        role: MatrixFieldRole
        data_type: MatrixDataType
        unit: string | null
        description: string | null
        required: boolean
        /** Number or ISO date, as text. */
        min: string | null
        max: string | null
        allowed_values: string[] | null
        source: MatrixSource | null
        aggregation: MatrixAggregation | null
        round_to: number | null
}

export interface MatrixFieldMeta extends MatrixField {
        data_type_label: string
        source_label: string | null
}

/** Everything needed to render forms for one matrix type (GET /api/matrix-types). */
export interface MatrixTypeMeta {
        code: string
        name: string
        description: string
        schema_version: number
        standard_inputs: MatrixFieldMeta[]
        outputs: MatrixFieldMeta[]
        allow_custom_inputs: boolean
        custom_input_types: MatrixDataType[]
        custom_input_source: MatrixSource
        allow_custom_outputs: boolean
        custom_output_types: MatrixDataType[]
        aggregations: Partial<Record<MatrixDataType, MatrixAggregation[]>>
        max_inputs: number
        max_outputs: number
        max_rules: number
        /** REFERENCE: chosen by reference (KPI policies). APPLICABILITY: by unit and date. */
        selection: 'REFERENCE' | 'APPLICABILITY'
        attributes: { key: string; label: string; allowed_values: string[]; description: string }[]
        /** Shown while the type has no approved configuration. Never a value. */
        policy_note: string | null
        data_type_labels: Record<MatrixDataType, string>
        source_labels: Record<MatrixSource, string>
        /** False: configured in the portal only (no Excel template). */
        excel_templates: boolean
        /** Type-specific settings (normalization policies), else null. */
        settings: MatrixSettingsOptions | null
}

/** Numbers and dates: each given bound states whether it is included. */
export interface MatrixRangeCondition {
        min: string | null
        min_inclusive: boolean | null
        max: string | null
        max_inclusive: boolean | null
}
export type MatrixCondition = MatrixRangeCondition | { values: string[] } | { value: boolean }

export interface MatrixRule {
        priority: number
        label: string | null
        /** By input key; an input without a condition matches any value. */
        conditions: Record<string, MatrixCondition>
        outputs: Record<string, MatrixValue>
}

export interface MatrixNoMatch {
        mode: 'default' | 'error'
        outputs?: Record<string, MatrixValue> | null
}

export interface MatrixTestCase {
        label: string
        inputs: Record<string, MatrixValue>
        expected: Record<string, MatrixValue>
}

export interface MatrixDefinition {
        fields: MatrixField[]
        rules: MatrixRule[]
        no_match: MatrixNoMatch | null
        test_cases: MatrixTestCase[]
        /** Normalization policies only. */
        settings?: NormalizationSettings | null
}

/** A validation problem; `path` points into the definition, e.g. "rules[1].conditions.x". */
export interface MatrixProblem {
        path: string
        message: string
}

export interface MatrixTestResult {
        label: string
        passed: boolean
        expected: Record<string, MatrixValue>
        actual: Record<string, MatrixValue> | null
        rule: number | null
        error: string | null
}

export interface MatrixReport {
        ok: boolean
        errors: MatrixProblem[]
        warnings: MatrixProblem[]
        test_results: MatrixTestResult[]
        /** Values no rule covers (single-input matrices). */
        gaps: string[]
}

export interface MatrixVersionCheck extends MatrixReport {
        /** What submission additionally needs (effective date, applicability). */
        readiness: MatrixProblem[]
        ready_to_submit: boolean
}

export interface MatrixRuleSummary {
        priority: number
        label: string | null
        description: string
        outputs: Record<string, MatrixValue>
}

export interface MatrixEvaluation {
        outputs: Record<string, MatrixValue>
        rule: { priority: number; label: string | null; description: string } | null
        used_default: boolean
        inputs: Record<string, MatrixValue>
}

export interface MatrixCheckResponse {
        check: MatrixReport
        rule_summaries: MatrixRuleSummary[]
        preview: MatrixEvaluation | null
        preview_error: string | null
}

export interface MatrixScope {
        plant: PlantRef | null
        department: DepartmentRef | null
        label: string
}

export interface MatrixScopeInput {
        plant_id: number | null
        department_id: number | null
}

export interface MatrixVersionSummary {
        id: number
        version_no: number
        status: MatrixVersionStatus
        schema_version: number
        effective_from: string | null
        effective_to: string | null
        change_summary: string | null
        source: MatrixVersionSource
        source_file_name: string | null
        template_version: number | null
        created_by: UserRef | null
        created_at: string
        updated_at: string
        submitted_by: UserRef | null
        submitted_at: string | null
        approved_by: UserRef | null
        approved_at: string | null
        approval_note: string | null
        rejected_by: UserRef | null
        rejected_at: string | null
        rejection_reason: string | null
        published_by: UserRef | null
        published_at: string | null
        superseded_at: string | null
        applicability: MatrixScope[]
}

export interface MatrixSummary {
        id: number
        code: string
        matrix_type: string
        type_name: string
        name: string
        description: string | null
        attributes: Record<string, string>
        latest_version: MatrixVersionSummary
        open_version: MatrixVersionSummary | null
        /** The published version in force today. */
        in_force: MatrixVersionSummary | null
        /** KPI-scoring matrices: the policy KPIs refer to. */
        policy: PolicyRef | null
        policy_note: string | null
}

export interface MatrixDetail extends MatrixSummary {
        versions: MatrixVersionSummary[]
        can_write: boolean
        can_revise: boolean
}

export interface MatrixVersionActions {
        can_edit: boolean
        can_submit: boolean
        can_withdraw: boolean
        can_approve: boolean
        can_publish: boolean
}

export interface MatrixVersion extends MatrixVersionSummary {
        matrix_id: number
        definition: MatrixDefinition
        definition_hash: string
        check: MatrixVersionCheck
        rule_summaries: MatrixRuleSummary[]
        actions: MatrixVersionActions
}

export interface MatrixCreate {
        matrix_type: string
        name: string
        description: string | null
        attributes: Record<string, string>
        applicability: MatrixScopeInput[]
}

export interface MatrixDraftSave {
        definition: MatrixDefinition
        effective_from: string | null
        effective_to: string | null
        applicability: MatrixScopeInput[]
        change_summary: string | null
}

export interface MatrixLocatedProblem {
        /** Sheet and row in the workbook, e.g. "Rules, row 7". */
        location: string
        message: string
}

export interface MatrixUploadPreview {
        action: 'create' | 'update_draft' | 'new_version' | null
        matrix_type: string | null
        type_name: string | null
        matrix_code: string | null
        name: string | null
        target_version_no: number | null
        template_version: number | null
        schema_version: number | null
        effective_from: string | null
        effective_to: string | null
        applicability: string[]
        fields: MatrixField[]
        rules: MatrixRuleSummary[]
        test_results: MatrixTestResult[]
        problems: MatrixLocatedProblem[]
        warnings: MatrixLocatedProblem[]
        ready: boolean
}

export interface MatrixUploadConfirmed {
        matrix_id: number
        matrix_code: string
        version_id: number
        version_no: number
}

// --- Monthly KPI data and quarterly results (Stage K) ----------------------------------------

export interface DataContractField {
        key: string
        label: string
        required: boolean
        description: string
}

export interface DataImportLine {
        row: number
        employee_code: string
        employee_name: string
        assignment: string
        kpi_code: string
        kpi_name: string
        actual: string | null
        inputs: Record<string, MatrixValue> | null
        action: 'new' | 'replace' | 'unchanged'
        previous_actual: string | null
        note: string | null
}

export interface DataImportIssue {
        message: string
        field: string | null
        row: number | null
}

export interface DataImportPreview {
        quarter: Quarter
        /** "2026-10" */
        period: string
        file_name: string
        file_format: string
        columns: string[]
        contract: DataContractField[]
        /** Contract field key -> file column (null: not mapped). */
        mapping: Record<string, string | null>
        row_count: number
        counts: { new: number; replace: number; unchanged: number }
        issues: DataImportIssue[]
        warnings: string[]
        lines: DataImportLine[]
        lines_truncated: boolean
        duplicate_import: { id: number; file_name: string; created_at: string } | null
        ready: boolean
}

export interface DataImportConfirmed {
        import_id: number
        created: number
        replaced: number
        unchanged: number
        rows: number
}

export interface DataImport {
        id: number
        period: string
        file_name: string
        file_format: string
        file_size: number
        row_count: number
        rows_created: number
        rows_replaced: number
        rows_unchanged: number
        created_by: string | null
        created_at: string
}

export interface MonthlyValue {
        kpi_id: number
        kpi_code: string
        kpi_name: string
        period: string
        actual: string | null
        inputs: Record<string, MatrixValue> | null
        import_id: number | null
        file_name: string | null
        source_row: number | null
}

export type ScoreResultStatus = 'CALCULATED' | 'REVIEWED' | 'PUBLISHED' | 'SUPERSEDED'
export type ScoreOverrideStatus = 'PENDING' | 'APPLIED' | 'REJECTED' | 'VOIDED'

/** Scores travel as text ("3.40") so they stay exact. */
export interface ResultBrief {
        status: ScoreResultStatus
        /** 1 = the quarter's own result; 2+ = a correction of the published quarter. */
        version_no: number
        is_complete: boolean
        /** Data or the sheet changed since the calculation. */
        stale: boolean
        calculated_score: string | null
        final_score: string | null
        override_score: string | null
        published_score: string | null
        calculated_at: string | null
        reviewed_at: string | null
        published_at: string | null
        pending_override_id: number | null
}

export interface ResultRow {
        assignment: AssignmentBrief
        sheet: { id: number; status: KpiSheetStatus }
        result: ResultBrief | null
}

export interface ResultList {
        quarter: Quarter
        rows: ResultRow[]
}

export type ResultItemStatus = 'scored' | 'provisional' | 'no_data' | 'error'

/** How one KPI's score was reached (stored with the calculation). */
export interface ResultItem {
        item_id: number
        kpi_id: number
        kpi_code: string
        kpi_name: string
        unit: string
        weightage: string
        target: string | null
        reporting_frequency: ReportingFrequency
        aggregation: KpiAggregation | null
        months_expected: string[]
        months_missing: string[]
        monthly: {
                month: string
                actual: string | null
                inputs: Record<string, MatrixValue> | null
                import_id: number | null
                row: number | null
                /** Set when the value comes from an approved quarter correction. */
                correction_id?: number
        }[]
        quarterly_actual: string | null
        inputs: Record<string, string>
        matrix: {
                matrix_id: number
                code: string
                name: string
                version_id: number
                version_no: number
                definition_hash: string
        } | null
        legacy_rule: boolean
        rule: { priority?: number; label?: string | null; description: string } | null
        used_default: boolean
        score: number | null
        contribution: string | null
        status: ResultItemStatus
        message: string | null
}

export interface ScoreOverride {
        id: number
        status: ScoreOverrideStatus
        sheet_id: number
        employee: EmployeeRef
        plant: PlantRef
        department: DepartmentRef
        quarter_name: string
        original_score: string | null
        proposed_score: string
        reason: string
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
        voided_at: string | null
}

export interface ResultDetail {
        sheet: { id: number; status: KpiSheetStatus }
        quarter: Quarter
        assignment: AssignmentBrief
        result: ResultBrief | null
        months: string[]
        items: ResultItem[]
        calculated_by: UserRef | null
        reviewed_by: UserRef | null
        published_by: UserRef | null
        pending_override: ScoreOverride | null
        applied_override: ScoreOverride | null
        actions: {
                can_calculate: boolean
                can_review: boolean
                can_publish: boolean
                can_request_override: boolean
        }
        /** Every version of the result, oldest first (empty for the employee). */
        versions: ResultVersion[]
}

export interface ResultVersion {
        version_no: number
        status: ScoreResultStatus
        final_score: string | null
        override_score: string | null
        published_score: string | null
        calculated_at: string | null
        published_at: string | null
        correction_id: number | null
}

export interface CalculateResult {
        calculated: number
        unchanged: number
        published: number
        complete: number
}

// --- Quarterly review, normalization and publication (Stage L) ------------------------------

export interface QuarterOverview {
        quarter: Quarter
        next_status: QuarterStatus | null
        previous_status: QuarterStatus | null
        sheets: {
                locked: number
                calculated: number
                complete: number
                stale: number
                reviewed: number
                pending_overrides: number
                published: number
        }
        employees: {
                total: number
                ready: number
                multi_assignment: number
                weights_needed: number
        }
        cohorts: { total: number; approved: number; unresolved: number }
        /** Sheets never published before scoring started: not scored this quarter. */
        unscorable_sheets: number
        /** What blocks the next step, company-wide (for those who take it). */
        blockers: string[]
        feedback_enabled: boolean
        published_at: string | null
        published_by: UserRef | null
        actions: {
                can_advance: boolean
                can_return: boolean
                can_publish: boolean
                can_request_correction: boolean
        }
        /** The current published version (1 = the original publication). */
        published_version: number | null
        /** A correction requested or in progress. */
        open_correction: { id: number; status: CorrectionStatus; version_no: number | null } | null
}

export type NormalizationPlacement =
        | 'AUTO'
        | 'TIE_RULE'
        | 'TIE_RESOLVED'
        | 'SMALL_COHORT_DEFAULT'
        | 'SMALL_COHORT_RESOLVED'
        | 'NEEDS_RESOLUTION'
        | 'NOT_ELIGIBLE'
export type NormalizationRunStatus = 'DRAFT' | 'APPROVED' | 'PUBLISHED' | 'DISCARDED' | 'SUPERSEDED'
export type CohortLevel = 'COMPANY' | 'PLANT' | 'DEPARTMENT' | 'PLANT_DEPARTMENT'

export interface EmployeeComponent {
        assignment_id: number
        sheet_id: number
        plant: PlantRef
        department: DepartmentRef
        is_primary: boolean
        result_status: ScoreResultStatus | null
        score: string | null
        /** final | override */
        score_source: string | null
        weight: string | null
        contribution: string | null
        problems: string[]
        can_open_sheet: boolean
}

export interface NormalizationOutcome {
        run_id: number
        cohort_label: string
        run_status: NormalizationRunStatus
        rank: number | null
        group_key: string | null
        group_label: string | null
        placement: NormalizationPlacement | null
        placement_reason: string | null
        placed_by: UserRef | null
        normalized_rating: string | null
        rating_explanation: Record<string, unknown> | null
}

export interface EmployeeResult {
        employee: EmployeeRef
        quarter_id: number
        /** LIVE before normalization; DRAFT frozen for normalization; PUBLISHED final;
         * SUPERSEDED replaced by a corrected version. */
        status: 'LIVE' | 'DRAFT' | 'PUBLISHED' | 'SUPERSEDED'
        home_plant: PlantRef | null
        home_department: DepartmentRef | null
        /** SINGLE | CONFIGURED | MISSING | INVALID */
        weights_source: string
        calculated_score: string | null
        final_score: string | null
        ready: boolean
        issues: string[]
        components: EmployeeComponent[]
        normalization: NormalizationOutcome | null
        can_set_weights: boolean
        /** The row's version (null while live). */
        version_no: number | null
        /** Every version of the employee's result in the quarter (detail only). */
        versions: EmployeeResultVersion[]
}

export interface EmployeeResultVersion {
        version_no: number
        status: string
        final_score: string
        group_key: string | null
        normalized_rating: string | null
        published_at: string | null
}

export interface GroupDistribution {
        key: string
        label: string
        target_percent: string
        target_count: number
        actual_count: number
        actual_percent: string | null
}

export interface CohortSummary {
        id: number
        status: NormalizationRunStatus
        version_no: number
        cohort_label: string
        cohort_level: CohortLevel
        policy: {
                matrix_id: number
                code: string
                name: string
                version_id: number
                version_no: number
        }
        population: number
        eligible: number
        small_cohort: boolean
        distribution: GroupDistribution[]
        matches_targets: boolean
        unresolved: number
        rating_errors: number
        exceptions: number
        approved_by: UserRef | null
        approved_at: string | null
}

export interface CohortMember {
        employee: EmployeeRef
        home_plant: PlantRef
        home_department: DepartmentRef
        final_score: string
        calculated_score: string
        rank: number | null
        group_key: string | null
        group_label: string | null
        placement: NormalizationPlacement | null
        options: string[] | null
        placement_reason: string | null
        placed_by: UserRef | null
        normalized_rating: string | null
        rating_explanation: Record<string, unknown> | null
}

export interface CohortException {
        type: string
        message: string
        employee_ids: number[]
        groups: string[]
}

export interface Cohort extends CohortSummary {
        quarter: Quarter
        settings: NormalizationSettings | null
        policy_problem: string | null
        exception_list: CohortException[]
        members: CohortMember[]
        approval_note: string | null
        computed_at: string | null
        actions: { can_place: boolean; can_approve: boolean; can_reopen: boolean }
}

export type SheetCommentKind = 'REVIEW_COMMENT' | 'FEEDBACK'

export interface SheetComment {
        id: number
        kind: SheetCommentKind
        body: string
        author: UserRef | null
        created_at: string
}

export interface OwnSheet {
        id: number
        status: KpiSheetStatus
        quarter: Quarter
        assignment: AssignmentBrief
        items: SheetItem[]
        total: number
        published_score: string | null
        published_at: string | null
        outcome: {
                final_score: string
                group_label: string | null
                normalized_rating: string | null
                published_at: string | null
        } | null
        feedback: SheetComment[]
}

/** Settings of a NORMALIZATION policy version (see docs/matrix-framework.md). */
export interface NormalizationSettings {
        cohort_level: CohortLevel | null
        groups: { key: string; label: string; percent: string; remainder: boolean }[]
        size_rounding: string | null
        rank_by: string | null
        ties: string | null
        min_cohort_size: number | null
        small_cohort: string | null
        small_cohort_group: string | null
        eligible_designations: string[]
}

/** The choices a type's settings offer, with labels (normalization only). */
export interface MatrixSettingsOptions {
        kind: 'normalization'
        cohort_levels: Record<string, string>
        size_rounding: Record<string, string>
        rank_by: Record<string, string>
        ties: Record<string, string>
        small_cohort: Record<string, string>
        max_groups: number
}

// --- Stage M: annual results, annual deviations, quarter corrections ----------------------

export interface AuditEntry {
        id: number
        action: string
        summary: string
        reason: string | null
        actor: string
        occurred_at: string
}

export type CycleStatus = 'DRAFT' | 'ACTIVE' | 'CLOSED'

export interface AnnualRule {
        code: string
        version: number
        /** Quarter number -> weight % (text). */
        quarter_weights: Record<string, string>
        decimals: number
        rounding: string
        description: string
        sha256: string
}

export interface AnnualCycle {
        id: number
        code: string
        name: string
        start_date: string
        end_date: string
        status: CycleStatus
        quarters: Quarter[]
        rule: AnnualRule
        can_set_rule: boolean
}

export interface AnnualQuarter {
        quarter_id: number
        quarter_number: number
        name: string
        status: QuarterStatus
        weight: string
        required: boolean
        published: boolean
        score: string | null
        version_no: number | null
        employee_result_id: number | null
        /** Open corrections of the quarter that affect the employee. */
        correction_ids: number[]
}

export type AnnualResultStatus = 'CALCULATED' | 'PUBLISHED' | 'SUPERSEDED' | 'DISCARDED'

export interface AnnualVersion {
        id: number
        version_no: number
        status: AnnualResultStatus
        calculated_exact: string
        calculated_score: string
        adjusted_score: string | null
        final_score: string
        recalculation_required: boolean
        recalculation_reason: string | null
        calculated_by: UserRef | null
        calculated_at: string | null
        published_by: UserRef | null
        published_at: string | null
        approval_note: string | null
        previous_id: number | null
        superseded_at: string | null
        rule_version: number | null
        rule_sha256: string
}

export interface AnnualSource {
        quarter_id: number
        quarter_number: number
        quarter_name: string
        weight: string
        employee_result_id: number
        version_no: number
        final_score: string
        calculated_score: string
        weights_source: string
        published_at: string | null
        components: {
                sheet_id: number
                unit: string
                score: string | null
                weight: string | null
        }[]
        scoring: {
                sheet_id: number
                result_id: number | null
                result_version_no: number | null
                kpis: {
                        kpi_code: string
                        matrix_version_id: number | null
                        matrix_code: string | null
                        matrix_version_no: number | null
                        legacy_rule: boolean
                }[]
        }[]
        normalization: {
                run_id: number
                run_version_no: number
                matrix_version_id: number
                policy_version_no: number
                group_key: string | null
                normalized_rating: string | null
        } | null
}

export interface AnnualVersionDetail extends AnnualVersion {
        sources: AnnualSource[]
        rule: Record<string, unknown>
}

export type AnnualDeviationStatus = 'PENDING' | 'APPROVED' | 'REJECTED' | 'VOIDED'

export interface AnnualDeviation {
        id: number
        status: AnnualDeviationStatus
        annual_result_id: number
        version_no: number
        cycle_id: number
        cycle_name: string
        employee: EmployeeRef
        original_score: string
        proposed_score: string
        reason: string
        requested_by: UserRef | null
        requested_at: string
        decided_by: UserRef | null
        decided_at: string | null
        decision_reason: string | null
        voided_at: string | null
        can_decide: boolean
}

export interface AnnualRow {
        employee: EmployeeRef
        cycle_id: number
        home_plant: PlantRef | null
        home_department: DepartmentRef | null
        quarters: AnnualQuarter[]
        complete: boolean
        issues: string[]
        draft: AnnualVersion | null
        published: AnnualVersion | null
        pending_deviation: {
                id: number
                status: AnnualDeviationStatus
                original_score: string
                proposed_score: string
                requested_by: UserRef | null
                requested_at: string
        } | null
        actions: {
                can_calculate: boolean
                can_request_deviation: boolean
                can_decide_deviation: boolean
                can_finalize: boolean
        }
}

export interface AnnualDetail extends AnnualRow {
        versions: AnnualVersionDetail[]
        deviations: AnnualDeviation[]
        finalize_blockers: string[]
        history: AuditEntry[]
}

export interface AnnualCalculated {
        calculated: number
        unchanged: number
        incomplete: number
}

export interface OwnAnnual {
        cycle_id: number
        cycle_code: string
        cycle_name: string
        version_no: number
        final_score: string
        published_at: string | null
        quarters: { quarter_number: number; name: string; score: string }[]
        notice: string | null
}

export type CorrectionStatus =
        'REQUESTED' | 'REJECTED' | 'DEPARTMENT_REVIEW' | 'NORMALIZATION' | 'READY' | 'PUBLISHED'

export interface CorrectionValueIn {
        sheet_id: number
        kpi_definition_id: number
        period: string
        actual: string | null
        inputs?: Record<string, string> | null
}

export interface CorrectionWeightsIn {
        employee_id: number
        weights: { assignment_id: number; weight: string }[]
}

export interface CorrectionRequest {
        reason: string
        values: CorrectionValueIn[]
        weights: CorrectionWeightsIn[]
}

export interface CorrectionAffected {
        employees: EmployeeRef[]
        dependents: EmployeeRef[]
        cohorts: { run_id: number; label: string; members: number }[]
        annual_results_flagged: number[]
}

export interface CorrectionPreview {
        sheets: {
                sheet_id: number
                employee: string
                unit: string
                before: string | null
                after: string | null
                complete: boolean
        }[]
        employees: {
                employee_id: number
                employee: string
                before: string | null
                after: string | null
        }[]
        problems: string[]
        affected: CorrectionAffected
}

export interface CorrectionWeight {
        assignment_id: number
        unit: string
        weight: string
}

export interface CorrectionChange {
        id: number | null
        kind: 'VALUE' | 'WEIGHTS'
        employee: EmployeeRef | null
        unit: string | null
        sheet_id: number | null
        kpi_code: string | null
        kpi_name: string | null
        period: string | null
        had_value: boolean
        before_actual: string | null
        after_actual: string | null
        before_inputs: Record<string, unknown> | null
        after_inputs: Record<string, unknown> | null
        before_weights: CorrectionWeight[]
        after_weights: CorrectionWeight[]
}

export interface CorrectionSummary {
        id: number
        status: CorrectionStatus
        quarter: Quarter
        base_version: number
        version_no: number | null
        reason: string
        requested_by: UserRef | null
        requested_at: string
        items: number
}

export interface Correction extends CorrectionSummary {
        decided_by: UserRef | null
        decided_at: string | null
        decision_reason: string | null
        published_by: UserRef | null
        published_at: string | null
        changes: CorrectionChange[]
        preview: CorrectionPreview
        affected: CorrectionAffected | null
        sheets: {
                sheet_id: number
                employee: EmployeeRef
                unit: string
                status: ScoreResultStatus | null
                final_score: string | null
                published_score: string | null
        }[]
        cohorts: { run_id: number; label: string; status: string }[]
        next_status: CorrectionStatus | null
        previous_status: CorrectionStatus | null
        blockers: string[]
        actions: {
                can_decide: boolean
                can_advance: boolean
                can_return: boolean
                can_publish: boolean
        }
        history: AuditEntry[]
}

export interface QuarterVersion {
        version_no: number
        current: boolean
        correction_id: number | null
        published_by: UserRef | null
        published_at: string | null
}
