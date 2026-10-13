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
from dataclasses import dataclass
from enum import StrEnum

from app.models import User
from app.models.enums import ScopeType
from app.services.scope import AccessScope


class Permission(StrEnum):
    # Read plants, departments, employees and headcount within scope.
    ORG_READ = "org:read"
    # Read one's own employee record (self-service).
    SELF_READ = "self:read"


ROLE_PERMISSIONS: dict[str, frozenset[Permission]] = {
    "ADMIN": frozenset({Permission.ORG_READ}),
    "CHRO": frozenset({Permission.ORG_READ}),
    "HR": frozenset({Permission.ORG_READ}),
    "DEPT_HEAD": frozenset({Permission.ORG_READ}),
    "BUDGET_USER": frozenset({Permission.ORG_READ}),
    "EMPLOYEE": frozenset({Permission.SELF_READ}),
}


@dataclass(frozen=True)
class Principal:
    """The authenticated caller's effective rights for this request."""

    user_id: int
    employee_id: int | None
    permissions: frozenset[Permission]
    org_scope: AccessScope

    @property
    def can_read_self(self) -> bool:
        return self.employee_id is not None and Permission.SELF_READ in self.permissions


def build_principal(user: User) -> Principal:
    permissions: set[Permission] = set()
    is_global = False
    plant_ids: set[int] = set()
    department_ids: set[int] = set()
    unit_keys: set[tuple[int, int]] = set()

    for grant in user.user_roles:
        role_permissions = ROLE_PERMISSIONS.get(grant.role.code, frozenset())
        permissions |= role_permissions
        if Permission.ORG_READ not in role_permissions:
            continue
        for scope in grant.scopes:
            match scope.scope_type:
                case ScopeType.GLOBAL:
                    is_global = True
                case ScopeType.PLANT:
                    plant_ids.add(scope.plant_id)
                case ScopeType.DEPARTMENT:
                    department_ids.add(scope.department_id)
                case ScopeType.PLANT_DEPARTMENT:
                    unit_keys.add((scope.plant_id, scope.department_id))

    return Principal(
        user_id=user.id,
        employee_id=user.employee_id,
        permissions=frozenset(permissions),
        org_scope=AccessScope(
            is_global=is_global,
            plant_ids=frozenset(plant_ids),
            department_ids=frozenset(department_ids),
            unit_keys=frozenset(unit_keys),
        ),
    )
