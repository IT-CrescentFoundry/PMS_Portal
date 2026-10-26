import { cardClasses } from '../../components/common/styles'
import type { NormalizationSettings } from '../../types/api'

const LEVELS: Record<string, string> = {
        COMPANY: 'Whole company',
        PLANT: 'Each plant',
        DEPARTMENT: 'Each department across all plants',
        PLANT_DEPARTMENT: 'Each department at each plant',
}
const ROUNDING: Record<string, string> = {
        NEAREST: 'nearest whole number (half up)',
        DOWN: 'rounded down',
        UP: 'rounded up',
}
const TIES: Record<string, string> = {
        REQUIRE_RESOLUTION: 'placed by an authorized reviewer',
        HIGHER_GROUP: 'all go to the better group',
        LOWER_GROUP: 'all go to the lower group',
}

/** A normalization policy version's settings, in words. */
export function SettingsSummary({ settings }: { settings: NormalizationSettings }) {
        const small =
                settings.small_cohort === 'DEFAULT_GROUP'
                        ? `everyone in ${settings.groups.find((g) => g.key === settings.small_cohort_group)?.label ?? settings.small_cohort_group ?? '—'}`
                        : settings.small_cohort === 'REQUIRE_RESOLUTION'
                          ? 'placed by an authorized reviewer'
                          : 'not chosen yet'
        return (
                <section
                        aria-labelledby="policy-settings-heading"
                        className={`${cardClasses} space-y-2 p-4`}
                >
                        <h2
                                id="policy-settings-heading"
                                className="text-base font-semibold text-slate-900"
                        >
                                Normalization settings
                        </h2>
                        <dl className="grid grid-cols-1 gap-3 text-sm sm:grid-cols-2">
                                <div>
                                        <dt className="font-medium text-slate-700">Cohorts</dt>
                                        <dd>
                                                {settings.cohort_level
                                                        ? LEVELS[settings.cohort_level]
                                                        : 'Not chosen yet'}
                                        </dd>
                                </div>
                                <div>
                                        <dt className="font-medium text-slate-700">
                                                Groups (best first)
                                        </dt>
                                        <dd>
                                                {settings.groups
                                                        .map(
                                                                (g) =>
                                                                        `${g.label} ${g.percent} %${g.remainder ? ' (remainder)' : ''}`,
                                                        )
                                                        .join(' · ')}
                                        </dd>
                                </div>
                                <div>
                                        <dt className="font-medium text-slate-700">Group sizes</dt>
                                        <dd>
                                                {settings.size_rounding
                                                        ? ROUNDING[settings.size_rounding]
                                                        : 'Not chosen yet'}
                                        </dd>
                                </div>
                                <div>
                                        <dt className="font-medium text-slate-700">Ranked by</dt>
                                        <dd>
                                                {settings.rank_by === 'EXACT_SCORE'
                                                        ? 'Exact (unrounded) score'
                                                        : settings.rank_by === 'FINAL_SCORE'
                                                          ? 'Final score (2 decimals)'
                                                          : 'Not chosen yet'}
                                        </dd>
                                </div>
                                <div>
                                        <dt className="font-medium text-slate-700">
                                                Ties at a boundary
                                        </dt>
                                        <dd>
                                                {settings.ties
                                                        ? TIES[settings.ties]
                                                        : 'Not chosen yet'}
                                        </dd>
                                </div>
                                <div>
                                        <dt className="font-medium text-slate-700">
                                                Cohorts below {settings.min_cohort_size ?? '—'}
                                        </dt>
                                        <dd>{small}</dd>
                                </div>
                                <div>
                                        <dt className="font-medium text-slate-700">Eligible</dt>
                                        <dd>
                                                {settings.eligible_designations.length
                                                        ? `Designations ${settings.eligible_designations.join(', ')}`
                                                        : 'Everyone'}
                                        </dd>
                                </div>
                        </dl>
                </section>
        )
}
