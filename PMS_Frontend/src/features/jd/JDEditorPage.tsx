import { Plus, Trash2 } from 'lucide-react'
import { useRef, useState, type FormEvent, type ReactNode } from 'react'
import { Link, useNavigate, useParams } from 'react-router'
import { ActionError } from '../../components/common/ActionError'
import { Alert } from '../../components/common/Alert'
import { Button } from '../../components/common/Button'
import { SelectField, TextAreaField, TextField } from '../../components/common/Fields'
import { PageHeader } from '../../components/common/PageHeader'
import { ErrorState, LoadingState } from '../../components/common/QueryStates'
import { buttonClasses, cardClasses } from '../../components/common/styles'
import { useAction } from '../../hooks/useAction'
import { useApiQuery } from '../../hooks/useApiQuery'
import { createJD, getJD, getJDVersion, updateJDVersion } from '../../services/jdApi'
import { listDesignations, listOrgUnits } from '../../services/organizationApi'
import type { DesignationRef, JDDetail, JDVersion, OrgUnit } from '../../types/api'
import { parseId } from '../../utils/params'
import { useCurrentUser } from '../auth/AuthContext'
import { isHrUser } from '../auth/permissions'
import { InvalidLink } from '../common/InvalidLink'
import { departmentsOf } from '../organization/orgUnits'
import {
        contentFromForm,
        emptyForm,
        formFromVersion,
        validateForm,
        type CompetencyRow,
        type FormErrors,
        type JDForm,
        type TextKey,
} from './jdForm'
import { E_SCALE, NATURE_OF_JOB, VACANCY_TYPES } from './jdLabels'

/** /jds/new */
export function JDCreatePage() {
        return <JDEditorLoader />
}

/** /jds/:jdId/versions/:versionId/edit */
export function JDEditPage() {
        const params = useParams()
        const jdId = parseId(params.jdId)
        const versionId = parseId(params.versionId)
        if (jdId === undefined || versionId === undefined)
                return <InvalidLink backTo="/jds" backLabel="Back to job descriptions" />
        return <JDEditorLoader jdId={jdId} versionId={versionId} />
}

function JDEditorLoader({ jdId, versionId }: { jdId?: number; versionId?: number }) {
        const isNew = jdId === undefined
        const units = useApiQuery('org-units', (signal) => listOrgUnits({}, signal))
        const designations = useApiQuery('designations', (signal) => listDesignations(signal))
        const existing = useApiQuery(
                isNew ? null : `jd-edit|${jdId}|${versionId}`,
                async (signal) => {
                        const [jd, version] = await Promise.all([
                                getJD(jdId!, signal),
                                getJDVersion(jdId!, versionId!, signal),
                        ])
                        return { jd, version }
                },
        )

        const failed = [units, designations, existing].find((q) => q.error !== undefined)
        if (failed) return <ErrorState error={failed.error} onRetry={failed.reload} />
        if (!units.data || !designations.data || (!isNew && !existing.data))
                return <LoadingState label="Loading the JD form…" />
        if (existing.data && existing.data.version.status !== 'DRAFT') {
                return (
                        <>
                                <PageHeader title="This version cannot be edited" />
                                <Alert
                                        tone="warning"
                                        action={
                                                <Link
                                                        to={`/jds/${jdId}?version=${versionId}`}
                                                        className={buttonClasses('secondary', 'sm')}
                                                >
                                                        Back to the JD
                                                </Link>
                                        }
                                >
                                        Only a draft can be edited. A version under review must be
                                        returned to draft first; an approved JD changes through a
                                        new revision.
                                </Alert>
                        </>
                )
        }
        return (
                <JDEditor
                        units={units.data}
                        designations={designations.data}
                        existing={existing.data}
                />
        )
}

interface EditorProps {
        units: OrgUnit[]
        designations: DesignationRef[]
        existing?: { jd: JDDetail; version: JDVersion }
}

