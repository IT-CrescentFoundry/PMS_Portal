# PMS Database Design — Foundational Schema

Status: **applied**. Migration `86106da9cf57` was applied to `pms` on
2026-10-12 and verified: 12 tables, 14 foreign keys, 7 CHECK constraints,
20 unique constraints, no drift.
Models live in `PMS_Backend/app/models/`.

## Conventions

- Every table has an internal integer `id` primary key. Business identifiers
  (`plants.code`, `departments.code`, `employees.employee_code`, ...) are
  separate, unique columns, so they can change without breaking relationships.
- No cascading deletes. Organizational records are deactivated
  (`is_active = 0`), never deleted, so historical scores and budgets keep
  their references.
- Constraint names follow the naming convention in `app/db.py`
  (`pk_`, `fk_`, `uq_`, `ix_`, `ck_`), so later migrations can alter them.
- `created_at` / `updated_at` are maintained by MySQL.
- Date ranges use an inclusive `effective_to`; `NULL` means "still current".

## Entity relationships

```mermaid
erDiagram
    plants ||--o{ plant_departments : "has"
    departments ||--o{ plant_departments : "exists at"
    plant_departments ||--o{ employee_assignments : "staffed by"
    employees ||--o{ employee_assignments : "has"
    designations ||--o{ employee_assignments : "title in"
    employees |o--o{ employee_assignments : "reporting manager"
    employees |o--o| users : "login"
    users ||--o{ user_roles : "granted"
    roles ||--o{ user_roles : ""
    user_roles ||--o{ user_role_scopes : "limited to"
    pms_cycles ||--|{ pms_cycle_quarters : "divided into"
```

| Table | Purpose | Key rules |
|---|---|---|
| `plants` | Plant master | `code`, `name` unique |
| `departments` | **Shared** department master ("Quality") | `code`, `name` unique; one row regardless of plant count |
| `plant_departments` | A department at a plant ("Quality — Plant A"). The unit for assignments, budgets and reports | unique (`plant_id`, `department_id`) |
| `designations` | Job titles; future anchor for standardized JDs | `code`, `name` unique |
| `employees` | **One row per person** | `employee_code` unique; exit ≥ joining |
| `employee_assignments` | Dated link employee → plant-department, with designation, reporting manager and `is_primary` | see below |
| `users` | Login account, separate from the employee profile | optional unique `employee_id` (one login per person) |
| `roles` | ADMIN, HR, CHRO, DEPT_HEAD, EMPLOYEE, BUDGET_USER (seeded later) | `code` unique |
| `user_roles` | Grants a role to a user | unique (`user_id`, `role_id`) |
| `user_role_scopes` | The organizational reach of a role grant | shape check + composite FK |
| `pms_cycles` | Annual cycle with configurable dates and status | `code` unique; end > start |
| `pms_cycle_quarters` | Four quarters per cycle, own dates, optional feedback flags | unique (`cycle_id`, `quarter_number`); 1–4 |

### Employee assignments (multi-plant employees)

Employee E001 working in Quality at Plant A and supporting Quality at Plant B
has one `employees` row and two `employee_assignments` rows. A transfer or
promotion closes the current row (sets `effective_to`) and inserts a new one,
so history is preserved.

The database enforces:
- `effective_to >= effective_from`, and a manager cannot be the employee.
- At most one **open** assignment per employee per plant-department.
- At most one **open primary** assignment per employee.
- No duplicate (employee, plant-department, start date).

MySQL has no partial unique indexes, so the two "open" rules use stored
generated columns (`open_assignment_flag`, `open_primary_employee_id`). These
are NULL for closed rows, and NULLs never collide in a unique index.

Overlap between closed historical ranges, and "every active employee has
exactly one primary assignment", are multi-row rules. They belong in the
service layer.

### Access scopes

Access is never inferred from a department name. Each role grant has explicit
scope rows:

| `scope_type` | `plant_id` | `department_id` | Meaning |
|---|---|---|---|
| `GLOBAL` | NULL | NULL | Everything (Admin, CHRO) |
| `PLANT` | set | NULL | All departments at one plant |
| `DEPARTMENT` | NULL | set | One department at every plant, including future plants |
| `PLANT_DEPARTMENT` | set | set | One department at one plant |

