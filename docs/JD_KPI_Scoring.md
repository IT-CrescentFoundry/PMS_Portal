# Stage J — Workbook Analysis (JD and KPI)

Audience: the PMS project team. This document records what the three
business-reference workbooks establish, so the JD/KPI design can be checked
against the evidence.

**Confidentiality.** The source workbooks are stored in `docs/brd/`, which is
excluded from Git (`.gitignore`). This analysis describes structure, rules and
formulas only. It deliberately leaves out personal names, salary figures,
plant names and business targets that appear in the files; examples are
described generically.

## 1. Method

- Read with `openpyxl` 3.1.5 in **read-only fashion** (never saved). Each file
  was loaded twice: once for formula text, once for Excel's cached results.
  SHA-256 hashes were recorded before and after the analysis to confirm the
  files were not modified.
- Every worksheet was inspected for: visibility, used range, merged regions,
  every non-empty cell, formulas with cached values, data-validation lists,
  comments, defined names, tables, hidden rows/columns and conditional
  formatting.
- Every scoring formula was **re-implemented independently and compared with
  Excel's cached results**. All 24 quarterly scores, all achievement
  percentages and the weighted annual score (2.875) matched exactly. The
  formula readings below are therefore verified, not inferred.

| Workbook | Worksheets | Hidden content | Defined names / tables |
|---|---|---|---|
| `PMS Prerequisites.xlsx` | `Sheet1` (visible) | none | none |
| `Current JD Format.xlsx` | `Table 1` (visible) | none | none |
| `Previous JD Format.xlsx` | `Manager Quality` (visible) | none | none |

## 2. `PMS Prerequisites.xlsx` — `Sheet1`

Title (B1): *"PMS Calculations and Formula Example Sheet"*. B2 lists the
prerequisites to be shared: **JD, MIS, Org structure with Reporting
Relationship**.

The sheet holds several independent blocks:

| Block | Cells | Stage it concerns |
|---|---|---|
| KPI format and quarterly scoring | B4:Q15 | **J** (format, scoring policies), K (scoring) |
| Increment matrix (hypothetical) | T6:Y10, K17:P21 | Budget / increment stage |
| Scoring matrix example (10 sample employees) | B17:I29 | Budget / increment stage |
| Company budget and plant performance matrix | B31:I38 | Budget stage |
| Compa-ratio (CR) | B41:O53 | Budget / increment stage |
| Normalisation (bell curve) | B55:D57 | Normalisation stage |

### 2.1 KPI format (B4:Q13)

**Header row (row 6).** KPI · Weightage · Target Per Quarter · Q1–Q4
Achievement · Q1–Q4 Achievement % · Q1–Q4 Score · Average of 4 Quarters.

**Level (B5/I5).** One level band is chosen per sheet. I5 has a list data
validation whose source is broken (`formula1 = #REF!`). The three level values
used elsewhere on the sheet are **"L4 and Below"**, **"L2- L3"** and
**"L & L 1"**.

**Example (rows 7–12).** Six KPIs with weightages 20 / 10 / 10 / 20 / 20 /
20 %. `C13 = SUM(C7:C12)` = 100 % — **the weightage total is checked**. The
KPI themes are profitability, dispatch volume, inventory days, quality claims
and complaints, on-time delivery and productivity.

**Quarterly target.** Annual targets are pro-rated by formula, e.g.
`D7 = (annual/12)*3`. Some quarterly achievements are sums of monthly values,
e.g. `E8 = 1706+3228`. In other words, monthly MIS data rolls up into
quarterly actuals.

**Achievement %.** For a measured KPI: `= Actual / Target`, for both
directions. For the zero-tolerance KPI: `= IF(Actual>0, 0%, 100%)`.

**Quarter score.** One of the KPI-specific matrices in 2.2.

**Annual KPI score.** `Q = AVERAGE(Q1..Q4 scores)` per KPI. The overall score
is `Q13 = SUMPRODUCT(weightages, KPI averages)` = 2.875 in the example.

**Manager's final score (Q14).** Entered as **3**, not computed. It could be
rounding of 2.875 or a manager override; the sheet doesn't say which.

**Increment % (Q15)** = 8 %. This is the increment-matrix value for level
"L2- L3" at score 3, consistent with I5.

