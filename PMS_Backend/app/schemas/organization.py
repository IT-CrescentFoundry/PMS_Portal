from pydantic import BaseModel, ConfigDict


class ORMModel(BaseModel):
    """Base for response schemas built from SQLAlchemy objects."""

    model_config = ConfigDict(from_attributes=True)


class PlantRef(ORMModel):
    id: int
    code: str
    name: str


class DepartmentRef(ORMModel):
    id: int
    code: str
    name: str


class PlantRead(PlantRef):
    location: str | None
    is_active: bool


class DepartmentRead(DepartmentRef):
    description: str | None
    is_active: bool


class OrgUnitRead(ORMModel):
    """A department at a plant (plant_departments row), e.g. Quality — Plant A."""

    plant_department_id: int
    plant: PlantRef
    department: DepartmentRef
    is_active: bool


class PlantDetail(PlantRead):
    units: list[OrgUnitRead]


class DepartmentDetail(DepartmentRead):
    units: list[OrgUnitRead]