function JDEditor({ units, designations, existing }: EditorProps) {
        const user = useCurrentUser()
        const navigate = useNavigate()
        const isNew = existing === undefined
        const [form, setForm] = useState<JDForm>(() =>
                existing
                        ? formFromVersion(existing.version, {
                                  title: existing.jd.title,
                                  departmentId: existing.jd.department.id,
                                  plantId: existing.jd.plant?.id ?? null,
                                  designationId: existing.jd.designation?.id ?? null,
                          })
                        : emptyForm(),
        )
        const [errors, setErrors] = useState<FormErrors>({})
        const summaryRef = useRef<HTMLDivElement>(null)
        const save = useAction()
        const hr = isHrUser(user)

        const set = (key: TextKey) => (value: string) =>
                setForm((current) => ({ ...current, [key]: value }))
        const bind = (key: TextKey) => ({
                value: form[key],
                error: errors[key],
                onChange: (event: { target: { value: string } }) => set(key)(event.target.value),
        })

        const departments = departmentsOf(units)
        const plantsForDepartment = units
                .filter((u) => String(u.department.id) === form.departmentId)
                .map((u) => u.plant)

        async function handleSubmit(event: FormEvent) {
                event.preventDefault()
                const found = validateForm(form, isNew)
                setErrors(found)
                if (Object.keys(found).length > 0) {
                        summaryRef.current?.focus()
                        return
                }
                const content = contentFromForm(form)
                const designation_id = form.designationId ? Number(form.designationId) : null
                if (isNew) {
                        const created = await save.run(() =>
                                createJD({
                                        ...content,
                                        title: form.title.trim(),
                                        department_id: Number(form.departmentId),
                                        plant_id: form.plantId ? Number(form.plantId) : null,
                                        designation_id,
                                }),
                        )
                        if (created) navigate(`/jds/${created.id}`)
                } else {
                        const saved = await save.run(() =>
                                updateJDVersion(existing.jd.id, existing.version.id, {
                                        ...content,
                                        title: form.title.trim(),
                                        designation_id,
                                }),
                        )
                        if (saved) navigate(`/jds/${existing.jd.id}?version=${saved.id}`)
                }
        }

        const errorList = Object.values(errors).filter(Boolean)
        const backTo = existing ? `/jds/${existing.jd.id}?version=${existing.version.id}` : '/jds'

        return (
                <>
                        <PageHeader
                                title={isNew ? 'New job description' : `Edit ${existing.jd.title}`}
                                description={
                                        isNew
                                                ? 'Create the JD for one unique role. It starts as a draft; the HOD proposes it, the Plant Head authorises it and the CHRO approves it.'
                                                : `Version ${existing.version.version_no} (draft) of ${existing.jd.code}.`
                                }
                                breadcrumbs={[
                                        {
                                                label: 'Job descriptions',
                                                to: '/jds',
                                        },
                                        ...(existing
                                                ? [
                                                          {
                                                                  label: existing.jd.title,
                                                                  to: backTo,
                                                          },
                                                  ]
                                                : []),
                                        { label: isNew ? 'New' : 'Edit' },
                                ]}
                        />
                        <form onSubmit={handleSubmit} noValidate className="space-y-6">
                                <div ref={summaryRef} tabIndex={-1} className="outline-none">
                                        {errorList.length > 0 && (
                                                <Alert
                                                        tone="danger"
                                                        assertive
                                                        title="Please correct the following"
                                                >
                                                        <ul className="list-disc pl-5">
                                                                {errorList.map((message) => (
                                                                        <li key={message}>
                                                                                {message}
                                                                        </li>
                                                                ))}
                                                        </ul>
                                                </Alert>
                                        )}
                                </div>
                                <ActionError error={save.error} />

                                <Section title="Role">
                                        <TextField
                                                label="Role title"
                                                hint="Specific to the role, e.g. “Quality Engineer — Inspection”."
                                                maxLength={150}
                                                required
                                                {...bind('title')}
                                        />
                                        {isNew ? (
                                                <>
                                                        <SelectField
                                                                label="Department"
                                                                value={form.departmentId}
                                                                error={errors.departmentId}
                                                                required
                                                                onChange={(e) =>
                                                                        setForm((f) => ({
                                                                                ...f,
                                                                                departmentId:
                                                                                        e.target
                                                                                                .value,
                                                                                plantId: '',
                                                                        }))
                                                                }
                                                                options={[
                                                                        {
                                                                                value: '',
                                                                                label: 'Choose…',
                                                                        },
                                                                        ...departments.map((d) => ({
                                                                                value: String(d.id),
                                                                                label: d.name,
                                                                        })),
                                                                ]}
                                                        />
                                                        <SelectField
                                                                label="Plant"
                                                                hint="Leave as “All plants” when the role is the same wherever the department exists."
                                                                value={form.plantId}
                                                                disabled={form.departmentId === ''}
                                                                onChange={(e) =>
                                                                        set('plantId')(
                                                                                e.target.value,
                                                                        )
                                                                }
                                                                options={[
                                                                        {
                                                                                value: '',
                                                                                label: 'All plants',
                                                                        },
                                                                        ...plantsForDepartment.map(
                                                                                (p) => ({
                                                                                        value: String(
                                                                                                p.id,
                                                                                        ),
                                                                                        label: p.name,
                                                                                }),
                                                                        ),
                                                                ]}
                                                        />
                                                </>
                                        ) : (
                                                <p className="text-sm text-slate-700 sm:col-span-2">
                                                        {existing.jd.department.name} ·{' '}
                                                        {existing.jd.plant?.name ?? 'All plants'}
                                                </p>
                                        )}
                                        <SelectField
                                                label="Designation (optional)"
                                                hint="Several roles may share one designation."
                                                value={form.designationId}
                                                onChange={(e) =>
                                                        set('designationId')(e.target.value)
                                                }
                                                options={[
                                                        {
                                                                value: '',
                                                                label: 'Not linked',
                                                        },
                                                        ...designations.map((d) => ({
                                                                value: String(d.id),
                                                                label: d.name,
                                                        })),
                                                ]}
                                        />
                                </Section>

                                <Section title="Document control">
                                        <TextField
                                                label="Format no."
                                                maxLength={50}
                                                {...bind('format_no')}
                                        />
                                        <TextField
                                                label="Rev / issue no."
                                                maxLength={20}
                                                {...bind('rev_issue_no')}
                                        />
                                        <TextField
                                                label="Effective date"
                                                type="date"
                                                {...bind('effective_date')}
                                        />
                                </Section>

                                <Section title="Manpower requisition">
                                        <TextField
                                                label="No. of vacancies"
                                                inputMode="numeric"
                                                maxLength={3}
                                                {...bind('vacancies')}
                                        />
                                        <SelectField
                                                label="Vacancy type"
                                                value={form.vacancy_type}
                                                onChange={(e) =>
                                                        set('vacancy_type')(e.target.value)
                                                }
                                                options={[
                                                        {
                                                                value: '',
                                                                label: 'Not specified',
                                                        },
                                                        ...Object.entries(VACANCY_TYPES).map(
                                                                ([value, label]) => ({
                                                                        value,
                                                                        label,
                                                                }),
                                                        ),
                                                ]}
                                        />
                                        <SelectField
                                                label="Nature of job"
                                                value={form.nature_of_job}
                                                onChange={(e) =>
                                                        set('nature_of_job')(e.target.value)
                                                }
                                                options={[
                                                        {
                                                                value: '',
                                                                label: 'Not specified',
                                                        },
                                                        ...Object.entries(NATURE_OF_JOB).map(
                                                                ([value, label]) => ({
                                                                        value,
                                                                        label,
                                                                }),
                                                        ),
                                                ]}
                                        />
                                        {form.vacancy_type === 'REPLACEMENT' && (
                                                <TextField
                                                        label="Replacement of"
                                                        maxLength={150}
                                                        {...bind('replacement_of')}
                                                />
                                        )}
                                        <TextAreaField
                                                label="Reason for hiring"
                                                maxLength={2000}
                                                className="sm:col-span-2"
                                                {...bind('hiring_reason')}
                                        />
                                </Section>

                                <Section title="Candidate requirements">
                                        <TextField
                                                label="Proposed CTC"
                                                maxLength={100}
                                                {...bind('proposed_ctc')}
                                        />
                                        <TextField
                                                label="Available budget for the department"
                                                hint={
                                                        hr
                                                                ? 'Filled by HR.'
                                                                : 'Filled by HR; read-only for you.'
                                                }
                                                maxLength={100}
                                                disabled={!hr}
                                                {...bind('available_budget')}
                                        />
                                        <TextField
                                                label="Minimum qualification"
                                                maxLength={255}
                                                {...bind('min_qualification')}
                                        />
                                        <TextField
                                                label="Work experience"
                                                maxLength={255}
                                                {...bind('work_experience')}
                                        />
                                        <TextField
                                                label="Languages"
                                                maxLength={255}
                                                {...bind('languages')}
                                        />
                                        <TextField
                                                label="Age band & gender"
                                                hint="Record only where the role genuinely and lawfully requires it."
                                                maxLength={100}
                                                {...bind('age_band_gender')}
                                        />
                                </Section>

                                <Section title="Job relationship">
                                        <TextField
                                                label="Reports to"
                                                maxLength={255}
                                                {...bind('reports_to')}
                                        />
                                        <TextField
                                                label="Supervises"
                                                maxLength={255}
                                                {...bind('supervises')}
                                        />
                                </Section>

                                <Responsibilities form={form} setForm={setForm} errors={errors} />

                                <Competencies
                                        title="Technical competencies"
                                        rows={form.technical}
                                        onChange={(technical) =>
                                                setForm((f) => ({
                                                        ...f,
                                                        technical,
                                                }))
                                        }
                                />
                                <Competencies
                                        title="Behavioural competencies"
                                        rows={form.behavioural}
                                        onChange={(behavioural) =>
                                                setForm((f) => ({
                                                        ...f,
                                                        behavioural,
                                                }))
                                        }
                                />

                                <Section title="Remarks by HR">
                                        <TextAreaField
                                                label="Role summary / remarks"
                                                rows={4}
                                                maxLength={5000}
                                                className="sm:col-span-2"
                                                {...bind('hr_remarks')}
                                        />
                                </Section>

                                <div className="flex flex-wrap gap-2">
                                        <Button
                                                type="submit"
                                                variant="primary"
                                                isLoading={save.busy}
                                        >
                                                {isNew ? 'Create draft' : 'Save draft'}
                                        </Button>
                                        <Link to={backTo} className={buttonClasses('ghost')}>
                                                Cancel
                                        </Link>
                                </div>
                        </form>
                </>
        )
}

