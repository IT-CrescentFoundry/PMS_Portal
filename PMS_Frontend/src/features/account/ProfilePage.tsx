import { Link } from 'react-router'
import { PageHeader } from '../../components/common/PageHeader'
import { cardClasses, linkClasses } from '../../components/common/styles'
import { Table, TBody, Td, Th } from '../../components/tables/Table'
import { grantCoverage } from '../../utils/labels'
import { useCurrentUser } from '../auth/AuthContext'
import {
        canReadOrganization,
        canReadOwnRecord,
        PERMISSION_ORG_READ,
        PERMISSION_SELF_READ,
} from '../auth/permissions'

const PERMISSION_TEXT: Record<string, string> = {
        [PERMISSION_ORG_READ]:
                'View plants, departments, employees and headcount within your access',
        [PERMISSION_SELF_READ]: 'View your own employee record',
}

/** Read-only account profile from GET /api/auth/me (no editing in this release). */
export function ProfilePage() {
        const user = useCurrentUser()
        const canOpenRecord = canReadOwnRecord(user) || canReadOrganization(user)

        return (
                <>
                        <PageHeader
                                title="My profile"
                                description="Your account and the access it grants."
                        />
                        <div className="space-y-6">
                                <section
                                        className={`${cardClasses} p-5`}
                                        aria-labelledby="account-heading"
                                >
                                        <h2
                                                id="account-heading"
                                                className="text-lg font-semibold text-slate-900"
                                        >
                                                Account
                                        </h2>
                                        <dl className="mt-3 grid grid-cols-1 gap-4 sm:grid-cols-3">
                                                <div>
                                                        <dt className="text-xs font-medium tracking-wide text-slate-600 uppercase">
                                                                Username
                                                        </dt>
                                                        <dd className="mt-1 text-sm text-slate-900">
                                                                {user.username}
                                                        </dd>
                                                </div>
                                                <div>
                                                        <dt className="text-xs font-medium tracking-wide text-slate-600 uppercase">
                                                                Email
                                                        </dt>
                                                        <dd className="mt-1 text-sm text-slate-900">
                                                                {user.email ?? 'Not recorded'}
                                                        </dd>
                                                </div>
                                                <div>
                                                        <dt className="text-xs font-medium tracking-wide text-slate-600 uppercase">
                                                                Employee record
                                                        </dt>
                                                        <dd className="mt-1 text-sm text-slate-900">
                                                                {user.employee === null ? (
                                                                        'Not linked to an employee'
                                                                ) : canOpenRecord ? (
                                                                        <Link
                                                                                to={`/employees/${user.employee.id}`}
                                                                                className={
                                                                                        linkClasses
                                                                                }
                                                                        >
                                                                                {
                                                                                        user
                                                                                                .employee
                                                                                                .full_name
                                                                                }{' '}
                                                                                (
                                                                                {
                                                                                        user
                                                                                                .employee
                                                                                                .employee_code
                                                                                }
                                                                                )
                                                                        </Link>
                                                                ) : (
                                                                        `${user.employee.full_name} (${user.employee.employee_code})`
                                                                )}
                                                        </dd>
                                                </div>
                                        </dl>
                                </section>

                                <section aria-labelledby="roles-heading" className="space-y-3">
                                        <h2
                                                id="roles-heading"
                                                className="text-lg font-semibold text-slate-900"
                                        >
                                                Roles and access
                                        </h2>
                                        {user.roles.length === 0 ? (
                                                <p className="text-sm text-slate-600">
                                                        No roles are assigned to your account.
                                                </p>
                                        ) : (
                                                <Table caption="Your roles and what they cover">
                                                        <thead>
                                                                <tr>
                                                                        <Th>Role</Th>
                                                                        <Th>Covers</Th>
                                                                </tr>
                                                        </thead>
                                                        <TBody>
                                                                {user.roles.map((role) => (
                                                                        <tr key={role.code}>
                                                                                <Td className="font-medium">
                                                                                        {role.name}
                                                                                </Td>
                                                                                <Td>
                                                                                        <ul className="space-y-0.5">
                                                                                                {grantCoverage(
                                                                                                        role,
                                                                                                ).map(
                                                                                                        (
                                                                                                                line,
                                                                                                        ) => (
                                                                                                                <li
                                                                                                                        key={
                                                                                                                                line
                                                                                                                        }
                                                                                                                >
                                                                                                                        {
                                                                                                                                line
                                                                                                                        }
                                                                                                                </li>
                                                                                                        ),
                                                                                                )}
                                                                                        </ul>
                                                                                </Td>
                                                                        </tr>
                                                                ))}
                                                        </TBody>
                                                </Table>
                                        )}
                                        {user.permissions.length > 0 && (
                                                <div className={`${cardClasses} p-4`}>
                                                        <p className="text-sm font-medium text-slate-900">
                                                                You can:
                                                        </p>
                                                        <ul className="mt-1 list-disc space-y-0.5 pl-5 text-sm text-slate-700">
                                                                {user.permissions.map(
                                                                        (permission) => (
                                                                                <li
                                                                                        key={
                                                                                                permission
                                                                                        }
                                                                                >
                                                                                        {PERMISSION_TEXT[
                                                                                                permission
                                                                                        ] ??
                                                                                                permission}
                                                                                </li>
                                                                        ),
                                                                )}
                                                        </ul>
                                                </div>
                                        )}
                                        <p className="text-xs text-slate-600">
                                                Access is managed by your PMS administrator. Sign
                                                out when you finish on a shared computer.
                                        </p>
                                </section>
                        </div>
                </>
        )
}
