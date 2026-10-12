"""Synthetic demo data. All names, codes and e-mails are fictional.

Records reference each other by business code, never by database id, so the
seed is independent of auto-increment values.

Scenarios covered:
  * DEMO0001 is Head of Quality at Plant A (primary) and also supports
    Quality at Plant B (secondary): one person, two assignments.
  * DEMO0009 transferred from Maintenance A to Maintenance B (closed history).
  * DEMO0012 was promoted within Quality C (same unit, new designation).
  * DEMO0014 has exited (inactive, all assignments closed).
"""
from datetime import date

from app.models.enums import CycleStatus, QuarterStatus, ScopeType

PLANTS = [
    {"code": "PLT-A", "name": "Demo Plant A", "location": "Northfield (fictional)"},
    {"code": "PLT-B", "name": "Demo Plant B", "location": "Eastbrook (fictional)"},
    {"code": "PLT-C", "name": "Demo Plant C", "location": "Southvale (fictional)"},
]

DEPARTMENTS = [
    {"code": "QA", "name": "Quality", "description": "Quality assurance and control"},
    {"code": "PROD", "name": "Production", "description": "Manufacturing operations"},
    {"code": "MAINT", "name": "Maintenance", "description": "Plant and equipment maintenance"},
    {"code": "HR", "name": "Human Resources", "description": "People operations"},
    {"code": "FIN", "name": "Finance", "description": "Finance and accounts"},
]

# (plant code, department code)
PLANT_DEPARTMENTS = [
    ("PLT-A", "QA"), ("PLT-A", "PROD"), ("PLT-A", "MAINT"), ("PLT-A", "HR"), ("PLT-A", "FIN"),
    ("PLT-B", "QA"), ("PLT-B", "PROD"), ("PLT-B", "MAINT"),
    ("PLT-C", "QA"), ("PLT-C", "PROD"),
]

DESIGNATIONS = [
    {"code": "OPR", "name": "Operator"},
    {"code": "EXE", "name": "Executive"},
    {"code": "ENG", "name": "Engineer"},
    {"code": "SENG", "name": "Senior Engineer"},
    {"code": "MGR", "name": "Manager"},
    {"code": "HOD", "name": "Head of Department"},
    {"code": "CHRO", "name": "Chief Human Resources Officer"},
]

EMPLOYEES = [
    {"employee_code": "DEMO0001", "full_name": "Asha Demo-Rao", "date_of_joining": date(2018, 6, 1)},
    {"employee_code": "DEMO0002", "full_name": "Ravi Demo-Kumar", "date_of_joining": date(2020, 1, 15)},
    {"employee_code": "DEMO0003", "full_name": "Meera Demo-Shah", "date_of_joining": date(2021, 7, 1)},
    {"employee_code": "DEMO0004", "full_name": "Vikram Demo-Patil", "date_of_joining": date(2016, 3, 10)},
    {"employee_code": "DEMO0005", "full_name": "Sunil Demo-Yadav", "date_of_joining": date(2022, 2, 1)},
    {"employee_code": "DEMO0006", "full_name": "Pooja Demo-Nair", "date_of_joining": date(2023, 5, 2)},
    {"employee_code": "DEMO0007", "full_name": "Arjun Demo-Mehta", "date_of_joining": date(2017, 9, 18)},
    {"employee_code": "DEMO0008", "full_name": "Kiran Demo-Joshi", "date_of_joining": date(2022, 11, 7)},
    {"employee_code": "DEMO0009", "full_name": "Farhan Demo-Ali", "date_of_joining": date(2019, 4, 1)},
    {"employee_code": "DEMO0010", "full_name": "Neha Demo-Gupta", "date_of_joining": date(2021, 1, 4)},
    {"employee_code": "DEMO0011", "full_name": "Rohit Demo-Desai", "date_of_joining": date(2020, 8, 17)},
    {"employee_code": "DEMO0012", "full_name": "Lakshmi Demo-Iyer", "date_of_joining": date(2023, 4, 1)},
    {"employee_code": "DEMO0013", "full_name": "Manoj Demo-Pillai", "date_of_joining": date(2024, 6, 3)},
    {"employee_code": "DEMO0014", "full_name": "Sanjay Demo-Verma", "date_of_joining": date(2022, 1, 10),
     "date_of_exit": date(2026, 5, 31), "is_active": False},
    {"employee_code": "DEMO0015", "full_name": "Kavita Demo-Menon", "date_of_joining": date(2015, 2, 2)},
]
for _e in EMPLOYEES:  # fictional, reserved example.com domain
    _e.setdefault("email", f"{_e['employee_code'].lower()}@example.com")
    _e.setdefault("date_of_exit", None)
    _e.setdefault("is_active", True)