function Section({ title, children }: { title: string; children: ReactNode }) {
        return (
                <fieldset className={`${cardClasses} p-4`}>
                        <legend className="px-1 text-base font-semibold text-slate-900">
                                {title}
                        </legend>
                        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">{children}</div>
                </fieldset>
        )
}

function Responsibilities({
        form,
        setForm,
        errors,
}: {
        form: JDForm
        setForm: (update: (form: JDForm) => JDForm) => void
        errors: FormErrors
}) {
        const update = (index: number, change: Partial<JDForm['responsibilities'][number]>) =>
                setForm((f) => ({
                        ...f,
                        responsibilities: f.responsibilities.map((s, i) =>
                                i === index ? { ...s, ...change } : s,
                        ),
                }))
        return (
                <fieldset className={`${cardClasses} space-y-4 p-4`}>
                        <legend className="px-1 text-base font-semibold text-slate-900">
                                Key responsibilities
                        </legend>
                        <p className="text-sm text-slate-600">
                                Group responsibilities under themed headings, one responsibility per
                                line.
                        </p>
                        {form.responsibilities.map((section, index) => (
                                <div
                                        key={index}
                                        className="space-y-2 rounded-md border border-slate-200 p-3"
                                >
                                        <TextField
                                                label={`Heading ${index + 1}`}
                                                maxLength={200}
                                                value={section.heading}
                                                error={errors[`responsibilities.${index}`]}
                                                onChange={(e) =>
                                                        update(index, {
                                                                heading: e.target.value,
                                                        })
                                                }
                                        />
                                        <TextAreaField
                                                label={`Responsibilities under heading ${index + 1}`}
                                                hint="One responsibility per line."
                                                rows={4}
                                                value={section.points}
                                                error={errors[`responsibilities.${index}.points`]}
                                                onChange={(e) =>
                                                        update(index, {
                                                                points: e.target.value,
                                                        })
                                                }
                                        />
                                        <Button
                                                size="sm"
                                                variant="ghost"
                                                onClick={() =>
                                                        setForm((f) => ({
                                                                ...f,
                                                                responsibilities:
                                                                        f.responsibilities.filter(
                                                                                (_, i) =>
                                                                                        i !== index,
                                                                        ),
                                                        }))
                                                }
                                        >
                                                <Trash2 aria-hidden="true" className="size-4" />
                                                Remove heading {index + 1}
                                        </Button>
                                </div>
                        ))}
                        <Button
                                size="sm"
                                disabled={form.responsibilities.length >= 20}
                                onClick={() =>
                                        setForm((f) => ({
                                                ...f,
                                                responsibilities: [
                                                        ...f.responsibilities,
                                                        {
                                                                heading: '',
                                                                points: '',
                                                        },
                                                ],
                                        }))
                                }
                        >
                                <Plus aria-hidden="true" className="size-4" />
                                Add heading
                        </Button>
                </fieldset>
        )
}

