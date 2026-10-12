"""Seed synthetic demo data. Run from PMS_Backend:  python -m app.seed"""
import sys

from app.seed.runner import SeedError, run


def main() -> int:
    try:
        stats = run()
    except SeedError as exc:
        print(f"Seed aborted: {exc}", file=sys.stderr)
        return 1

    tables = sorted({table for table, _ in stats})
    print(f"{'table':<22}{'created':>9}{'updated':>9}{'unchanged':>11}")
    for table in tables:
        print(
            f"{table:<22}{stats[(table, 'created')]:>9}"
            f"{stats[(table, 'updated')]:>9}{stats[(table, 'unchanged')]:>11}"
        )
    print("Seed committed.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