A CHECK constraint enforces this shape. A composite foreign key ensures that a
`PLANT_DEPARTMENT` scope names a department that actually exists at that
plant. A role grant with no scope rows grants no data access (deny by default).

These scopes are enforced on every API endpoint. The role capabilities and
the rules for combining multiple roles are in [api.md](api.md#authorization-model).

### Reporting scopes

Both report types are filters over the same `plant_departments` rows. There
are no duplicate department records:

- **Quality — Plant A**: `department_id = Quality AND plant_id = A`
- **Quality — All Plants**: `department_id = Quality` (every plant where it exists)

Every later fact table (KRA applicability, monthly performance, scores,
budgets, allocations) will reference `employee_assignments` or
`plant_departments`. Reports can therefore always be grouped per plant or
across plants. The API intersects the requested filter with the caller's
`user_role_scopes`.

### PMS cycle and quarters

Cycle and quarter boundaries are data, not calendar logic. The demo will seed
an April–March cycle as configuration only. Quarterly feedback is controlled
per quarter: `feedback_enabled` (default on) and `feedback_blocking`
(default off, so feedback is non-blocking).

## Multi-plant employees: approved business rules

Approved 2026-10-12. The foundational schema needs only `is_primary` for
these rules. The scoring, normalization and budget modules must implement
them as written.

### 1. Headcount
- Count each unique employee **exactly once**, attributed to their **primary**
  assignment. Two assignment rows must never produce two heads.
- Already implemented by `GET /api/reports/headcount`. Per-unit headcounts
  sum to the scope total. Secondary ("supporting") staff are reported
  separately, never added to headcount. Employees with a current assignment
  but no current primary are counted as a data issue, not silently dropped.

### 2. Quarterly 20–60–20 normalization
- Each employee is **one participant**, counted once in the applicable
  population.
- Population depends on the configured policy scope:
  - plant + department scope: attribute by primary assignment;
  - department-wide scope (all plants): use the consolidated departmental
    population.
- The policy (bands, scope, eligible population, minimum pool size,
  exceptions) is **configuration**, per cycle and overridable by
  department/plant/grade. It is never hard-coded.

### 3. Performance scoring across assignments
- KRA applicability and performance data are recorded **per assignment**,
  under one employee identity.
- The consolidated employee score is **not** a simple unweighted average of
  assignment scores. It uses an explicit, configurable aggregation policy.
  The preferred policy is **cycle-specific assignment contribution weights
  that total 100%**. An alternative must be another formally defined
  KRA-based weighting rule.
- **Missing or invalid weights** (absent, or not totalling 100%) flag the
  employee's score as blocked. A potentially misleading score is never
  published.
- Calculate one consolidated **quarterly** employee score before
  normalization, whenever the policy evaluates the employee as a single
  participant. Keep assignment-level scores for traceability.
- The **annual** score is derived from the *published* quarterly results,
  using the configured annual aggregation policy.

### 4. Budget and increment allocation
- For the demo, headcount and the employee-level increment are attributed to
  the **primary** assignment. They are never duplicated across plants.
- The design must allow a future, explicitly approved **cost-apportionment
  policy**, splitting one employee-related cost across units without
  duplicating the employee or the total increment. For example: a
  per-assignment apportionment table whose percentages total 100% and which
  references a single employee-level allocation record.
- Budget reconciliation must verify that each employee allocation is counted
  exactly once.

## Audit trail (`audit_events`, migration `bb82b01eddb7`)

This is the foundation for write-enabled modules (JD, KRA, scoring, budget,
approvals). Each consequential action adds one append-only row.

| Column | Meaning |
|---|---|
| `occurred_at`, `id` | When the action happened (server clock); `id` gives a strict order |
| `actor_type`, `actor_user_id`, `actor_username` | Who acted. `USER` rows must reference a user (CHECK constraint); `SYSTEM` is for automated jobs. The username is a snapshot. |
| `action` | Dotted code, e.g. `kra.update`, `jd.approve` |
| `entity_type`, `entity_id` | What was affected (indexed together for record history) |
| `plant_id`, `department_id` | Organizational context, so HR or Admin can later review events within their scope |
| `summary` | Safe, human-readable description (≤ 500 characters) |
| `reason` | Approved reason or justification, required when the action demands one |
| `changes` | JSON `{field: {"from", "to"}}` for the fields that changed |
| `request_id` | Optional correlation of several events from one request |

Rules (`app/services/audit.py`):

- **Same transaction.** `record_event()` adds the row to the caller's session
  and flushes, but never commits. The endpoint commits once, so a business
  change and its audit row are saved or rolled back together. Tests prove
  both cases.
- **Attribution.** The actor comes from the authenticated user
  (`AuditActorDep`), never from request input.
- **Safe content.** Values under keys that look like credentials or personal
  identifiers (password, token, secret, hash, API key, OTP, Aadhaar, PAN,
  bank account) are replaced with `[redacted]`. `changes` is limited to 16 KB,
  and unsupported value types are refused. Callers should list only the
  fields that matter.
- **Append-only.** No update or delete code exists. The database itself
  doesn't yet block UPDATE/DELETE on this table. For production, grant the
  application account only `INSERT, SELECT` on `audit_events`, or add a
  trigger, which needs additional MySQL privileges.

## JD and KPI management (Stage J)

Evidence: [business-requirements/stage-j-findings.md](business-requirements/stage-j-findings.md).

Decisions confirmed by the business (2026-10-14):

- A quarter **locks when an authorised user starts quarterly scoring**.
- Deviations are approved by an **HR Head** (new `HR_HEAD` role, or the CHRO)
  and a **Plant Head** (new `PLANT_HEAD` role). Both roles are plant-scoped,
  and two different people approve, neither of them the requester.
- The JD stores **all fields of the current JD format**, including the
  requisition fields.
- JD versions follow the format's **three-step sign-off**.

### Tables

| Table | Purpose | Key rules |
|---|---|---|
| `job_descriptions` | A **role** (not a designation): title, department, optional plant (NULL = every plant where the department exists), optional designation | `code` unique. One role title per department and plant: unique (`department_id`, plant key, `title`). The plant key is a generated column that makes NULL comparable. |
| `job_description_versions` | Every revision of a role's JD: document control, all current-format fields, responsibility sections and technical/behavioural competencies (JSON), and the sign-off trail | unique (`job_description_id`, `version_no`). At most one **APPROVED** version per JD, and at most one open draft (DRAFT, PROPOSED or AUTHORISED), both enforced by generated-column unique keys. Content can be edited only in DRAFT. |
| `kpi_scoring_policies` | Reusable **achievement matrix**: direction (higher-is-better, lower-is-better, zero tolerance), ordered bands `{threshold %, score}` with strict comparison as in the workbook, a fallback score, and met/breached scores for zero tolerance | `code` and `name` unique. Scores 0–5; whether 0 is allowed is still open (finding D5). |
| `kpi_definitions` | Shared **KPI library** entry: one row per *meaning* (name, description, unit, direction, default scoring policy, data source) | `code` and `name` unique. Reused across employees and quarters, never copied per employee. |
| `kpi_applicabilities` | Where a KPI may be used: department at a plant, a department at all plants, or company-wide | Plant and department are matched as a pair, with a composite FK to `plant_departments`; duplicates are blocked by generated-column keys. |
| `kpi_sheets` | An employee **assignment's KPI set for one quarter** (the assignment is the plant-department unit, per the approved multi-plant rules). Optional link to the role's JD. | unique (`employee_assignment_id`, `cycle_quarter_id`). Status DRAFT → PUBLISHED → LOCKED. |
| `kpi_sheet_items` | One KPI on a sheet: weightage, quarterly target and target note, unit, scoring policy. At publication, a **frozen copy of the policy** is stored so later policy edits never change history. | unique (`sheet_id`, `kpi_definition_id`). 0 < weightage ≤ 100, two decimal places. |
| `kpi_deviations` | Request to change a **locked** sheet: reason, original items, proposed items, HR Head and Plant Head approvals with timestamps, rejection | One PENDING request per sheet. The two approvers must differ (CHECK constraint), and neither may be the requester (service rule). |

### Workflow and validation

- **JD sign-off.** DRAFT → *propose* (Dept Head / HR / HR Head) → PROPOSED →
  *authorise* (Plant Head) → AUTHORISED → *approve* (CHRO) → APPROVED.
  - The previously approved version becomes SUPERSEDED.
  - Either reviewer can *return* the version to DRAFT with a reason.
  - Consecutive steps must be signed by different people.
  - A new revision copies the approved version into a new DRAFT.
  - "Available budget" can be set only by HR roles, as the form says.
- **KPI sheets.**
  - DRAFT sheets are edited freely, including via Excel upload.
  - **Publish** requires weightages to total exactly **100.00 %**. Totals are
    computed with decimals; 33.33 × 3 = 99.99 is refused.
  - Every KPI must be applicable to the assignment's plant and department,
    and the assignment must be current during the quarter.
  - Having fewer than 3 or more than 5 KPIs produces a warning, not an error
    (the requirements call the count guidance).
  - A published sheet can be reopened while its quarter has not started.
  - **Start quarterly scoring** (HR Head, CHRO or Admin, with company-wide
    scope) moves the quarter to OPEN and locks every published sheet. After
    that, no ordinary edit, publish or reopen is accepted for that quarter.
  - A sheet can be copied into a later quarter as a new draft.
- **Deviations.** Only for sheets in a started quarter.
  - The request records a reason and the full proposed item list, which must
    total 100 %.
  - When both approvals are present, the change is applied **in the same
    transaction** as the final approval.
  - It is audited with the original and revised values, both approvers and
    their timestamps.
- **Excel upload** (`.xlsx`, Department Head template).
  1. *Preview* parses and validates without writing.
  2. *Confirm* re-validates and writes all affected sheets as DRAFT in one
     transaction. It refuses if any error remains.

  Checks: employee in scope; assignment resolvable (plant and department
  required when ambiguous); KPI exists in the library and applies to that
  unit; no duplicate KPI per employee; numeric weightage and target; totals
  = 100 %; the quarter has not started. Uploaded sheets still need publishing:
  that is the review step.
- **Audit.** Every consequential action writes an `audit_events` row in the
  same transaction: JD create, edit and each sign-off step; KPI and policy
  changes; sheet edits, publish, reopen, upload and copy; quarter start; and
  deviation request, approval, rejection and application.

### Permissions (added to the role map)

| Capability | Roles | Scope |
|---|---|---|
| Read JDs, KPIs, policies, sheets | all `org:read` roles; employees see their own sheets | scoped |
| Create and edit JD drafts, propose | DEPT_HEAD, HR, HR_HEAD, ADMIN | scoped |
| Authorise JD | PLANT_HEAD | scoped |
| Approve JD | CHRO | scoped |
| KPI library, sheets, upload, publish, reopen, request deviation | DEPT_HEAD, HR, HR_HEAD, ADMIN | scoped; company-wide KPIs and policies need GLOBAL |
| Start quarterly scoring | HR_HEAD, CHRO, ADMIN | **GLOBAL** only |
| Approve deviation as HR Head | HR_HEAD, CHRO | scoped to the sheet's unit |
| Approve deviation as Plant Head | PLANT_HEAD | scoped to the sheet's unit |

### Not in Stage J

Monthly and quarterly actuals, score computation for real data, the
scoring-period workflow, normalisation, increments, CR and budgets. A
`preview` endpoint evaluates a scoring policy for a given achievement %; it
exists to check policies against the workbook examples.

## Deferred, by design

- **Normalization policy** (configurable 20–60–20 bands, eligible population,
  minimum pool size, exceptions) will be added as a per-cycle configuration
  table when quarterly normalization is built. It will reference `pms_cycles`.
- Grades and salary bands (needed for compa-ratio), JDs, KRAs, monthly data,
  scores and budgets come in later stages.
- Role-assignment history and audit logging. `user_roles` currently represents
  current access only.
- Timestamps use the MySQL server clock (local time). Revisit before any
  multi-timezone deployment.
