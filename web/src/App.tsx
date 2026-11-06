import { lazy, Suspense, useEffect } from 'react';
import { Navigate, Outlet, Route, Routes, useLocation } from 'react-router';
import Layout from './components/Layout';
import { PageLoader } from './components/ui';
import { useAuth } from './lib/auth';
import { lastWorkspace } from './lib/workspace';

const Login = lazy(() => import('./pages/auth/Login'));
const Signup = lazy(() => import('./pages/auth/Signup'));
const ForgotPassword = lazy(() => import('./pages/auth/ForgotPassword'));
const ResetPassword = lazy(() => import('./pages/auth/ResetPassword'));
const AcceptInvite = lazy(() => import('./pages/auth/AcceptInvite'));
const NewBusiness = lazy(() => import('./pages/NewBusiness'));
const Onboarding = lazy(() => import('./pages/Onboarding'));
const Dashboard = lazy(() => import('./pages/Dashboard'));
const Inbox = lazy(() => import('./pages/Inbox'));
const Contacts = lazy(() => import('./pages/Contacts'));
const Orders = lazy(() => import('./pages/Orders'));
const Bookings = lazy(() => import('./pages/Bookings'));
const Catalog = lazy(() => import('./pages/Catalog'));
const Knowledge = lazy(() => import('./pages/Knowledge'));
const Channels = lazy(() => import('./pages/Channels'));
const Assistant = lazy(() => import('./pages/Assistant'));
const Playground = lazy(() => import('./pages/Playground'));
const Reports = lazy(() => import('./pages/Reports'));
const Settings = lazy(() => import('./pages/Settings'));
const Admin = lazy(() => import('./pages/Admin'));

function RequireAuth() {
  const { user, loading } = useAuth();
  const location = useLocation();
  if (loading) return <PageLoader />;
  if (!user) return <Navigate to={`/login?next=${encodeURIComponent(location.pathname + location.search)}`} replace />;
  return <Outlet />;
}

function PublicOnly() {
  const { user, loading } = useAuth();
  if (loading) return <PageLoader />;
  if (user) return <Navigate to="/" replace />;
  return <Outlet />;
}

function Home() {
  const { workspaces } = useAuth();
  if (workspaces.length === 0) return <Navigate to="/new-business" replace />;
  const remembered = lastWorkspace();
  const ws = workspaces.find((w) => w.id === remembered) ?? workspaces[0];
  return <Navigate to={ws.onboarded ? `/w/${ws.id}/dashboard` : `/w/${ws.id}/onboarding`} replace />;
}

function Title() {
  const { app } = useAuth();
  useEffect(() => {
    if (app?.appName) document.title = app.appName;
  }, [app?.appName]);
  return null;
}

export default function App() {
  return (
    <Suspense fallback={<PageLoader />}>
      <Title />
      <Routes>
        <Route element={<PublicOnly />}>
          <Route path="/login" element={<Login />} />
          <Route path="/signup" element={<Signup />} />
        </Route>
        <Route path="/forgot-password" element={<ForgotPassword />} />
        <Route path="/reset-password" element={<ResetPassword />} />
        <Route path="/invite/:token" element={<AcceptInvite />} />
        <Route element={<RequireAuth />}>
          <Route path="/" element={<Home />} />
          <Route path="/new-business" element={<NewBusiness />} />
          <Route path="/admin" element={<Admin />} />
          <Route path="/w/:wid/onboarding" element={<Onboarding />} />
          <Route path="/w/:wid" element={<Layout />}>
            <Route index element={<Navigate to="dashboard" replace />} />
            <Route path="dashboard" element={<Dashboard />} />
            <Route path="inbox" element={<Inbox />} />
            <Route path="contacts" element={<Contacts />} />
            <Route path="orders" element={<Orders />} />
            <Route path="bookings" element={<Bookings />} />
            <Route path="catalog" element={<Catalog />} />
            <Route path="knowledge" element={<Knowledge />} />
            <Route path="channels" element={<Channels />} />
            <Route path="assistant" element={<Assistant />} />
            <Route path="playground" element={<Playground />} />
            <Route path="reports" element={<Reports />} />
            <Route path="settings" element={<Settings />} />
          </Route>
        </Route>
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </Suspense>
  );
}
