/**
 * CSV text for downloadable reports. Cells that a spreadsheet would read as
 * a formula (=, +, -, @, tab, carriage return) are prefixed with an
 * apostrophe, so opening a report can never run anything.
 */
function cell(value: string | number | null | undefined): string {
        let text = value === null || value === undefined ? '' : String(value)
        if (/^[=+\-@\t\r]/.test(text)) text = `'${text}`
        return /[",\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text
}

export function toCsv(rows: (string | number | null | undefined)[][]): string {
        return rows.map((row) => row.map(cell).join(',')).join('\r\n') + '\r\n'
}

/** A CSV Blob with a byte-order mark, so Excel opens it as UTF-8. */
export function csvBlob(rows: (string | number | null | undefined)[][]): Blob {
        return new Blob(['﻿', toCsv(rows)], { type: 'text/csv;charset=utf-8' })
}
