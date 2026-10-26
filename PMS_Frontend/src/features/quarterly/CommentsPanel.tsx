import { useState, type FormEvent } from 'react'
import { ActionError } from '../../components/common/ActionError'
import { Badge } from '../../components/common/Badge'
import { Button } from '../../components/common/Button'
import { SelectField, TextAreaField } from '../../components/common/Fields'
import { ErrorState, LoadingState } from '../../components/common/QueryStates'
import { cardClasses } from '../../components/common/styles'
import { useAction } from '../../hooks/useAction'
import { useApiQuery } from '../../hooks/useApiQuery'
import { addComment, listComments } from '../../services/quarterlyApi'
import type { SheetCommentKind } from '../../types/api'
import { formatDate } from '../../utils/format'

const KIND_LABELS: Record<SheetCommentKind, string> = {
        REVIEW_COMMENT: 'Review comment',
        FEEDBACK: 'Feedback for the employee',
}

/** Review comments and optional feedback on one KPI sheet. Never required. */
export function CommentsPanel({ sheetId }: { sheetId: number }) {
        const query = useApiQuery(`comments|${sheetId}`, (signal) => listComments(sheetId, signal))
        const action = useAction()
        const [kind, setKind] = useState<SheetCommentKind>('REVIEW_COMMENT')
        const [body, setBody] = useState('')
        const [touched, setTouched] = useState(false)
        const error = touched && !body.trim() ? 'Write the comment first.' : undefined

        async function handleSubmit(event: FormEvent) {
                event.preventDefault()
                setTouched(true)
                if (!body.trim()) return
                const added = await action.run(() => addComment(sheetId, kind, body.trim()))
                if (added) {
                        setBody('')
                        setTouched(false)
                        query.reload()
                }
        }

        return (
                <section
                        aria-labelledby="comments-heading"
                        className={`${cardClasses} space-y-3 p-4`}
                >
                        <h2
                                id="comments-heading"
                                className="text-base font-semibold text-slate-900"
                        >
                                Comments and feedback
                        </h2>
                        <p className="text-sm text-slate-700">
                                Optional. Review comments stay with the reviewers; feedback is also
                                shown to the employee. Neither is needed for review, normalization
                                or publication.
                        </p>
                        {query.isLoading ? (
                                <LoadingState label="Loading comments…" />
                        ) : query.error !== undefined || !query.data ? (
                                <ErrorState error={query.error} onRetry={query.reload} />
                        ) : (
                                <>
                                        {query.data.comments.length === 0 ? (
                                                <p className="text-sm text-slate-600">
                                                        No comments yet.
                                                </p>
                                        ) : (
                                                <ul className="space-y-2">
                                                        {query.data.comments.map((c) => (
                                                                <li
                                                                        key={c.id}
                                                                        className="rounded-md bg-slate-50 p-2 text-sm"
                                                                >
                                                                        <Badge
                                                                                tone={
                                                                                        c.kind ===
                                                                                        'FEEDBACK'
                                                                                                ? 'brand'
                                                                                                : 'neutral'
                                                                                }
                                                                        >
                                                                                {
                                                                                        KIND_LABELS[
                                                                                                c
                                                                                                        .kind
                                                                                        ]
                                                                                }
                                                                        </Badge>
                                                                        <p className="mt-1 whitespace-pre-line text-slate-800">
                                                                                {c.body}
                                                                        </p>
                                                                        <p className="text-xs text-slate-600">
                                                                                {c.author
                                                                                        ?.username ??
                                                                                        '—'}{' '}
                                                                                ·{' '}
                                                                                {formatDate(
                                                                                        c.created_at,
                                                                                )}
                                                                        </p>
                                                                </li>
                                                        ))}
                                                </ul>
                                        )}
                                        {query.data.can_comment && (
                                                <form
                                                        onSubmit={handleSubmit}
                                                        noValidate
                                                        className="space-y-3"
                                                >
                                                        <div className="max-w-xs">
                                                                <SelectField
                                                                        label="Kind"
                                                                        value={kind}
                                                                        onChange={(e) =>
                                                                                setKind(
                                                                                        e.target
                                                                                                .value as SheetCommentKind,
                                                                                )
                                                                        }
                                                                        options={Object.entries(
                                                                                KIND_LABELS,
                                                                        ).map(([value, label]) => ({
                                                                                value,
                                                                                label,
                                                                        }))}
                                                                />
                                                        </div>
                                                        <TextAreaField
                                                                label="Comment"
                                                                maxLength={2000}
                                                                value={body}
                                                                error={error}
                                                                onChange={(e) =>
                                                                        setBody(e.target.value)
                                                                }
                                                        />
                                                        <ActionError
                                                                error={action.error}
                                                                title="The comment was not saved"
                                                        />
                                                        <Button
                                                                type="submit"
                                                                isLoading={action.busy}
                                                        >
                                                                Add
                                                        </Button>
                                                </form>
                                        )}
                                </>
                        )}
                </section>
        )
}
