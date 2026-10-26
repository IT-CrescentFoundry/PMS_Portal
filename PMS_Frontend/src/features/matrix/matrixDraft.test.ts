import { describe, expect, it } from 'vitest'
import { definition, kpiScoringType } from '../../test/matrixFixtures'
import type { MatrixDefinition } from '../../types/api'
import {
        customField,
        definitionFromDraft,
        draftFromDefinition,
        emptyCondition,
        inputsOf,
        previewInputs,
        removeField,
        suggestedKey,
        type MatrixDraftState,
} from './matrixDraft'
import { problemLocation } from './matrixLabels'

describe('matrix editor state', () => {
        it('round-trips a definition without changing its meaning', () => {
                const { state, dropped } = draftFromDefinition(definition, kpiScoringType)
                expect(dropped).toEqual([])
                const back = definitionFromDraft(state)
                expect(back.fields).toEqual(definition.fields)
                expect(back.rules[0].conditions).toEqual(definition.rules[0].conditions)
                expect(back.rules[1].conditions).toEqual({
                        achievement_percent: {
                                min: '90',
                                min_inclusive: false,
                                max: '100',
                                max_inclusive: true,
                        },
                })
                // Outputs and test values travel as exact text.
                expect(back.rules.map((r) => r.outputs)).toEqual([{ score: '5' }, { score: '4' }])
                expect(back.no_match).toEqual({ mode: 'default', outputs: { score: '1' } })
                expect(back.test_cases).toEqual([
                        {
                                label: 'Exactly 100%',
                                inputs: { achievement_percent: '100' },
                                expected: { score: '4' },
                        },
                ])
                expect(state.fields.find((f) => f.key === 'score')?.standard).toBe(true)
        })

        it('never chooses whether a bound is included', () => {
                const { state } = draftFromDefinition(definition, kpiScoringType)
                const input = inputsOf(state)[0]
                const rule = {
                        ...state.rules[0],
                        conditions: { [input.uid]: { ...emptyCondition('PERCENT'), min: '80' } },
                }
                const sent = definitionFromDraft({ ...state, rules: [rule] })
                // Left unchosen, so the API reports it instead of the UI guessing.
                expect(sent.rules[0].conditions.achievement_percent).toEqual({
                        min: '80',
                        min_inclusive: null,
                        max: null,
                        max_inclusive: null,
                })
        })

        it('carries a newly added field into rules, test cases and previews', () => {
                const { state } = draftFromDefinition(definition, kpiScoringType)
                const added = {
                        ...customField(kpiScoringType, 'input'),
                        key: 'defect_band',
                        label: 'Defect band',
                        dataType: 'CATEGORY' as const,
                        allowedValues: 'A\nB\nC',
                        aggregation: 'LAST' as const,
                }
                const next: MatrixDraftState = {
                        ...state,
                        fields: [...state.fields, added],
                        rules: state.rules.map((r, i) =>
                                i === 0
                                        ? {
                                                  ...r,
                                                  conditions: {
                                                          ...r.conditions,
                                                          [added.uid]: {
                                                                  kind: 'set',
                                                                  values: ['A'],
                                                          },
                                                  },
                                          }
                                        : r,
                        ),
                        testCases: state.testCases.map((t) => ({
                                ...t,
                                inputs: { ...t.inputs, [added.uid]: 'B' },
                        })),
                }
                const sent = definitionFromDraft(next)
                expect(sent.fields.at(-1)).toMatchObject({
                        key: 'defect_band',
                        role: 'input',
                        data_type: 'CATEGORY',
                        allowed_values: ['A', 'B', 'C'],
                        source: 'IMPORTED',
                        aggregation: 'LAST',
                        min: null,
                        round_to: null,
                })
                expect(sent.rules[0].conditions.defect_band).toEqual({ values: ['A'] })
                expect(sent.test_cases[0].inputs).toEqual({
                        achievement_percent: '100',
                        defect_band: 'B',
                })
                expect(
                        previewInputs(next, { [added.uid]: 'C', [inputsOf(next)[0].uid]: ' ' }),
                ).toEqual({ defect_band: 'C' })
        })

        it('keeps conditions attached when a key is renamed, and removes them with the field', () => {
                const { state } = draftFromDefinition(definition, kpiScoringType)
                const added = {
                        ...customField(kpiScoringType, 'input'),
                        key: 'late_days',
                        label: 'Late days',
                        dataType: 'INTEGER' as const,
                }
                const withField: MatrixDraftState = {
                        ...state,
                        fields: [...state.fields, added],
                        rules: state.rules.map((r) => ({
                                ...r,
                                conditions: {
                                        ...r.conditions,
                                        [added.uid]: {
                                                kind: 'range',
                                                min: '0',
                                                minMode: 'gte',
                                                max: '',
                                                maxMode: '',
                                        },
                                },
                        })),
                }
                const renamed = {
                        ...withField,
                        fields: withField.fields.map((f) =>
                                f.uid === added.uid ? { ...f, key: 'days_late' } : f,
                        ),
                }
                expect(definitionFromDraft(renamed).rules[0].conditions.days_late).toEqual({
                        min: '0',
                        min_inclusive: true,
                        max: null,
                        max_inclusive: null,
                })
                const removed = definitionFromDraft(removeField(renamed, added.uid))
                expect(removed.fields.map((f) => f.key)).toEqual(['achievement_percent', 'score'])
                expect(Object.keys(removed.rules[0].conditions)).toEqual(['achievement_percent'])
        })

        it('reports saved content that refers to unknown fields instead of hiding it', () => {
                const broken: MatrixDefinition = {
                        ...definition,
                        rules: [
                                {
                                        ...definition.rules[0],
                                        conditions: {
                                                ...definition.rules[0].conditions,
                                                ghost: { values: ['x'] },
                                        },
                                },
                        ],
                }
                const { dropped } = draftFromDefinition(broken, kpiScoringType)
                expect(dropped).toEqual(["Rule row 1 has a condition on an unknown field 'ghost'."])
        })

        it('suggests keys and names problem locations', () => {
                expect(suggestedKey('Defect rate %')).toBe('defect_rate')
                expect(suggestedKey('3 day lag')).toBe('f_3_day_lag')
                expect(problemLocation('rules[1].conditions.x.min')).toBe('Rule row 2')
                expect(problemLocation('fields[0].key')).toBe('Field 1')
                expect(problemLocation('no_match.outputs')).toBe('When no rule matches')
        })
})
