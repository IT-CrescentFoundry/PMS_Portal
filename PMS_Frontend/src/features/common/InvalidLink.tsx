import { Link } from 'react-router'
import { PageHeader } from '../../components/common/PageHeader'
import { EmptyState } from '../../components/common/QueryStates'
import { buttonClasses } from '../../components/common/styles'

/** Shown for malformed ids in the URL (no request is sent). */
export function InvalidLink({ backTo, backLabel }: { backTo: string; backLabel: string }) {
        return (
                <>
                        <PageHeader title="Page not found" />
                        <EmptyState
                                title="This link is not valid"
                                action={
                                        <Link to={backTo} className={buttonClasses('secondary')}>
                                                {backLabel}
                                        </Link>
                                }
                        >
                                Check the address, or go back and choose an item from the list.
                        </EmptyState>
                </>
        )
}