### 2.2 Achievement matrices (verified)

Comparisons are **strict**, exactly as in the formulas. *p* = achievement %.

| ID | Used for | Direction | Matrix | Cells |
|---|---|---|---|---|
| **A** | Profitability, dispatch volume | Higher is better | *p* > 100 % → 5; > 90 % → 4; > 80 % → 3; > 70 % → 2; > 50 % → 1; otherwise **0** | M7:P8 |
| **B** | Inventory days | Lower is better | *p* < 100 % → 5; < 110 % → 4; < 120 % → 3; < 150 % → 2; otherwise 1 | M9:P9 |
| **C** | Quality claims and complaints (target 0) | Zero tolerance | As written: *p* = `IF(actual>0,0,100%)`, score = `IF(p<=0%,5,0)` | I10:P10 |
| **B′** | On-time delivery (target 95 %) | Uses matrix **B** | Same as B | M11:P11 |
| **E** | Productivity | Higher is better | *p* > 95 % → 5; > 90 % → 4; > 80 % → 3; > 70 % → 2; otherwise 1; blank input → blank score | M12:P12 |

Boundary behaviour confirmed by the formulas:

- **Matrix A:** reaching the target exactly (*p* = 100 %) scores **4**; only
  exceeding it scores 5.
- **Matrix B:** *p* = 100 % also scores **4**.
- **Matrix A** can return **0** (*p* ≤ 50 %), outside the confirmed 1–5
  scale. Matrices B and E never go below 1.
- **Matrix E** has a different top band from A (> 95 % rather than > 100 %)
  and no 0. This confirms that **matrices differ by KPI**.

### 2.3 Defects and inconsistencies found

| # | Location | Finding | Effect in the example |
|---|---|---|---|
| D1 | `Sheet1` I10:P10 | Zero-tolerance logic is **inverted**: a quarter with claims gets *p* = 0 % and then **5**; a quarter with no claims gets *p* = 100 % and then **0** | Q1/Q2, which had claims, scored 5; Q3/Q4, with no claims, scored 0 |
| D2 | `Sheet1` M11:P11 | On-time delivery is higher-is-better, but uses the **lower-is-better** matrix B | 56 %–95 % achievement all scored **5** |
| D3 | `Sheet1` B12 vs D12 | The label says target 3.5; the target cell holds **5** | Achievement % is computed against 5 |
| D4 | `Sheet1` I5 | The level drop-down's source is broken (`#REF!`) | Level must be typed by hand |
| D5 | `Sheet1` M7:P8 | Matrix A yields 0, but the rating scale is 1–5 | Whether 0 is a valid rating needs confirming |
| D6 | `Sheet1` D37 | "Total" budget is `AVERAGE` of the A–D percentages | Not a weighted total (budget stage) |
| D7 | `Sheet1` G43:G52 | CR multiplier returns blank below 60 % CR; labels stop at 150 % while the formula applies 0.75 to every CR ≥ 135 % | Budget stage |

### 2.4 Blocks for later stages (recorded, not implemented in Stage J)

- **Increment matrix (T7:Y10 and K18:P21), increment % by level and final
  score 1–5:**
  - "L4 and Below": 4 / 6 / 9 / 12 / 15 %
  - "L2- L3": 0 / 4 / 8 / 11 / 13 %
  - "L & L 1": 0 / 0 / 6 / 8 / 10 %

  The sheet calls the matrix "Hypothetical".
- **Scoring matrix example (B18:I29).** Columns are employee, level,
  department, location, final KRA score, increment %, current CTC and new
  proposed budget (`= CTC*(1+increment%)`). The approximate overall budget
  increase is `G29 = (ΣNew − ΣCurrent)/ΣCurrent`.
- **Company budget and plant performance matrix (B31:I38).** Company budget
  is a percentage. Plant grades A–D map to KPI score 4–1 with a budget
  multiplier of 125 / 100 / 75 / 50 %. A score-to-multiplier table maps
  5 → 1.5 down to 1 → 0.5. There is a 1 % buffer.
