/** JD editor state (all text, as typed) and conversion to the API's content. */
import type { JDContent, JDVersion, NatureOfJob, VacancyType } from '../../types/api'

export interface CompetencyRow {
        name: string
        level: string
}

export interface SectionRow {
        heading: string
        /** One responsibility per line. */
        points: string
}

export interface JDForm {
        title: string
        departmentId: string
        /** '' = every plant where the department exists. */
        plantId: string
        designationId: string
        format_no: string
        rev_issue_no: string
        effective_date: string
        vacancies: string
        vacancy_type: string
        nature_of_job: string
        hiring_reason: string
        replacement_of: string
        proposed_ctc: string
        available_budget: string
        min_qualification: string
        age_band_gender: string
        work_experience: string
        languages: string
        reports_to: string
        supervises: string
        hr_remarks: string
        responsibilities: SectionRow[]
        technical: CompetencyRow[]
        behavioural: CompetencyRow[]
}

export type TextKey = Exclude<keyof JDForm, 'responsibilities' | 'technical' | 'behavioural'>

export function emptyForm(): JDForm {
        return {
                title: '',
                departmentId: '',
                plantId: '',
                designationId: '',
                format_no: '',
                rev_issue_no: '',
                effective_date: '',
                vacancies: '',
                vacancy_type: '',
                nature_of_job: '',
                hiring_reason: '',
                replacement_of: '',
                proposed_ctc: '',
                available_budget: '',
                min_qualification: '',
                age_band_gender: '',
                work_experience: '',
                languages: '',
                reports_to: '',
                supervises: '',
                hr_remarks: '',
                responsibilities: [{ heading: '', points: '' }],
                technical: [{ name: '', level: '3' }],
                behavioural: [{ name: '', level: '3' }],
        }
}

const text = (value: string | null | number) => (value === null ? '' : String(value))

export function formFromVersion(
        version: JDVersion,
        jd: {
                title: string
                departmentId: number
                plantId: number | null
                designationId: number | null
        },
): JDForm {
        return {
                title: jd.title,
                departmentId: String(jd.departmentId),
                plantId: jd.plantId === null ? '' : String(jd.plantId),
                designationId: jd.designationId === null ? '' : String(jd.designationId),
                format_no: text(version.format_no),
                rev_issue_no: text(version.rev_issue_no),
                effective_date: text(version.effective_date),
                vacancies: text(version.vacancies),
                vacancy_type: text(version.vacancy_type),
                nature_of_job: text(version.nature_of_job),
                hiring_reason: text(version.hiring_reason),
                replacement_of: text(version.replacement_of),
                proposed_ctc: text(version.proposed_ctc),
                available_budget: text(version.available_budget),
                min_qualification: text(version.min_qualification),
                age_band_gender: text(version.age_band_gender),
                work_experience: text(version.work_experience),
                languages: text(version.languages),
                reports_to: text(version.reports_to),
                supervises: text(version.supervises),
                hr_remarks: text(version.hr_remarks),
                responsibilities: version.responsibilities.map((s) => ({
                        heading: s.heading,
                        points: s.points.join('\n'),
                })),
                technical: version.technical_competencies.map((c) => ({
                        name: c.name,
                        level: String(c.level),
                })),
                behavioural: version.behavioural_competencies.map((c) => ({
                        name: c.name,
                        level: String(c.level),
                })),
        }
}

const orNull = (value: string) => value.trim() || null

function competencies(rows: CompetencyRow[]) {
        return rows
                .filter((row) => row.name.trim() !== '')
                .map((row) => ({
                        name: row.name.trim(),
                        level: Number(row.level),
                }))
}

export function contentFromForm(form: JDForm): JDContent {
        return {
                format_no: orNull(form.format_no),
                rev_issue_no: orNull(form.rev_issue_no),
                effective_date: orNull(form.effective_date),
                vacancies: form.vacancies.trim() === '' ? null : Number(form.vacancies),
                vacancy_type: (orNull(form.vacancy_type) as VacancyType | null) ?? null,
                nature_of_job: (orNull(form.nature_of_job) as NatureOfJob | null) ?? null,
                hiring_reason: orNull(form.hiring_reason),
                replacement_of: orNull(form.replacement_of),
                proposed_ctc: orNull(form.proposed_ctc),
                available_budget: orNull(form.available_budget),
                min_qualification: orNull(form.min_qualification),
                age_band_gender: orNull(form.age_band_gender),
                work_experience: orNull(form.work_experience),
                languages: orNull(form.languages),
                reports_to: orNull(form.reports_to),
                supervises: orNull(form.supervises),
                hr_remarks: orNull(form.hr_remarks),
                responsibilities: form.responsibilities
                        .filter((s) => s.heading.trim() !== '' || s.points.trim() !== '')
                        .map((s) => ({
                                heading: s.heading.trim(),
                                points: s.points
                                        .split('\n')
                                        .map((p) => p.trim())
                                        .filter(Boolean),
                        })),
                technical_competencies: competencies(form.technical),
                behavioural_competencies: competencies(form.behavioural),
        }
}

export type FormErrors = Partial<Record<string, string>>

/** Problems the user can fix before saving (the API re-checks everything). */
export function validateForm(form: JDForm, isNew: boolean): FormErrors {
        const errors: FormErrors = {}
        if (form.title.trim().length < 2)
                errors.title = 'Enter the role title (at least 2 characters).'
        if (isNew && form.departmentId === '') errors.departmentId = 'Choose the department.'
        const vacancies = form.vacancies.trim()
        if (vacancies !== '' && !/^\d{1,3}$/.test(vacancies))
                errors.vacancies = 'Enter a whole number from 0 to 999.'
        if (form.vacancy_type === 'REPLACEMENT' && form.replacement_of.trim() === '')
                errors.replacement_of = 'Name the role or person being replaced.'
        form.responsibilities.forEach((section, index) => {
                const heading = section.heading.trim() !== ''
                const points = section.points.trim() !== ''
                if (!heading && points)
                        errors[`responsibilities.${index}`] =
                                'Give this group of responsibilities a heading.'
                if (heading && !points)
                        errors[`responsibilities.${index}.points`] =
                                'Add at least one responsibility under this heading.'
        })
        if (form.responsibilities.length > 20) errors.responsibilities = 'Use at most 20 groups.'
        if (form.technical.length > 20 || form.behavioural.length > 20)
                errors.competencies = 'List at most 20 competencies of each kind.'
        return errors
}
