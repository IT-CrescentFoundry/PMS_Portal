# Configurable matrices and monthly scoring (Stage K)

How the PMS turns results into scores without hard-coded business rules,
and how to extend it. Schema details are in
[database-design.md](database-design.md#configurable-matrices-and-monthly-scoring-stage-k);
endpoints and permissions are in [api.md](api.md#configurable-matrices-stage-k).

## Principles

- **Declarative decision tables only.** A matrix version is JSON data: fields,
  rules with conditions and outputs, a "no rule matches" setting and test
  cases. Nothing in it is ever executed. User-supplied Python, JavaScript,
  SQL, shell commands and spreadsheet formulas are never evaluated; an
  uploaded workbook containing a formula is refused.
- **Nothing is decided silently.** Rules may not overlap, and an ambiguous
  match at evaluation time is an error, not a choice. Every range bound
  states whether the boundary value itself is included, so "more than 100%"
  (exactly 100% falls to the next rule, as in the source workbook) and "at
  least 100%" cannot be confused. The no-match behaviour is chosen
  explicitly: a default result, or stop with an error.
- **Exact arithmetic.** Numbers are `Decimal` end to end; NaN and infinity
  are refused; thousands and lakh grouping are accepted, a decimal comma is
  not. An input's `round_to` (half-up) is applied before matching. Quarterly
  scores are summed exactly and rounded half-up to two decimals once.
- **Versions never change after submission.** Each change is a new version.
  The HR Head authors (portal or Excel), the CHRO approves (never the author
  or submitter), and only then can a version be published. Rejected and
  draft versions are never used. A content hash (`definition_hash`) detects
  any in-place change to a published version; scoring refuses a version whose
  content no longer matches its hash.
- **No new tables per field.** A type's fields live in the registry and in
  each version's JSON. Adding a field never alters MySQL tables.
- **Protected attributes stay out.** Field keys or labels that look like a
  protected personal attribute (age, gender, sex, date of birth, religion,
  caste, marital status, pregnancy, ethnicity, race, nationality, disability)
  are refused. JD "age band and gender" is no longer collected either (see
  `app/services/jd.py`).

## Building blocks

| Concept | Where | What it is |
|---|---|---|
| Matrix type | `app/services/matrix_types.py` (`REGISTRY`) | What a kind of matrix may contain: standard inputs, fixed outputs, allowed custom data types and value source, limits, selection mode, read permission, lineage attributes, `schema_version`, and a `policy_note` while no approved configuration exists |
| Matrix | `matrices` | One lineage, e.g. `KSM-0005` "Delivery scoring"; type, name, attributes (e.g. the KPI direction) |
| Version | `matrix_versions` | The content (`definition` JSON), effective dates, where it applies (`matrix_version_scopes`), status and the full sign-off trail |
| Rule engine | `app/services/matrix_rules.py` | Parses, validates (`analyse`) and evaluates (`evaluate`) a definition. The portal, the API and Excel uploads all use it, so they cannot disagree |
| Workflow | `app/services/matrix_service.py` | Create, save draft, submit, withdraw, approve, reject, publish, revise; resolution of the version in force |
| Templates | `app/services/matrix_templates.py`, `matrix_uploads.py` | Generated workbooks and their parsing, preview and transactional confirm |

### Definition JSON

```json
{
  "fields": [
    {"key": "achievement_percent", "label": "Achievement %", "role": "input",
     "data_type": "PERCENT", "unit": "%", "required": true, "min": null, "max": null,
     "allowed_values": null, "source": "PERCENT_OF_TARGET", "aggregation": null,
     "round_to": null, "description": null},
    {"key": "score", "label": "Score", "role": "output", "data_type": "INTEGER",
     "min": "0", "max": "5"}
  ],
  "rules": [
    {"priority": 1, "label": "Above target",
     "conditions": {"achievement_percent": {"min": "100", "min_inclusive": false,
                                            "max": null, "max_inclusive": null}},
     "outputs": {"score": 5}}
  ],
  "no_match": {"mode": "default", "outputs": {"score": 1}},
  "test_cases": [{"label": "Exactly 100%", "inputs": {"achievement_percent": "100"},
                  "expected": {"score": 4}}]
}
```

Data types: `DECIMAL`, `INTEGER`, `PERCENT` (100 = 100 %), `DATE`,
`CATEGORY` (one of `allowed_values`), `BOOLEAN`. Conditions by type: a range
`{min, min_inclusive, max, max_inclusive}` for numbers and dates (at least
one bound; each given bound states its inclusivity), `{values: [...]}` for
categories, `{value: true|false}` for yes/no. An input without a condition
in a rule matches any value.

Value sources (an allow-list, there is no expression language):
`MANUAL`, `ACTUAL` (the KPI's quarterly actual), `TARGET`,
`PERCENT_OF_TARGET` (actual ÷ target × 100), `DIFFERENCE_FROM_TARGET`
(actual − target) and `IMPORTED` (its own column in the monthly import,
combined by the field's `aggregation`).

### What validation checks

Errors (block submission): unknown or duplicate fields, unsupported data
types, sources and operators, invalid or reversed bounds, NaN/infinity,
values outside a field's limits, empty ranges, category values not in the
list, missing or duplicate priorities, rules without conditions, **any
overlap between two rules** (pairwise; integers and dates are compared as
discrete values), missing outputs, a missing no-match choice, failing test
cases, and protected attributes. Warnings: values no rule covers (single
input), and scores that do not move in the KPI's direction. Submission also
needs an effective date and at least one place where the version applies.

## Workflow

```
DRAFT --submit--> SUBMITTED --approve (CHRO)--> APPROVED --publish--> PUBLISHED --> SUPERSEDED
  ^                  |  \--reject (CHRO, reason)--> REJECTED
  +----withdraw------+
```

- `revise` starts a new DRAFT copied from the latest version; only one open
  (draft or submitted) version per matrix exists at a time (a computed unique
  key enforces it).
- Approval: `matrix:approve` (CHRO) whose scope covers the version, not the
  author or submitter (also a database CHECK constraint).
- Publication: an HR Head or the CHRO. Versions are time-sliced: an earlier
  published version still in force ends the day before the new version's
  effective date, or is superseded when the new one starts at the same time.
- Selection: `REFERENCE` types (KPI scoring) are chosen by reference, through
  a KPI's scoring policy. `APPLICABILITY` types are resolved by unit and date,
  so their published versions may not overlap; publishing an overlapping
  version is refused (409).

## KPI scoring

- Each KPI-scoring matrix has one **scoring policy** (`POL-…`, same name and
  direction); KPIs refer to policies, as in Stage J. The Stage J policy
  endpoints still work and create or revise the policy's matrix from bands.
- **Publishing a KPI sheet** (and applying a deviation) binds every item to
  the version in force on the **quarter's start date**, and freezes it:
  `kpi_sheet_items.matrix_version_id`, a scoring snapshot with the
  `definition_hash`, and a measurement snapshot (frequency, aggregation,
  method). Publication is blocked when a policy has no approved, published
  version in force or a KPI's measurement is undefined. Later versions never
  change sheets already published; reopening a sheet releases the binding.
- **Monthly data** (`/scores/data`): CSV or Excel, one row per employee,
  KPI and month. Flow: choose quarter and month → check (column mapping,
  employee and assignment identification, duplicates, units, months, scope,
  values already stored) → preview → confirm (all or nothing, with an import
  record: file name, size, SHA-256, who and when; the file itself is not
  stored) → calculate → department review → publication with the whole
  quarter (Stage L). Replacing a stored value needs an
  explicit confirmation. Source values, calculated scores, reviewed scores
  and published scores are kept apart.
- **Calculation** (`app/services/kpi_results.py`): monthly values are
  combined by the KPI's aggregation, inputs are derived from their sources,
  the frozen version is evaluated, and the score × weightage ÷ 100 summed.
  A result is complete only with every expected month; it is stale when its
  inputs hash no longer matches the data. Each KPI's explanation (months,
  quarterly actual, inputs, matrix version, rule, score, contribution) is
  stored with the result.
- **Review and publication:** a KPI writer reviews a complete, current
  result (never their own). Since Stage L a result is published only with
  its whole quarter, after department review and normalization, by an HR
  Head or the CHRO with company-wide scope; it is then final.
- **Manual override** is a separate deviation: a reason, then HR Head and
  Plant Head approval (two different people, neither the requester). The
  calculated score is kept; new data voids a pending override.

## Normalization policies (Stage L)

`NORMALIZATION` (`NRM-…`, `matrix:read`) reuses the framework for versioning,
CHRO approval, effective dates, applicability (`APPLICABILITY` selection: at
most one published policy per unit and date) and hash-verified history. A
version has, besides its decision table, a `settings` object validated by the
type's `settings_hook` (`app/services/normalization_policy.py`):

| Setting | Values |
|---|---|
| `cohort_level` | COMPANY, PLANT, DEPARTMENT (one department across plants), PLANT_DEPARTMENT |
| `groups` | 2–7 groups, best first: `key`, `label`, target `percent` (≤ 2 decimals, total 100); exactly one takes the remainder |
| `size_rounding` | NEAREST (half up), DOWN, UP, for the groups other than the remainder |
| `rank_by` | FINAL_SCORE (2 decimals) or EXACT_SCORE |
| `ties` | REQUIRE_RESOLUTION (a reviewer places each tied employee, with a reason), HIGHER_GROUP, LOWER_GROUP; never split silently |
| `min_cohort_size`, `small_cohort`, `small_cohort_group` | below the minimum: REQUIRE_RESOLUTION, or DEFAULT_GROUP with a named group |
| `eligible_designations` | designation codes; empty means everyone |

The decision table maps the standard input `group` (and optionally `score`)
to the output `rating`. Its `group` allowed values must equal the settings'
group keys, and every group needs a rule (or a default). This is how a group
becomes a 1–5 rating: through an approved, configured table, never a fixed
mapping in code.

Normalization policies are configured **in the portal only** (the type has
`excel_templates = False`: no template download or upload). A new draft
starts with a 20/60/20 split and every other setting unchosen. The demo seed
adds `NRM-DEMO`, labelled as synthetic demo configuration (department
cohorts, ties placed by a reviewer, cohorts below 4 in the middle group,
example ratings 5/3/1); it is not company policy.

When a quarter enters normalization, `app/services/normalization.py`
resolves the policy for each employee's attribution unit on the quarter's
start date, freezes its definition hash into the cohort and verifies it again
at approval and publication. Placement, approval and the quarter lifecycle
are described in
[database-design.md](database-design.md#quarterly-review-normalization-and-publication-stage-l).

## Excel templates

Generated from the type's metadata (`GET /api/matrix-types/{code}/template`)
or from a version (`…/versions/{id}/template`). Sheets: Instructions, Matrix
(settings), Applies to, Fields, Rules, Test cases, Codes (plant and
department codes for the dropdowns) and a very hidden `_pms` sheet with the
template kind, `template_version`, matrix type, `schema_version`, matrix code
and version number. A hidden key row identifies every column, so labels can
be read by people while parsing relies on keys. Columns follow the fields:
`cond:<field>:<min|min_inclusive|max|max_inclusive|values|value>` and
`out:<field>` on Rules, `in:<field>` and `expect:<field>` on Test cases;
inclusivity, data types and yes/no cells use Excel validation lists.

Upload (`/matrices/upload`): preview validates and saves nothing; problems
are reported with their sheet and row and can be downloaded as CSV (cells
that a spreadsheet would read as a formula are neutralised). Confirm
re-validates and writes in one transaction, recording the uploader, file
name and SHA-256, and the template version. The action is explicit: create a
matrix, replace the open draft, or add a new draft version. A workbook with
an older `template_version` is rejected with a request to download a fresh
template; an older `schema_version` is accepted only through a registered
migration (below), otherwise rejected.

## Extending

All of these are code changes, reviewed and tested like any other. None
needs a database migration.

**Add a standard field to a type.** Add a `FieldSpec` to the type in
`matrix_types.py` (key, label, data type, role, unit, limits, source). Forms,
templates, upload parsing, previews and the monthly import columns pick it
up from `/api/matrix-types`. Existing versions keep their own field list.

**Add a matrix type.** Add a `MatrixTypeSpec` (unique `code` and
`code_prefix`, `read_permission`, `selection`, outputs) to `REGISTRY`.
Optional: `settings_hook` (validates a type-specific `settings` object),
`initial_definition` (content of a new draft) and `excel_templates = False`
(portal-only types, such as normalization policies). Until
its business values are approved, give it a `policy_note` beginning
"Awaiting approved configuration" and do not seed any values. Then wire the
module that will evaluate it (resolve with `matrix_service.resolve`, evaluate
with `matrix_rules.evaluate`, store the version id and hash with the result).

**Change what existing content means.** Bump the type's `schema_version` and
register `migrations[old_version] = function(definition) -> definition`.
Saved versions are never rewritten: the migration is applied when an older
template is uploaded and when a version saved on an older schema is checked.
Without a migration, older content is rejected and such a version cannot be
submitted.

**Change the workbook layout.** Bump `TEMPLATE_VERSION` in
`matrix_templates.py`; older workbooks are then refused with a clear message.

**Add a data type, value source or aggregation.** Extend the enums in
`matrix_types.py`, parsing and comparison in `matrix_rules.py`, the
derivation in `kpi_results._derive` (sources), and the frontend labels in
`PMS_Frontend/src/features/matrix/matrixLabels.ts`.

Tests to add with any of the above: `tests/test_matrix_rules.py` (parsing,
boundaries, overlaps, evaluation), `tests/test_matrix_templates.py`
(template round trip, old versions), `tests/test_matrices.py` (workflow and
permissions) and, in the frontend, `src/features/matrix/matrixDraft.test.ts`.

## Prepared types awaiting approved configuration

| Type | Code prefix | Inputs | Outputs | Read access |
|---|---|---|---|---|
| KRA performance matrix | `KRM` | weighted KPI score (+ custom) | performance rating 1–5 | `matrix:read` |
| Compa-ratio impact matrix | `CRM` | compa-ratio, performance rating | defined by HR | `matrix:read_compensation` |
| Increment matrix | `INM` | performance rating, compa-ratio | increment % | `matrix:read_compensation` |

No CR bands, salary-range midpoints, increment percentages, budget rules or
compensation values are defined anywhere in the code or the seed. These
types can be configured and approved in the portal, but nothing is
calculated with them until the later stages that use them.
