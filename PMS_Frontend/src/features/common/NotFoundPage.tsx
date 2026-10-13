import { Link } from 'react-router'
import { PageHeader } from '../../components/common/PageHeader'
import { EmptyState } from '../../components/common/QueryStates'
import { buttonClasses } from '../../components/common/styles'

export function NotFoundPage() {
        return (
                <>
                        <PageHeader title="Page not found" />
                        <EmptyState
                                title="This page does not exist"
                                action={
                                        <Link to="/" className={buttonClasses('primary')}>
                                                Go to the dashboard
                                        </Link>
                                }
                        >
                                Check the address, or use the navigation to find what you need.
                        </EmptyState>
                </>
        )
}
