import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  Bell,
  BookOpen,
  Bot,
  CalendarDays,
  ChevronsUpDown,
  FileText,
  FlaskConical,
  LayoutDashboard,
  LogOut,
  Menu,
  MessagesSquare,
  Package,
  Plug,
  Plus,
  Settings,
  Shield,
  ShoppingBag,
  Users,
  X,
} from 'lucide-react';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Link, NavLink, Outlet, useLocation, useNavigate } from 'react-router';
import { ws as wsApi } from '../lib/api';
import { useAuth } from '../lib/auth';
import { timeAgo } from '../lib/format';
import type { Notification } from '../lib/types';
import { rememberWorkspace, useWid, useWorkspace } from '../lib/workspace';
import { Badge, Banner, cx, ErrorState, PageLoader } from './ui';

interface NavItem {
  to: string;
  label: string;
  icon: ReactNode;
  badge?: number;
  hidden?: boolean;
}

function Brand() {
  const { app } = useAuth();
  return (
    <div className="flex items-center gap-2 px-2">
      <img src="/favicon.svg" alt="" className="size-7" />
      <span className="truncate text-[15px] font-semibold tracking-tight text-zinc-900">{app?.appName ?? 'AI Assistance'}</span>
    </div>
  );
}

function WorkspaceSwitcher() {
  const { workspaces } = useAuth();
  const wid = useWid();
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const current = workspaces.find((w) => w.id === wid);
  const { data } = useWorkspace();
  useEffect(() => {
    const close = (e: MouseEvent) => ref.current && !ref.current.contains(e.target as Node) && setOpen(false);
    document.addEventListener('mousedown', close);
    return () => document.removeEventListener('mousedown', close);
  }, []);
  return (
    <div className="relative" ref={ref}>
      <button
        onClick={() => setOpen(!open)}
        className="flex w-full items-center gap-2 rounded-lg border border-zinc-200 bg-white px-3 py-2 text-left shadow-xs hover:bg-zinc-50"
      >
        <div className="min-w-0 flex-1">
          <div className="truncate text-sm font-medium text-zinc-900">{current?.name ?? data?.workspace.name ?? 'Business'}</div>
          <div className="truncate text-xs text-zinc-500">{data?.plan.name ?? ''}</div>
        </div>
        <ChevronsUpDown className="size-4 shrink-0 text-zinc-400" />
      </button>
      {open && (
        <div className="absolute inset-x-0 top-full z-30 mt-1 rounded-lg border border-zinc-200 bg-white p-1 shadow-lg">
          {workspaces.map((w) => (
            <Link
              key={w.id}
              to={`/w/${w.id}/dashboard`}
              onClick={() => setOpen(false)}
              className={cx('block truncate rounded-md px-3 py-2 text-sm hover:bg-zinc-100', w.id === wid && 'bg-zinc-100 font-medium')}
            >
              {w.name}
            </Link>
          ))}
          <Link to="/new-business" onClick={() => setOpen(false)} className="mt-1 flex items-center gap-2 rounded-md border-t border-zinc-100 px-3 py-2 text-sm text-brand-800 hover:bg-brand-50">
            <Plus className="size-4" /> Add another business
          </Link>
        </div>
      )}
    </div>
  );
}