- **Compa-ratio (B41:O53).** CR = present salary / market salary. The CR
  multiplier is ≥ 135 % → 0.75, ≥ 120 % → 0.8, ≥ 100 % → 1.0, ≥ 90 % → 1.1,
  ≥ 80 % → 1.15, ≥ 70 % → 1.2, ≥ 60 % → 1.3. Increment with CR impact =
  multiplier × proposed increment.
- **Normalisation (B55:D57).** Top 20 % · Middle 60 % · Bottom 20 %. This
  matches the approved configurable 20–60–20 rule.

## 3. `Current JD Format.xlsx` — `Table 1`

The sheet is titled **"MANPOWER REQUISITION FORM"** (B1) with a **"JOB
DESCRIPTION"** section (A4): the current format combines a requisition with
the JD.

| Section | Fields (cells) |
|---|---|
| Document control | Format No (D1), Rev/Issue No (D2), Effective Date (D3/E3) |
| Job description | Job Title/Position (A5/B5) · Department/Division (C5/D5) · No. of Vacancies (A6) · Location/Plant/Unit (C6/D6) · Type of Vacancy *New / Replacement / Existing* (A7) · Nature of the Job *Permanent / Temporary / Contractual* (C7) · If New, reason for hiring (A8) · If Replacement, replacement of whom (A9) |
| Candidate requirements | Proposed monthly CTC (A11) · Available budget for the department, *filled by HR* (C11) · Education qualification, minimum (A12) · Age band (max) and gender (A13) · Work experience required (A14) · Languages known (A15) |
| Job relationship | Reports to, functionally / administratively (A17) · Supervises, team size (C17) · Remarks by HR (A18), which in the sample holds the **role summary / purpose** |
| Job responsibilities | Rows A20:A25: **themed sections**, each a heading followed by bullet points (6 sections in the sample) |
| Competencies / skills required | **Technical competencies** (A28:A33) with *E-Scale (1 to 5)* (B), and **behavioural competencies** (C28:C33) with *E-Scale (1 to 5)* (D). 6 + 6 in the sample. |
| Sign-off | **Proposed by: Hiring Manager / HOD** · **Authorised by: Plant Head** · **Approved by: COO / CHRO** · Date |

Comment on B27 (E-Scale): *"Suggested required proficiency: 1 = Awareness,
2 = Basic, 3 = Working proficiency, 4 = Advanced, 5 = Expert. Ratings indicate
role requirements, not candidate assessment."*

## 4. `Previous JD Format.xlsx` — `Manager Quality`

| Section | Fields |
|---|---|
| Header | Job Title/Position · Department/Division · **Grade/Category** · Location/Plant/Unit (sample: "all plants") · **Type of Role** · **Reference document / source from MPP** |
| Candidate profile | Salary range (annual CTC) · Education qualification · Age band and gender · Work experience · **Profile stability** · **Preferred industry** · **Scale of business** · **Work exposure** · **Team size dealt with** · **Personality and communication** · **Computer skills** · **Preferred base location** · Languages |
| Job relationship | **Job purpose / statement** · **Dealing chart** · Reports to · Team size to be supervised |
| Job responsibilities | **JR 1 … JR 12**: one numbered paragraph each, "Title: description" |
| Candidate score card | Essential competencies **E1–E5** and behavioural **B1–B6**, with a "Scale (1 to 5)" column that actually holds **weights** (0.05–0.2) |
| Other | Psychometric (role-fitment score) · Career growth chart (year / role / salary) · Interview panels 1–2 with objectives · Interview flow |
| Sign-off | JD prepared by · JD approved by · Rev. date |

Defect: `C50 = SUM(C41:C49)` = 0.9 leaves out C40 (0.2); all ten weights
total 1.1. `D50 = SUMPRODUCT(C40:C49, D40:D49)` = 0 because there is no rating
column. The score card's weights therefore don't total 100 %.

## 5. Current vs previous JD format