function Competencies({
        title,
        rows,
        onChange,
}: {
        title: string
        rows: CompetencyRow[]
        onChange: (rows: CompetencyRow[]) => void
}) {
        const singular = title.replace(/ies$/, 'y').toLowerCase()
        return (
                <fieldset className={`${cardClasses} space-y-3 p-4`}>
                        <legend className="px-1 text-base font-semibold text-slate-900">
                                {title}
                        </legend>
                        <p className="text-sm text-slate-600">
                                Required proficiency for the role on the E-Scale (1 = Awareness … 5
                                = Expert), not a candidate assessment.
                        </p>
                        {rows.map((row, index) => (
                                <div
                                        key={index}
                                        className="grid grid-cols-1 items-end gap-2 sm:grid-cols-[1fr_14rem_auto]"
                                >
                                        <TextField
                                                label={`${title} ${index + 1}`}
                                                maxLength={300}
                                                value={row.name}
                                                onChange={(e) =>
                                                        onChange(
                                                                rows.map((r, i) =>
                                                                        i === index
                                                                                ? {
                                                                                          ...r,
                                                                                          name: e
                                                                                                  .target
                                                                                                  .value,
                                                                                  }
                                                                                : r,
                                                                ),
                                                        )
                                                }
                                        />
                                        <SelectField
                                                label={`E-Scale for ${singular} ${index + 1}`}
                                                value={row.level}
                                                onChange={(e) =>
                                                        onChange(
                                                                rows.map((r, i) =>
                                                                        i === index
                                                                                ? {
                                                                                          ...r,
                                                                                          level: e
                                                                                                  .target
                                                                                                  .value,
                                                                                  }
                                                                                : r,
                                                                ),
                                                        )
                                                }
                                                options={Object.entries(E_SCALE).map(
                                                        ([value, label]) => ({
                                                                value,
                                                                label,
                                                        }),
                                                )}
                                        />
                                        <Button
                                                variant="ghost"
                                                aria-label={`Remove ${singular} ${index + 1}`}
                                                onClick={() =>
                                                        onChange(rows.filter((_, i) => i !== index))
                                                }
                                        >
                                                <Trash2 aria-hidden="true" className="size-4" />
                                        </Button>
                                </div>
                        ))}
                        <Button
                                size="sm"
                                disabled={rows.length >= 20}
                                onClick={() => onChange([...rows, { name: '', level: '3' }])}
                        >
                                <Plus aria-hidden="true" className="size-4" />
                                Add {singular}
                        </Button>
                </fieldset>
        )
}