function Notifications() {
  const wid = useWid();
  const qc = useQueryClient();
  const navigate = useNavigate();
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const { data } = useQuery({
    queryKey: ['ws', wid, 'notifications'],
    queryFn: () => wsApi(wid).get<{ notifications: Notification[]; unread: number }>('/notifications'),
    refetchInterval: 30_000,
  });
  const markRead = useMutation({
    mutationFn: () => wsApi(wid).post('/notifications/read-all'),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['ws', wid, 'notifications'] }),
  });
  useEffect(() => {
    const close = (e: MouseEvent) => ref.current && !ref.current.contains(e.target as Node) && setOpen(false);
    document.addEventListener('mousedown', close);
    return () => document.removeEventListener('mousedown', close);
  }, []);
  const unread = data?.unread ?? 0;
  return (
    <div className="relative" ref={ref}>
      <button
        aria-label="Notifications"
        onClick={() => {
          setOpen(!open);
          if (!open && unread > 0) markRead.mutate();
        }}
        className="relative inline-flex size-9 items-center justify-center rounded-lg text-zinc-600 hover:bg-zinc-100"
      >
        <Bell className="size-5" />
        {unread > 0 && (
          <span className="absolute top-1 right-1 flex h-4 min-w-4 items-center justify-center rounded-full bg-red-500 px-1 text-[10px] font-bold text-white">
            {unread > 9 ? '9+' : unread}
          </span>
        )}
      </button>
      {open && (
        <div className="absolute right-0 z-40 mt-2 w-80 max-w-[calc(100vw-2rem)] rounded-xl border border-zinc-200 bg-white shadow-lg">
          <div className="border-b border-zinc-100 px-4 py-3 text-sm font-semibold">Notifications</div>
          <div className="scroll-thin max-h-96 overflow-y-auto">
            {(data?.notifications ?? []).length === 0 && <p className="px-4 py-8 text-center text-sm text-zinc-500">You're all caught up.</p>}
            {(data?.notifications ?? []).map((n) => (
              <button
                key={n.id}
                onClick={() => {
                  setOpen(false);
                  if (n.link) navigate(`/w/${wid}${n.link}`);
                }}
                className={cx('block w-full border-b border-zinc-50 px-4 py-3 text-left hover:bg-zinc-50', !n.readAt && 'bg-brand-50/40')}
              >
                <div className="flex items-start justify-between gap-2">
                  <span className="text-sm font-medium text-zinc-900">{n.title}</span>
                  <span className="shrink-0 text-xs text-zinc-400">{timeAgo(n.createdAt)}</span>
                </div>
                {n.body && <p className="mt-0.5 line-clamp-2 text-xs whitespace-pre-line text-zinc-500">{n.body}</p>}
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

export default function Layout() {
  const wid = useWid();
  const { user, app, logout } = useAuth();
  const { data, isLoading, error, refetch } = useWorkspace();
  const navigate = useNavigate();
  const location = useLocation();
  const [mobileOpen, setMobileOpen] = useState(false);
  const badge = useQuery({
    queryKey: ['ws', wid, 'badge'],
    queryFn: () => wsApi(wid).get<{ unread: number; needsHuman: number }>('/conversations/badge'),
    refetchInterval: 15_000,
  });

  useEffect(() => rememberWorkspace(wid), [wid]);
  useEffect(() => setMobileOpen(false), [location.pathname]);

  if (isLoading) return <PageLoader />;
  if (error || !data) {
    return (
      <div className="mx-auto max-w-lg p-8">
        <ErrorState error={error} retry={() => refetch()} />
        <Link to="/" className="mt-4 inline-block text-sm text-brand-800 underline">
          Go to my businesses
        </Link>
      </div>
    );
  }
  const w = data.workspace;
  const p = (path: string) => `/w/${wid}/${path}`;
  const nav: NavItem[] = [
    { to: p('dashboard'), label: 'Dashboard', icon: <LayoutDashboard className="size-4" /> },
    { to: p('inbox'), label: 'Inbox', icon: <MessagesSquare className="size-4" />, badge: (badge.data?.needsHuman ?? 0) + (badge.data?.unread ?? 0) },
    { to: p('contacts'), label: 'Leads & customers', icon: <Users className="size-4" /> },
    { to: p('orders'), label: 'Orders', icon: <ShoppingBag className="size-4" />, hidden: !w.commerce.ordersEnabled },
    { to: p('bookings'), label: 'Bookings', icon: <CalendarDays className="size-4" />, hidden: !w.booking.enabled },
  ];
  const setup: NavItem[] = [
    { to: p('catalog'), label: 'Products & services', icon: <Package className="size-4" /> },
    { to: p('knowledge'), label: 'Knowledge', icon: <BookOpen className="size-4" /> },
    { to: p('assistant'), label: 'AI assistant', icon: <Bot className="size-4" /> },
    { to: p('channels'), label: 'Channels', icon: <Plug className="size-4" /> },
    { to: p('playground'), label: 'Test chat', icon: <FlaskConical className="size-4" /> },
    { to: p('reports'), label: 'Reports', icon: <FileText className="size-4" /> },
    { to: p('settings'), label: 'Settings', icon: <Settings className="size-4" /> },
  ];

  const trialDaysLeft = w.plan === 'trial' && w.trialEndsAt ? Math.ceil((new Date(w.trialEndsAt).getTime() - Date.now()) / 86_400_000) : null;
  const isAdmin = data.role === 'owner' || data.role === 'admin';

  const navLink = (item: NavItem) =>
    item.hidden ? null : (
      <NavLink
        key={item.to}
        to={item.to}
        className={({ isActive }) =>
          cx(
            'flex items-center gap-2.5 rounded-lg px-3 py-2 text-sm font-medium transition-colors',
            isActive ? 'bg-brand-50 text-brand-800' : 'text-zinc-600 hover:bg-zinc-100 hover:text-zinc-900',
          )
        }
      >
        {item.icon}
        <span className="flex-1 truncate">{item.label}</span>
        {!!item.badge && <span className="rounded-full bg-red-500 px-1.5 text-[11px] font-bold text-white tabular-nums">{item.badge}</span>}
      </NavLink>
    );

  const sidebar = (
    <div className="flex h-full flex-col gap-4 p-3">
      <div className="flex items-center justify-between pt-1">
        <Brand />
        <button className="rounded-lg p-1.5 text-zinc-500 hover:bg-zinc-100 lg:hidden" onClick={() => setMobileOpen(false)} aria-label="Close menu">
          <X className="size-5" />
        </button>
      </div>
      <WorkspaceSwitcher />
      <nav className="scroll-thin flex-1 space-y-0.5 overflow-y-auto">
        {nav.map(navLink)}
        <div className="px-3 pt-5 pb-1 text-xs font-semibold tracking-wide text-zinc-400 uppercase">Set up</div>
        {setup.map(navLink)}
        {user?.isSuperadmin && (
          <>
            <div className="px-3 pt-5 pb-1 text-xs font-semibold tracking-wide text-zinc-400 uppercase">Platform</div>
            {navLink({ to: '/admin', label: 'Admin console', icon: <Shield className="size-4" /> })}
          </>
        )}
      </nav>
      <div className="flex items-center gap-2 border-t border-zinc-200 pt-3">
        <div className="min-w-0 flex-1 px-1">
          <div className="truncate text-sm font-medium text-zinc-900">{user?.name}</div>
          <div className="truncate text-xs text-zinc-500">{user?.email}</div>
        </div>
        <button
          onClick={async () => {
            await logout();
            navigate('/login');
          }}
          className="rounded-lg p-2 text-zinc-500 hover:bg-zinc-100 hover:text-zinc-900"
          aria-label="Sign out"
          title="Sign out"
        >
          <LogOut className="size-4" />
        </button>
      </div>
    </div>
  );

  const inboxPage = location.pathname.endsWith('/inbox');

  return (
    <div className="flex h-full">
      <aside className="hidden w-64 shrink-0 border-r border-zinc-200 bg-white lg:block">{sidebar}</aside>
      {mobileOpen && (
        <div className="fixed inset-0 z-40 bg-zinc-950/30 lg:hidden" onClick={() => setMobileOpen(false)}>
          <aside className="h-full w-72 max-w-[85vw] bg-white shadow-xl" onClick={(e) => e.stopPropagation()}>
            {sidebar}
          </aside>
        </div>
      )}
      <div className="flex min-w-0 flex-1 flex-col">
        <header className="flex h-14 shrink-0 items-center gap-3 border-b border-zinc-200 bg-white px-4">
          <button className="rounded-lg p-1.5 text-zinc-600 hover:bg-zinc-100 lg:hidden" onClick={() => setMobileOpen(true)} aria-label="Open menu">
            <Menu className="size-5" />
          </button>
          <div className="min-w-0 flex-1 truncate text-sm font-medium text-zinc-700 lg:hidden">{w.name}</div>
          <div className="hidden flex-1 items-center gap-2 lg:flex">
            {w.ai.enabled ? (
              <Badge tone="green">
                <span className="size-1.5 rounded-full bg-emerald-500" /> {w.ai.assistantName} is answering customers
              </Badge>
            ) : (
              <Badge tone="zinc">AI assistant is off</Badge>
            )}
          </div>
          {trialDaysLeft !== null && trialDaysLeft >= 0 && (
            <Link to={p('settings?tab=billing')} className="hidden text-xs font-medium text-amber-700 hover:underline sm:block">
              Trial: {trialDaysLeft} day{trialDaysLeft === 1 ? '' : 's'} left
            </Link>
          )}
          <Notifications />
        </header>
        <main className={cx('scroll-thin min-h-0 flex-1', inboxPage ? 'overflow-hidden' : 'overflow-y-auto')}>
          {(!app?.aiConfigured || app?.aiMock || w.status === 'suspended' || (trialDaysLeft !== null && trialDaysLeft < 0) || !w.ai.enabled) && (
            <div className="space-y-2 px-4 pt-4 lg:px-8">
              {w.status === 'suspended' && <Banner tone="red">This business is suspended. Customers are not receiving AI replies. Contact support.</Banner>}
              {trialDaysLeft !== null && trialDaysLeft < 0 && (
                <Banner tone="red" action={<Link className="font-medium underline" to={p('settings?tab=billing')}>Choose a plan</Link>}>
                  Your free trial has ended, so the AI assistant has stopped replying.
                </Banner>
              )}
              {!app?.aiConfigured && isAdmin && (
                <Banner tone="amber">The server has no AI key yet, so the assistant cannot reply. Add GROQ_API_KEY (free) or ANTHROPIC_API_KEY to the server's .env file.</Banner>
              )}
              {app?.aiMock && <Banner tone="zinc">AI mock mode is on (AI_MOCK=true): replies are test messages, not real AI.</Banner>}
              {!w.ai.enabled && isAdmin && (
                <Banner tone="amber" action={<Link className="font-medium underline" to={p('assistant')}>Turn it on</Link>}>
                  The AI assistant is turned off. Messages wait for your team.
                </Banner>
              )}
            </div>
          )}
          <Outlet />
        </main>
      </div>
    </div>
  );
}

export function PageContainer({ children, wide }: { children: ReactNode; wide?: boolean }) {
  return <div className={cx('mx-auto px-4 py-6 lg:px-8', wide ? 'max-w-7xl' : 'max-w-5xl')}>{children}</div>;
}
