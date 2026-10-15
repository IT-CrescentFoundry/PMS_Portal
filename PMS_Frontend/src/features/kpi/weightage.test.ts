import { describe, expect, it } from 'vitest'
import {
        formatCents,
        summarizeWeights,
        toCents,
        totalMessage,
        weightageError,
        weightageText,
} from './weightage'

describe('weightage arithmetic', () => {
        it.each([
                ['25', 2500],
                ['12.5', 1250],
                ['33.33', 3333],
                ['100', 10_000],
                [' 7.05 ', 705],
                ['0', null],
                ['100.01', null],
                ['33.333', null],
                ['-5', null],
                ['abc', null],
                ['', null],
        ])('%j -> %j hundredths', (input, expected) => {
                expect(toCents(input)).toBe(expected)
        })

        it('totals exactly, with no floating-point drift', () => {
                expect(summarizeWeights(['33.34', '33.33', '33.33'])).toEqual({
                        totalCents: 10_000,
                        complete: true,
                        invalidCount: 0,
                })
                // 0.1 + 0.2 style inputs stay exact.
                expect(summarizeWeights(['10.1', '20.2', '69.7']).complete).toBe(true)
        })

        it('refuses 99.99% and 100.01% totals', () => {
                const under = summarizeWeights(['33.33', '33.33', '33.33'])
                expect(under.complete).toBe(false)
                expect(formatCents(under.totalCents)).toBe('99.99')
                expect(totalMessage(under)).toBe('0.01% still to allocate.')
                const over = summarizeWeights(['50', '50.01'])
                expect(totalMessage(over)).toBe('0.01% over 100%.')
        })

        it('treats any invalid entry as incomplete', () => {
                const summary = summarizeWeights(['50', '50.001'])
                expect(summary.complete).toBe(false)
                expect(summary.invalidCount).toBe(1)
                expect(totalMessage(summary)).toBe('Fix the highlighted weightages.')
        })

        it.each([
                ['', 'Enter a weightage.'],
                ['abc', 'Enter a number, e.g. 25 or 12.5.'],
                ['12.345', 'Use at most two decimal places.'],
                ['0', 'Enter more than 0 and at most 100.'],
                ['101', 'Enter more than 0 and at most 100.'],
                ['12.34', null],
        ])('explains %j', (input, message) => {
                expect(weightageError(input)).toBe(message)
        })

        it('turns API numbers into clean editable text', () => {
                expect(weightageText(33.33)).toBe('33.33')
                expect(weightageText(40)).toBe('40')
                expect(weightageText(0.1 + 0.2)).toBe('0.3')
        })
})