# Natural key: (employee, plant, department, effective_from) — matches the
# uq_employee_assignments_unit_start constraint.
ASSIGNMENTS = [
    # Multi-plant: one person, primary at A, supporting B.
    {"employee": "DEMO0001", "plant": "PLT-A", "department": "QA", "designation": "HOD",
     "manager": None, "is_primary": True, "effective_from": date(2022, 4, 1), "effective_to": None},
    {"employee": "DEMO0001", "plant": "PLT-B", "department": "QA", "designation": "HOD",
     "manager": None, "is_primary": False, "effective_from": date(2026, 4, 1), "effective_to": None},
    {"employee": "DEMO0002", "plant": "PLT-A", "department": "QA", "designation": "ENG",
     "manager": "DEMO0001", "is_primary": True, "effective_from": date(2020, 1, 15), "effective_to": None},
    {"employee": "DEMO0003", "plant": "PLT-B", "department": "QA", "designation": "ENG",
     "manager": "DEMO0001", "is_primary": True, "effective_from": date(2021, 7, 1), "effective_to": None},
    {"employee": "DEMO0004", "plant": "PLT-A", "department": "PROD", "designation": "MGR",
     "manager": None, "is_primary": True, "effective_from": date(2016, 3, 10), "effective_to": None},
    {"employee": "DEMO0005", "plant": "PLT-A", "department": "PROD", "designation": "OPR",
     "manager": "DEMO0004", "is_primary": True, "effective_from": date(2022, 2, 1), "effective_to": None},
    {"employee": "DEMO0006", "plant": "PLT-A", "department": "PROD", "designation": "OPR",
     "manager": "DEMO0004", "is_primary": True, "effective_from": date(2023, 5, 2), "effective_to": None},
    {"employee": "DEMO0007", "plant": "PLT-B", "department": "PROD", "designation": "MGR",
     "manager": None, "is_primary": True, "effective_from": date(2017, 9, 18), "effective_to": None},
    {"employee": "DEMO0008", "plant": "PLT-B", "department": "PROD", "designation": "OPR",
     "manager": "DEMO0007", "is_primary": True, "effective_from": date(2022, 11, 7), "effective_to": None},
    # Transfer: Maintenance A (closed) -> Maintenance B (current).
    {"employee": "DEMO0009", "plant": "PLT-A", "department": "MAINT", "designation": "ENG",
     "manager": "DEMO0004", "is_primary": True, "effective_from": date(2019, 4, 1),
     "effective_to": date(2026, 6, 30)},
    {"employee": "DEMO0009", "plant": "PLT-B", "department": "MAINT", "designation": "ENG",
     "manager": "DEMO0007", "is_primary": True, "effective_from": date(2026, 7, 1), "effective_to": None},
    {"employee": "DEMO0010", "plant": "PLT-A", "department": "HR", "designation": "EXE",
     "manager": "DEMO0015", "is_primary": True, "effective_from": date(2021, 1, 4), "effective_to": None},
    {"employee": "DEMO0011", "plant": "PLT-A", "department": "FIN", "designation": "EXE",
     "manager": None, "is_primary": True, "effective_from": date(2020, 8, 17), "effective_to": None},
    # Promotion within the same unit: Engineer (closed) -> Senior Engineer.
    {"employee": "DEMO0012", "plant": "PLT-C", "department": "QA", "designation": "ENG",
     "manager": "DEMO0001", "is_primary": True, "effective_from": date(2023, 4, 1),
     "effective_to": date(2026, 3, 31)},
    {"employee": "DEMO0012", "plant": "PLT-C", "department": "QA", "designation": "SENG",
     "manager": "DEMO0001", "is_primary": True, "effective_from": date(2026, 4, 1), "effective_to": None},
    {"employee": "DEMO0013", "plant": "PLT-C", "department": "PROD", "designation": "OPR",
     "manager": None, "is_primary": True, "effective_from": date(2024, 6, 3), "effective_to": None},
    # Exited employee: history only.
    {"employee": "DEMO0014", "plant": "PLT-B", "department": "PROD", "designation": "OPR",
     "manager": "DEMO0007", "is_primary": True, "effective_from": date(2022, 1, 10),
     "effective_to": date(2026, 5, 31)},
    {"employee": "DEMO0015", "plant": "PLT-A", "department": "HR", "designation": "CHRO",
     "manager": None, "is_primary": True, "effective_from": date(2015, 2, 2), "effective_to": None},
]

