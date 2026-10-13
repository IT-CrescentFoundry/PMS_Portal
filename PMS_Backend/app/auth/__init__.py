"""Authentication and authorization.

passwords    Argon2id hashing/verification
tokens       signed, expiring JWT access tokens
permissions  role -> capability map; builds the caller's effective scope
service      login / password management (database operations)
dependencies FastAPI dependencies used by routers
"""
