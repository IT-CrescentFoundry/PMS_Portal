import type { BadgeTone } from '../../components/common/Badge'
import type { JDVersionStatus, NatureOfJob, VacancyType } from '../../types/api'

export const JD_STATUS: Record<JDVersionStatus, { label: string; tone: BadgeTone }> = {
        DRAFT: { label: 'Draft', tone: 'warning' },
        PROPOSED: { label: 'Proposed · awaiting Plant Head', tone: 'info' },
        AUTHORISED: { label: 'Authorised · awaiting CHRO', tone: 'info' },
        APPROVED: { label: 'Approved', tone: 'success' },
        SUPERSEDED: { label: 'Superseded', tone: 'neutral' },
}

export const VACANCY_TYPES: Record<VacancyType, string> = {
        NEW: 'New position',
        REPLACEMENT: 'Replacement',
        EXISTING: 'Existing position',
}

export const NATURE_OF_JOB: Record<NatureOfJob, string> = {
        PERMANENT: 'Permanent',
        TEMPORARY: 'Temporary',
        CONTRACTUAL: 'Contractual',
}

/** E-Scale of the current JD format: required proficiency for the role,
 *  not a candidate assessment (wording from the format's own note). */
export const E_SCALE: Record<number, string> = {
        1: '1 · Awareness',
        2: '2 · Basic',
        3: '3 · Working proficiency',
        4: '4 · Advanced',
        5: '5 · Expert',
}
