"""Role capabilities and effective-scope calculation.

There is one permission system: roles (what a user may do) plus the scope
rows on each role grant (where they may do it). This module only adds the
code-level map of which capabilities each role code carries.

Combination rules for multi-role users (deliberate, deny by default):
  * A capability's effective scope is the UNION of the scopes on the user's
    grants of roles that carry that capability.
  * Scope rows on a grant whose role lacks the capability are ignored, so an
    EMPLOYEE grant can never widen organizational access, even if a scope row
    was attached to it by mistake.
  * Unknown role codes carry no capabilities.
"""
from dataclasses import dataclass, field
from enum import StrEnum

from app.models import User
from app.models.enums import ScopeType
from app.services.scope import AccessScope


class Permission(StrEnum):
    # Read plants, departments, employees, headcount, JDs and KPIs within scope.
    ORG_READ = "org:read"
    # Read one's own employee record and KPI sheets (self-service).
    SELF_READ = "self:read"
    # Create/edit JD drafts and propose them (Hiring Manager / HOD / HR).
    JD_WRITE = "jd:write"
    # Second JD sign-off step.
    JD_AUTHORISE = "jd:authorise"
    # Final JD sign-off step.
    JD_APPROVE = "jd:approve"
    # KPI library, scoring policies, KPI sheets, uploads, publish/reopen,
    # and requesting deviations.
    KPI_WRITE = "kpi:write"
    # Start quarterly scoring (locks the quarter); requires GLOBAL scope.
    QUARTER_START = "quarter:start"
    # Approve deviations (and score overrides) on the HR side / the plant side.
    DEVIATION_APPROVE_HR = "deviation:approve_hr"
    DEVIATION_APPROVE_PLANT = "deviation:approve_plant"
    # Configurable matrices (Stage K). Reading KPI-scoring and KRA matrices;
    # compensation matrices (CR impact, increment) need their own permission.
    MATRIX_READ = "matrix:read"
    MATRIX_READ_COMPENSATION = "matrix:read_compensation"
    # Author, validate, submit, withdraw, publish and upload configurations.
    MATRIX_WRITE = "matrix:write"
    # Approve or reject submitted configurations (and publish them).
    MATRIX_APPROVE = "matrix:approve"
    # Publish reviewed quarterly scores (final and immutable).
    SCORE_PUBLISH = "score:publish"
    # Stage M. Read annual results, their deviations and history within scope.
    ANNUAL_READ = "annual:read"
    # Request an adjustment of a calculated annual score (Admin).
    ANNUAL_DEVIATION_REQUEST = "annual:deviation_request"
    # Decide annual deviations, approve (publish) annual results and set the
    # cycle's annual rule (CHRO).
    ANNUAL_APPROVE = "annual:approve"
    # Request a correction of a published quarter (HR Head) / decide it (CHRO).
    QUARTER_CORRECTION_REQUEST = "quarter:correction_request"
    QUARTER_CORRECTION_APPROVE = "quarter:correction_approve"
    # Stage N. Employee-level compensation data (salary baselines, proposal
    # lines and their explanations), within scope.
    COMPENSATION_READ = "compensation:read"
    # Set up compensation cycles, import salary baselines, calculate and
    # submit budget scenarios (HR Head).
    COMPENSATION_MANAGE = "compensation:manage"
    # Budget totals, breakdowns, variance, scenarios and decisions (no
    # employee-level amounts).
    BUDGET_READ = "budget:read"
    # Record the company-approved budget amount (budget owner).
    BUDGET_RECORD = "budget:record"
    # Approve or reject the final budget scenario (CHRO).
    BUDGET_APPROVE = "budget:approve"


