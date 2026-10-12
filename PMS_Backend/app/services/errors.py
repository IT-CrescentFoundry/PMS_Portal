class NotFoundError(LookupError):
    """A requested record does not exist. Mapped to HTTP 404 in app.main."""

    def __init__(self, entity: str, record_id: int) -> None:
        super().__init__(f"{entity} {record_id} not found")
        self.entity = entity
        self.record_id = record_id
