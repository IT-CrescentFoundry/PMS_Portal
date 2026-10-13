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
import { PlantDetailPage } from '../features/plants/PlantDetailPage'
import { PlantsPage } from '../features/plants/PlantsPage'
import { HeadcountPage } from '../features/reports/HeadcountPage'

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
                                        <Route path="plants/:plantId" element={<PlantDetailPage />} />
                                        <Route path="departments" element={<DepartmentsPage />} />
                                        <Route path="departments/:departmentId" element={<DepartmentDetailPage />} />
                                        <Route path="departments/:departmentId/plants/:plantId" element={<DepartmentUnitPage />} />
                                        <Route path="employees" element={<EmployeesPage />} />
                                        <Route path="reports/headcount" element={<HeadcountPage />} />
                                </Route>
                                {/* Also reachable by employees for their own record (the API decides). */}
                                <Route path="employees/:employeeId" element={<EmployeeDetailPage />} />
                                <Route path="profile" element={<ProfilePage />} />
                                <Route path="*" element={<NotFoundPage />} />
                        </Route>
                </Routes>
        )
}