ROLES = [
    {"code": "ADMIN", "name": "Administrator", "description": "System configuration and deviation review"},
    {"code": "HR", "name": "HR", "description": "HR operations within assigned scope"},
    {"code": "CHRO", "name": "CHRO", "description": "Final review and approval authority"},
    {"code": "DEPT_HEAD", "name": "Department Head", "description": "Department responsibility within assigned scope"},
    {"code": "EMPLOYEE", "name": "Employee", "description": "Self-service access to own records"},
    {"code": "BUDGET_USER", "name": "Budget User", "description": "Authorized budget planning and allocation"},
]

# password_hash stays NULL: authentication is not implemented yet.
USERS = [
    {"username": "demo.admin", "email": "demo.admin@example.com", "employee": None},
    {"username": "demo.chro", "email": "demo.chro@example.com", "employee": "DEMO0015"},
    {"username": "demo.hr.plant-a", "email": "demo.hr.a@example.com", "employee": "DEMO0010"},
    {"username": "demo.quality.head", "email": "demo.qa.head@example.com", "employee": "DEMO0001"},
    {"username": "demo.production.head.a", "email": "demo.prod.a@example.com", "employee": "DEMO0004"},
    {"username": "demo.budget", "email": "demo.budget@example.com", "employee": "DEMO0011"},
    {"username": "demo.employee", "email": "demo.employee@example.com", "employee": "DEMO0005"},
]

# (username, role code, [(scope type, plant code | None, department code | None)])
USER_ROLES = [
    ("demo.admin", "ADMIN", [(ScopeType.GLOBAL, None, None)]),
    ("demo.chro", "CHRO", [(ScopeType.GLOBAL, None, None)]),
    ("demo.hr.plant-a", "HR", [(ScopeType.PLANT, "PLT-A", None)]),
    # Quality head across ALL plants (includes plants added later).
    ("demo.quality.head", "DEPT_HEAD", [(ScopeType.DEPARTMENT, None, "QA")]),
    ("demo.quality.head", "EMPLOYEE", []),
    # Production head for one plant-department only.
    ("demo.production.head.a", "DEPT_HEAD", [(ScopeType.PLANT_DEPARTMENT, "PLT-A", "PROD")]),
    ("demo.production.head.a", "EMPLOYEE", []),
    ("demo.budget", "BUDGET_USER", [(ScopeType.GLOBAL, None, None)]),
    ("demo.employee", "EMPLOYEE", []),
]

# Dates are configuration. April-March is only this demo's example.
CYCLES = [
    {"code": "FY2026-27", "name": "PMS Cycle FY 2026-27", "start_date": date(2026, 4, 1),
     "end_date": date(2027, 3, 31), "status": CycleStatus.ACTIVE,
     "quarters": [
         (1, "Q1 (Apr-Jun 2026)", date(2026, 4, 1), date(2026, 6, 30), QuarterStatus.CLOSED),
         (2, "Q2 (Jul-Sep 2026)", date(2026, 7, 1), date(2026, 9, 30), QuarterStatus.CLOSED),
         (3, "Q3 (Oct-Dec 2026)", date(2026, 10, 1), date(2026, 12, 31), QuarterStatus.OPEN),
         (4, "Q4 (Jan-Mar 2027)", date(2027, 1, 1), date(2027, 3, 31), QuarterStatus.DRAFT),
     ]},
]
