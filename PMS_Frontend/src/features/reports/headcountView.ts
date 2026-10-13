/** Which population the selected filters describe, in plain words. */
export function describeView(plantSelected: boolean, departmentSelected: boolean): string {
        if (departmentSelected && plantSelected) return 'One department at one plant'
        if (departmentSelected) return 'One department across all accessible plants (each person counted once)'
        if (plantSelected) return 'All departments at one plant'
        return 'All accessible plants and departments'
}
