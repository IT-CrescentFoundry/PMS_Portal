import { ApiError } from '../../services/apiClient'
import { Alert } from './Alert'
import { describeError } from './errorDescription'

/**
 * Why a save or sign-off failed: the API's reason (e.g. "Only a draft sheet
 * can be edited; reopen it first.") and, for validation, every problem it
 * listed (with the spreadsheet row for uploads).
 */
export function ActionError({ error, title }: { error: unknown; title?: string }) {
        if (error === undefined || error === null) return null
        const issues = error instanceof ApiError ? error.issues : []
        const fields = error instanceof ApiError ? error.fieldErrors : []
        const message =
                error instanceof ApiError && error.kind === 'http' && error.status !== null
                        ? error.message
                        : describeError(error).message
        return (
                <Alert tone="danger" assertive title={title ?? 'The change was not saved'}>
                        <p>{message}</p>
                        {(issues.length > 0 || fields.length > 0) && (
                                <ul className="mt-1 list-disc space-y-0.5 pl-5">
                                        {issues.map((issue, index) => (
                                                <li key={`i-${index}`}>
                                                        {issue.row !== null && (
                                                                <span className="font-medium">
                                                                        Row {issue.row}:{' '}
                                                                </span>
                                                        )}
                                                        {issue.message}
                                                </li>
                                        ))}
                                        {fields.map((field, index) => (
                                                <li key={`f-${index}`}>
                                                        {field.field
                                                                ? `${field.field}: ${field.message}`
                                                                : field.message}
                                                </li>
                                        ))}
                                </ul>
                        )}
                </Alert>
        )
}
