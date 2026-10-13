"""Account administration CLI. Run from PMS_Backend:

    python -m app.auth set-password <username>

The password is typed at a hidden prompt; it is never passed on the command
line (which would leave it in shell history) and is stored only as a hash.
"""
import argparse
import sys
from getpass import getpass

from app.auth.passwords import PasswordPolicyError
from app.auth.service import UnknownUserError, set_password
from app.db import SessionLocal


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="python -m app.auth")
    commands = parser.add_subparsers(dest="command", required=True)
    set_pw = commands.add_parser("set-password", help="Set a user's password.")
    set_pw.add_argument("username")
    args = parser.parse_args(argv)

    password = getpass("New password: ")
    if password != getpass("Repeat password: "):
        print("Passwords do not match.", file=sys.stderr)
        return 1
    try:
        with SessionLocal() as session, session.begin():
            set_password(session, args.username, password)
    except PasswordPolicyError as exc:
        print(str(exc), file=sys.stderr)
        return 1
    except UnknownUserError:
        print(f"No user named '{args.username}'.", file=sys.stderr)
        return 1
    print(f"Password updated for '{args.username}'.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
