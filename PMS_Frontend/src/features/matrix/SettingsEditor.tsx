import { Plus, Trash2 } from 'lucide-react'
import { Button } from '../../components/common/Button'
import { SelectField, TextField } from '../../components/common/Fields'
import { cardClasses } from '../../components/common/styles'
import type { MatrixSettingsOptions } from '../../types/api'
import { CompactInput } from './controls'
import { uid, withSettings, type MatrixDraftState, type SettingsDraft } from './matrixDraft'

const choose = (options: Record<string, string>) => [
        { value: '', label: 'Choose…' },
        ...Object.entries(options).map(([value, label]) => ({ value, label })),
]

/**
 * Normalization policy settings: who is compared with whom, the groups and
 * their target shares, rounding, ranking, ties, small cohorts and the
 * eligible population. Nothing is chosen for the author except the intended
 * 20/60/20 split of a new draft; the API validates every choice.
 */
export function SettingsEditor({
        options,
        state,
        onChange,
}: {
        options: MatrixSettingsOptions
        state: MatrixDraftState
        onChange: (next: MatrixDraftState) => void
}) {
        const settings = state.settings!
        const set = (patch: Partial<SettingsDraft>) =>
                onChange(withSettings(state, { ...settings, ...patch }))
        const groups = settings.groups
        const setGroup = (index: number, patch: Partial<SettingsDraft['groups'][number]>) =>
                set({ groups: groups.map((g, i) => (i === index ? { ...g, ...patch } : g)) })
        const hundredths = groups.map((g) =>
                /^\d{1,3}(\.\d{1,2})?$/.test(g.percent.trim())
                        ? Math.round(Number(g.percent) * 100)
                        : NaN,
        )
        const total = hundredths.every(Number.isFinite)
                ? hundredths.reduce((a, b) => a + b, 0) / 100
                : null

        return (
                <div className="space-y-4">
                        <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
                                <SelectField
                                        label="Who is compared with whom"
                                        hint="Each employee is counted once, in the cohort of their primary assignment."
                                        value={settings.cohortLevel}
                                        onChange={(e) => set({ cohortLevel: e.target.value })}
                                        options={choose(options.cohort_levels)}
                                />
                                <SelectField
                                        label="Ranked by"
                                        value={settings.rankBy}
                                        onChange={(e) => set({ rankBy: e.target.value })}
                                        options={choose(options.rank_by)}
                                />
                        </div>

                        <fieldset className={`${cardClasses} space-y-3 p-4`}>
                                <legend className="px-1 text-sm font-semibold text-slate-900">
                                        Groups, best first
                                </legend>
                                <p className="text-sm text-slate-700">
                                        Target shares must total 100 %. Exactly one group takes
                                        whatever remains after the others are rounded to whole
                                        employees.
                                </p>
                                {groups.map((g, index) => (
                                        <div
                                                key={g.uid}
                                                className="grid grid-cols-1 items-center gap-2 sm:grid-cols-[8rem_1fr_7rem_auto_auto]"
                                        >
                                                <CompactInput
                                                        aria-label={`Key of group ${index + 1}`}
                                                        value={g.key}
                                                        maxLength={20}
                                                        onChange={(e) =>
                                                                setGroup(index, {
                                                                        key: e.target.value.toUpperCase(),
                                                                })
                                                        }
                                                />
                                                <CompactInput
                                                        aria-label={`Label of group ${index + 1}`}
                                                        value={g.label}
                                                        maxLength={40}
                                                        onChange={(e) =>
                                                                setGroup(index, {
                                                                        label: e.target.value,
                                                                })
                                                        }
                                                />
                                                <CompactInput
                                                        aria-label={`Target % of group ${index + 1}`}
                                                        inputMode="decimal"
                                                        value={g.percent}
                                                        onChange={(e) =>
                                                                setGroup(index, {
                                                                        percent: e.target.value,
                                                                })
                                                        }
                                                />
                                                <label className="flex items-center gap-2 text-sm text-slate-800">
                                                        <input
                                                                type="radio"
                                                                name="remainder-group"
                                                                checked={g.remainder}
                                                                onChange={() =>
                                                                        set({
                                                                                groups: groups.map(
                                                                                        (x, i) => ({
                                                                                                ...x,
                                                                                                remainder:
                                                                                                        i ===
                                                                                                        index,
                                                                                        }),
                                                                                ),
                                                                        })
                                                                }
                                                                className="size-4 accent-brand-700"
                                                        />
                                                        Takes the remainder
                                                </label>
                                                <Button
                                                        variant="ghost"
                                                        size="sm"
                                                        aria-label={`Remove group ${index + 1}`}
                                                        disabled={groups.length <= 2}
                                                        onClick={() =>
                                                                set({
                                                                        groups: groups.filter(
                                                                                (_, i) =>
                                                                                        i !== index,
                                                                        ),
                                                                })
                                                        }
                                                >
                                                        <Trash2
                                                                aria-hidden="true"
                                                                className="size-4"
                                                        />
                                                </Button>
                                        </div>
                                ))}
                                <div className="flex flex-wrap items-center gap-3">
                                        <Button
                                                size="sm"
                                                disabled={groups.length >= options.max_groups}
                                                onClick={() =>
                                                        set({
                                                                groups: [
                                                                        ...groups,
                                                                        {
                                                                                uid: uid(),
                                                                                key: '',
                                                                                label: '',
                                                                                percent: '0',
                                                                                remainder: false,
                                                                        },
                                                                ],
                                                        })
                                                }
                                        >
                                                <Plus aria-hidden="true" className="size-4" />
                                                Add a group
                                        </Button>
                                        <span
                                                aria-live="polite"
                                                className="text-sm font-medium text-slate-800"
                                        >
                                                {total === null
                                                        ? 'Enter each share with at most two decimals.'
                                                        : `Total ${total.toFixed(2)} %`}
                                        </span>
                                </div>
                        </fieldset>

                        <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
                                <SelectField
                                        label="Group sizes are rounded"
                                        value={settings.sizeRounding}
                                        onChange={(e) => set({ sizeRounding: e.target.value })}
                                        options={choose(options.size_rounding)}
                                />
                                <SelectField
                                        label="Employees tied at a group boundary"
                                        hint="Tied employees are never split silently."
                                        value={settings.ties}
                                        onChange={(e) => set({ ties: e.target.value })}
                                        options={choose(options.ties)}
                                />
                                <TextField
                                        label="Smallest cohort that is normalized"
                                        inputMode="numeric"
                                        value={settings.minCohortSize}
                                        onChange={(e) => set({ minCohortSize: e.target.value })}
                                />
                                <SelectField
                                        label="A smaller cohort"
                                        value={settings.smallCohort}
                                        onChange={(e) => set({ smallCohort: e.target.value })}
                                        options={choose(options.small_cohort)}
                                />
                                {settings.smallCohort === 'DEFAULT_GROUP' && (
                                        <SelectField
                                                label="Group for a small cohort"
                                                value={settings.smallCohortGroup}
                                                onChange={(e) =>
                                                        set({ smallCohortGroup: e.target.value })
                                                }
                                                options={[
                                                        { value: '', label: 'Choose…' },
                                                        ...groups
                                                                .filter((g) => g.key.trim())
                                                                .map((g) => ({
                                                                        value: g.key.trim(),
                                                                        label: g.label || g.key,
                                                                })),
                                                ]}
                                        />
                                )}
                                <TextField
                                        label="Eligible designation codes (optional)"
                                        hint="Comma-separated, e.g. ENG, SENG. Leave empty for everyone."
                                        value={settings.eligibleDesignations}
                                        onChange={(e) =>
                                                set({ eligibleDesignations: e.target.value })
                                        }
                                />
                        </div>
                </div>
        )
}