P = Permission
ROLE_PERMISSIONS: dict[str, frozenset[Permission]] = {
    "ADMIN": frozenset({
        P.ORG_READ, P.JD_WRITE, P.KPI_WRITE, P.QUARTER_START, P.MATRIX_READ,
        P.MATRIX_READ_COMPENSATION, P.ANNUAL_READ, P.ANNUAL_DEVIATION_REQUEST,
        P.COMPENSATION_READ, P.BUDGET_READ,
    }),
    "CHRO": frozenset({
        P.ORG_READ, P.JD_APPROVE, P.QUARTER_START, P.DEVIATION_APPROVE_HR, P.MATRIX_READ,
        P.MATRIX_READ_COMPENSATION, P.MATRIX_APPROVE, P.SCORE_PUBLISH, P.ANNUAL_READ,
        P.ANNUAL_APPROVE, P.QUARTER_CORRECTION_APPROVE, P.COMPENSATION_READ, P.BUDGET_READ,
        P.BUDGET_APPROVE,
    }),
    "HR_HEAD": frozenset({
        P.ORG_READ, P.JD_WRITE, P.KPI_WRITE, P.QUARTER_START, P.DEVIATION_APPROVE_HR,
        P.MATRIX_READ, P.MATRIX_READ_COMPENSATION, P.MATRIX_WRITE, P.SCORE_PUBLISH,
        P.ANNUAL_READ, P.QUARTER_CORRECTION_REQUEST, P.COMPENSATION_READ,
        P.COMPENSATION_MANAGE, P.BUDGET_READ,
    }),
    "HR": frozenset({P.ORG_READ, P.JD_WRITE, P.KPI_WRITE, P.MATRIX_READ, P.ANNUAL_READ}),
    "PLANT_HEAD": frozenset(
        {P.ORG_READ, P.JD_AUTHORISE, P.DEVIATION_APPROVE_PLANT, P.MATRIX_READ}
    ),
    "DEPT_HEAD": frozenset({P.ORG_READ, P.JD_WRITE, P.KPI_WRITE, P.MATRIX_READ}),
    "BUDGET_USER": frozenset({P.ORG_READ, P.MATRIX_READ, P.BUDGET_READ, P.BUDGET_RECORD}),
    "EMPLOYEE": frozenset({P.SELF_READ}),
}

# Roles allowed to fill in fields the JD form reserves for HR ("filled by HR").
HR_ROLE_CODES = frozenset({"HR", "HR_HEAD", "CHRO", "ADMIN"})

_EMPTY = AccessScope()


@dataclass(frozen=True)
class Principal:
    """The authenticated caller's effective rights for this request."""

    user_id: int
    employee_id: int | None
    permissions: frozenset[Permission]
    scopes: dict[Permission, AccessScope] = field(default_factory=dict)
    role_codes: frozenset[str] = frozenset()

    def scope_for(self, permission: Permission) -> AccessScope:
        """Where the caller may exercise `permission` (empty = nowhere)."""
        return self.scopes.get(permission, _EMPTY)

    @property
    def org_scope(self) -> AccessScope:
        return self.scope_for(Permission.ORG_READ)

    @property
    def can_read_self(self) -> bool:
        return self.employee_id is not None and Permission.SELF_READ in self.permissions

    @property
    def is_hr(self) -> bool:
        return bool(self.role_codes & HR_ROLE_CODES)


@dataclass
class _ScopeBuilder:
    is_global: bool = False
    plant_ids: set[int] = field(default_factory=set)
    department_ids: set[int] = field(default_factory=set)
    unit_keys: set[tuple[int, int]] = field(default_factory=set)

    def build(self) -> AccessScope:
        return AccessScope(
            is_global=self.is_global,
            plant_ids=frozenset(self.plant_ids),
            department_ids=frozenset(self.department_ids),
            unit_keys=frozenset(self.unit_keys),
        )


def build_principal(user: User) -> Principal:
    permissions: set[Permission] = set()
    builders: dict[Permission, _ScopeBuilder] = {}
    role_codes: set[str] = set()

    for grant in user.user_roles:
        role_codes.add(grant.role.code)
        role_permissions = ROLE_PERMISSIONS.get(grant.role.code, frozenset())
        permissions |= role_permissions
        for permission in role_permissions:
            if permission == Permission.SELF_READ:
                continue  # self-service is not organizational scope
            builder = builders.setdefault(permission, _ScopeBuilder())
            for scope in grant.scopes:
                match scope.scope_type:
                    case ScopeType.GLOBAL:
                        builder.is_global = True
                    case ScopeType.PLANT:
                        builder.plant_ids.add(scope.plant_id)
                    case ScopeType.DEPARTMENT:
                        builder.department_ids.add(scope.department_id)
                    case ScopeType.PLANT_DEPARTMENT:
                        builder.unit_keys.add((scope.plant_id, scope.department_id))

    return Principal(
        user_id=user.id,
        employee_id=user.employee_id,
        permissions=frozenset(permissions),
        scopes={permission: builder.build() for permission, builder in builders.items()},
        role_codes=frozenset(role_codes),
    )
