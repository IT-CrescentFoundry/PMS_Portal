"""Today's date and month arithmetic, in one place so date rules can be tested.

Uses the server clock (local time), like the database timestamps; revisit
with them before any multi-timezone deployment.
"""
from datetime import date, timedelta


def today() -> date:
    return date.today()


def month_start(day: date) -> date:
    return day.replace(day=1)


def next_month(month: date) -> date:
    return (month.replace(day=28) + timedelta(days=4)).replace(day=1)


def month_end(month: date) -> date:
    return next_month(month) - timedelta(days=1)


def months_between(start: date, end: date) -> list[date]:
    """First days of every month that overlaps [start, end] (inclusive)."""
    months = []
    current = month_start(start)
    while current <= end:
        months.append(current)
        current = next_month(current)
    return months
