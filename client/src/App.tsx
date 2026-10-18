import type { ReactNode } from 'react';
import { Navigate, Route, Routes, useLocation } from 'react-router';
import type { Role } from '@shared/types';
import { useAuth } from './auth/AuthContext';
import { homeFor, postSignInPath } from './auth/redirect';
import { AppLayout } from './components/AppLayout';
import { PageLoader, ServerUnreachable } from './components/QueryState';
import { LoginPage } from './pages/auth/LoginPage';
import { RegisterPage } from './pages/auth/RegisterPage';
import { AccountPage } from './pages/AccountPage';
import { NotFoundPage } from './pages/NotFoundPage';
import { TeacherDashboard } from './pages/teacher/TeacherDashboard';
import { TeacherClassPage } from './pages/teacher/TeacherClassPage';
import { AssignmentFormPage } from './pages/teacher/AssignmentFormPage';
import { TeacherAssignmentPage } from './pages/teacher/TeacherAssignmentPage';
import { GradeSubmissionPage } from './pages/teacher/GradeSubmissionPage';
import { StudentDashboard } from './pages/student/StudentDashboard';
import { StudentClassPage } from './pages/student/StudentClassPage';
import { StudentAssignmentPage } from './pages/student/StudentAssignmentPage';

/**
 * What the route guards show before they know who is signed in: the retry card while the saved session can't be
 * checked (server unreachable; the token is kept), a loader while it is being checked, else null.
 */
function useStartupScreen(): ReactNode {
  const { loading, bootError, retry, retrying } = useAuth();
  if (bootError) return <ServerUnreachable message={bootError} onRetry={retry} retrying={retrying} />;
  if (loading) return <PageLoader />;
  return null;
}

/**
 * Signed-in users only (optionally a specific role); otherwise redirect. Users with a temporary password are
 * kept on /account until they choose their own; the page they wanted is passed along for afterwards.
 */
function RequireAuth({ role, children }: { role?: Role; children: ReactNode }) {
  const { user, signedOut } = useAuth();
  const location = useLocation();
  const startup = useStartupScreen();
  if (startup) return startup;
  if (!user) {
    const from = signedOut ? undefined : { from: location.pathname + location.search };
    return <Navigate to="/login" replace state={from} />;
  }
  if (user.mustChangePassword && location.pathname !== '/account') {
    return <Navigate to="/account" replace state={{ from: location.pathname + location.search }} />;
  }
  if (role && user.role !== role) return <Navigate to={homeFor(user.role)} replace />;
  return <>{children}</>;
}

/**
 * Login/register: send signed-in users on. Signing in only sets the user; this guard then redirects to the page
 * the user was trying to open (from location.state at render time, so it can't be lost to a race).
 */
function GuestOnly({ children }: { children: ReactNode }) {
  const { user } = useAuth();
  const location = useLocation();
  const startup = useStartupScreen();
  if (startup) return startup;
  if (user) return <Navigate to={postSignInPath(location.state, user)} replace />;
  return <>{children}</>;
}

function HomeRedirect() {
  const { user } = useAuth();
  const startup = useStartupScreen();
  if (startup) return startup;
  return <Navigate to={user ? homeFor(user.role) : '/login'} replace />;
}

/**
 * Route map (keep in sync with links in pages):
 *   /teacher                                          TeacherDashboard
 *   /teacher/classes/:classId?tab=assignments|students|gradebook|settings   TeacherClassPage
 *   /teacher/classes/:classId/assignments/new         AssignmentFormPage (create)
 *   /teacher/assignments/:assignmentId                TeacherAssignmentPage (submissions table)
 *   /teacher/assignments/:assignmentId/edit           AssignmentFormPage (edit)
 *   /teacher/assignments/:assignmentId/grade/:studentId   GradeSubmissionPage
 *   /student                                          StudentDashboard
 *   /student/classes/:classId                         StudentClassPage
 *   /student/assignments/:assignmentId                StudentAssignmentPage
 *   /account                                          AccountPage (change password)
 */
export default function App() {
  return (
    <Routes>
      <Route path="/" element={<HomeRedirect />} />
      <Route
        path="/login"
        element={
          <GuestOnly>
            <LoginPage />
          </GuestOnly>
        }
      />
      <Route
        path="/register"
        element={
          <GuestOnly>
            <RegisterPage />
          </GuestOnly>
        }
      />

      <Route
        element={
          <RequireAuth>
            <AppLayout />
          </RequireAuth>
        }
      >
        <Route path="/account" element={<AccountPage />} />

        <Route path="/teacher" element={<RequireAuth role="teacher"><TeacherDashboard /></RequireAuth>} />
        <Route path="/teacher/classes/:classId" element={<RequireAuth role="teacher"><TeacherClassPage /></RequireAuth>} />
        <Route
          path="/teacher/classes/:classId/assignments/new"
          element={<RequireAuth role="teacher"><AssignmentFormPage mode="create" /></RequireAuth>}
        />
        <Route
          path="/teacher/assignments/:assignmentId"
          element={<RequireAuth role="teacher"><TeacherAssignmentPage /></RequireAuth>}
        />
        <Route
          path="/teacher/assignments/:assignmentId/edit"
          element={<RequireAuth role="teacher"><AssignmentFormPage mode="edit" /></RequireAuth>}
        />
        <Route
          path="/teacher/assignments/:assignmentId/grade/:studentId"
          element={<RequireAuth role="teacher"><GradeSubmissionPage /></RequireAuth>}
        />

        <Route path="/student" element={<RequireAuth role="student"><StudentDashboard /></RequireAuth>} />
        <Route path="/student/classes/:classId" element={<RequireAuth role="student"><StudentClassPage /></RequireAuth>} />
        <Route
          path="/student/assignments/:assignmentId"
          element={<RequireAuth role="student"><StudentAssignmentPage /></RequireAuth>}
        />

        <Route path="*" element={<NotFoundPage />} />
      </Route>
    </Routes>
  );
}
