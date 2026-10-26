import { Route, Routes } from 'react-router'
import { AppLayout } from '../components/layout/AppLayout'
import { ProfilePage } from '../features/account/ProfilePage'
import { LoginPage } from '../features/auth/LoginPage'
import { RequireAuth, RequireOrgAccess } from '../features/auth/RequireAuth'
import { NotFoundPage } from '../features/common/NotFoundPage'
import { DashboardPage } from '../features/dashboard/DashboardPage'
import { DepartmentDetailPage } from '../features/departments/DepartmentDetailPage'
import { DepartmentsPage } from '../features/departments/DepartmentsPage'
import { DepartmentUnitPage } from '../features/departments/DepartmentUnitPage'
import { EmployeeDetailPage } from '../features/employees/EmployeeDetailPage'
import { EmployeesPage } from '../features/employees/EmployeesPage'
import { JDDetailPage } from '../features/jd/JDDetailPage'
import { JDCreatePage, JDEditPage } from '../features/jd/JDEditorPage'
import { JDListPage } from '../features/jd/JDListPage'
import { DeviationDetailPage } from '../features/kpi/DeviationDetailPage'
import { DeviationsPage } from '../features/kpi/DeviationsPage'
import { KpiCreatePage, KpiEditPage } from '../features/kpi/KpiEditorPage'
import { KpiLibraryPage } from '../features/kpi/KpiLibraryPage'
import { KpiSheetPage } from '../features/kpi/KpiSheetPage'
import { KpiSheetsPage } from '../features/kpi/KpiSheetsPage'
import { KpiUploadPage } from '../features/kpi/KpiUploadPage'
import { ScoringPoliciesPage } from '../features/kpi/ScoringPoliciesPage'
import { MatricesPage } from '../features/matrix/MatricesPage'
import { MatrixCreatePage } from '../features/matrix/MatrixCreatePage'
import { MatrixDetailPage } from '../features/matrix/MatrixDetailPage'
import { MatrixEditorPage } from '../features/matrix/MatrixEditorPage'
import { MatrixUploadPage } from '../features/matrix/MatrixUploadPage'
import { MatrixVersionPage } from '../features/matrix/MatrixVersionPage'
import { PlantDetailPage } from '../features/plants/PlantDetailPage'
import { CohortPage } from '../features/quarterly/CohortPage'
import { EmployeeResultPage } from '../features/quarterly/EmployeeResultPage'
import { EmployeeResultsPage } from '../features/quarterly/EmployeeResultsPage'
import { MyKpiSheetsPage } from '../features/quarterly/MyKpiSheetsPage'
import { NormalizationPage } from '../features/quarterly/NormalizationPage'
import { QuarterOverviewPage } from '../features/quarterly/QuarterOverviewPage'
import { PlantsPage } from '../features/plants/PlantsPage'
import { HeadcountPage } from '../features/reports/HeadcountPage'
import { MonthlyDataPage } from '../features/scores/MonthlyDataPage'
import { OverridesPage } from '../features/scores/OverridesPage'
import { ResultDetailPage } from '../features/scores/ResultDetailPage'
import { ResultsPage } from '../features/scores/ResultsPage'

export function AppRoutes() {
        return (
                <Routes>
                        <Route path="/login" element={<LoginPage />} />
                        <Route
                                element={
                                        <RequireAuth>
                                                <AppLayout />
                                        </RequireAuth>
                                }
                        >
                                <Route index element={<DashboardPage />} />
                                <Route element={<RequireOrgAccess />}>
                                        <Route path="plants" element={<PlantsPage />} />
                                        <Route
                                                path="plants/:plantId"
                                                element={<PlantDetailPage />}
                                        />
                                        <Route path="departments" element={<DepartmentsPage />} />
                                        <Route
                                                path="departments/:departmentId"
                                                element={<DepartmentDetailPage />}
                                        />
                                        <Route
                                                path="departments/:departmentId/plants/:plantId"
                                                element={<DepartmentUnitPage />}
                                        />
                                        <Route path="employees" element={<EmployeesPage />} />
                                        <Route
                                                path="reports/headcount"
                                                element={<HeadcountPage />}
                                        />
                                        <Route path="jds" element={<JDListPage />} />
                                        <Route path="jds/new" element={<JDCreatePage />} />
                                        <Route path="jds/:jdId" element={<JDDetailPage />} />
                                        <Route
                                                path="jds/:jdId/versions/:versionId/edit"
                                                element={<JDEditPage />}
                                        />
                                        <Route path="kpi/library" element={<KpiLibraryPage />} />
                                        <Route path="kpi/library/new" element={<KpiCreatePage />} />
                                        <Route
                                                path="kpi/library/:kpiId"
                                                element={<KpiEditPage />}
                                        />
                                        <Route
                                                path="kpi/policies"
                                                element={<ScoringPoliciesPage />}
                                        />
                                        <Route path="kpi/sheets" element={<KpiSheetsPage />} />
                                        <Route
                                                path="kpi/sheets/:sheetId"
                                                element={<KpiSheetPage />}
                                        />
                                        <Route path="kpi/upload" element={<KpiUploadPage />} />
                                        <Route path="kpi/deviations" element={<DeviationsPage />} />
                                        <Route
                                                path="kpi/deviations/:deviationId"
                                                element={<DeviationDetailPage />}
                                        />
                                        <Route path="matrices" element={<MatricesPage />} />
                                        <Route path="matrices/new" element={<MatrixCreatePage />} />
                                        <Route
                                                path="matrices/upload"
                                                element={<MatrixUploadPage />}
                                        />
                                        <Route
                                                path="matrices/:matrixId"
                                                element={<MatrixDetailPage />}
                                        />
                                        <Route
                                                path="matrices/:matrixId/versions/:versionId"
                                                element={<MatrixVersionPage />}
                                        />
                                        <Route
                                                path="matrices/:matrixId/versions/:versionId/edit"
                                                element={<MatrixEditorPage />}
                                        />
                                        <Route path="scores/data" element={<MonthlyDataPage />} />
                                        <Route path="scores/results" element={<ResultsPage />} />
                                        <Route
                                                path="scores/results/:sheetId"
                                                element={<ResultDetailPage />}
                                        />
                                        <Route
                                                path="scores/overrides"
                                                element={<OverridesPage />}
                                        />
                                        <Route
                                                path="scores/quarter"
                                                element={<QuarterOverviewPage />}
                                        />
                                        <Route
                                                path="scores/employees"
                                                element={<EmployeeResultsPage />}
                                        />
                                        <Route
                                                path="scores/quarters/:quarterId/employees/:employeeId"
                                                element={<EmployeeResultPage />}
                                        />
                                        <Route
                                                path="scores/normalization"
                                                element={<NormalizationPage />}
                                        />
                                        <Route
                                                path="scores/normalization/:runId"
                                                element={<CohortPage />}
                                        />
                                </Route>
                                {/* Also reachable by employees for their own record (the API decides). */}
                                <Route
                                        path="employees/:employeeId"
                                        element={<EmployeeDetailPage />}
                                />
                                <Route path="my/kpi-sheets" element={<MyKpiSheetsPage />} />
                                <Route path="profile" element={<ProfilePage />} />
                                <Route path="*" element={<NotFoundPage />} />
                        </Route>
                </Routes>
        )
}