| Change | Fields |
|---|---|
| **Retained** | Job title · Department · Location/plant · Education · Age band and gender · Work experience · Languages · Reports to · Team size supervised · Responsibilities · Competencies · Sign-off |
| **Revised** | Responsibilities: numbered JR 1–12 → **themed sections with bullets**. Competencies: weighted *candidate score card* → **required proficiency (1–5) for the role**, split **technical / behavioural**. Sign-off: prepared / approved → **proposed (HOD) → authorised (Plant Head) → approved (COO/CHRO)**. Job purpose → "Remarks by HR". |
| **Added** | Document control (format no, revision, effective date) · requisition fields (vacancies, vacancy type, reason, replacement of, nature of job, proposed CTC, department budget filled by HR) |
| **Removed** | Grade/category · Type of role (became "nature of job") · Source from MPP · Profile stability · Preferred industry · Scale of business · Work exposure · Personality · Computer skills · Preferred base location · Dealing chart · Candidate score card weights · Psychometric · Career growth chart · Interview panels/flow |

**Interpretation.** The current format separates *what the role requires*
(responsibilities and required proficiency) from *how candidates are assessed*
(dropped). It also adds requisition data, which belongs to hiring rather than
to performance management.

## 6. Rule classification

### Confirmed rules (from `stage_j_requirements.md`, consistent with the workbooks)
1. JDs are per **unique role and responsibilities**, not per designation.
   Several JDs may share a designation and department.
2. KRA = KPI. Each KPI is measurable, with a target and a weightage.
3. An employee's KPI weightages total **100 %** for the relevant assignment
   and cycle. `Sheet1` C13 performs exactly this check.
4. 3–5 KPIs is guidance and up to 8 is allowed; it is not a hard limit. The
   example has 6.
5. Ratings use a **1–5** scale.
6. **Matrices differ by KPI.** `Sheet1` uses at least four distinct matrices.
7. Department Heads supply KPIs via Excel upload, with validation and review.
8. After quarterly scoring starts, ordinary KPI changes are locked.
   Deviations need **HR Head and Plant Head** approval and are audited.

### Workbook-derived rules (adopted as configuration defaults)
- KPI fields: name/description, weightage, target per quarter, and an
  achievement % derived from actual and target.
- Directions: **higher is better**, **lower is better** and **zero
  tolerance**.
- Score bands with strict comparisons as in matrices A, B and E.
- Annual score = average of quarterly scores per KPI, then weighted by
  weightage. (Implemented in the scoring stage, not J.)
- JD content: the current format's role-definition fields, technical and
  behavioural competencies with required proficiency 1–5, and the three-step
  sign-off.

### Illustrative only (not rules)
The KPI names, targets and actuals; the ten sample employees, CTCs and
budgets; and the "hypothetical" increment matrix values.

### Ambiguities requiring business confirmation

Items 1–5 were closed by the business on 2026-10-26 (Stage L). The answers
are configuration rules; they impose no global scoring direction and no
company matrix values:

1. **D1 — closed.** Scoring is configured per KPI through its approved
   matrix. A genuine zero-tolerance KPI may score **5 for no incidents and 0
   for one or more** when that rule is approved for it. The workbook's
   inverted formula is not reproduced.
2. **D2 — closed.** Each KPI's direction and matrix are chosen explicitly
   and approved; nothing is inferred from a KPI's name and no global
   direction applies. On-time delivery uses whichever matrix is approved for
   it.
3. **D5 — closed.** A **KPI score of 0** is allowed where the KPI's approved
   matrix gives it. It is separate from the **1–5 performance-rating scale**:
   a score becomes a rating only through an approved, configured mapping
   (for example a normalization policy's group-to-rating table).
4. **Exactly on target — closed by configuration.** Each matrix states
   whether every band boundary is included; the matrix approved for a KPI
   decides whether 100 % scores 4 or 5. The demo matrices reproduce the
   workbook (strict: 100 % scores 4); that is demo data, not company policy.
5. **Manager's final score (Q14) — closed.** A manager's or employee's
   score is **calculated** from weighted KPI contributions (exact sum,
   rounded half-up to 2 decimals). A manual change is a **controlled
   deviation**: a score override with a reason, approved by the HR Head and
   Plant Head and audited, never a typed-in figure.

Still open:

6. **JD scope:** whether requisition fields belong in the PMS JD.
7. **Lock trigger:** when quarterly scoring "starts". The requirements
   document asks for this to be confirmed.
8. **Approvers:** who acts as **HR Head** (CHRO or a plant HR head), and
   whether a Plant Head role exists per plant.
