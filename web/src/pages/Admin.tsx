import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowLeft, Check, Copy, ExternalLink, KeyRound, Plus, Search, Shield } from 'lucide-react';
import { useState, type FormEvent } from 'react';
import { Link, Navigate } from 'react-router';
import { Badge, Button, Card, ErrorState, Field, Input, Modal, PageHeader, PageLoader, Select, Stat, Tabs } from '../components/ui';
import { api, errorMessage } from '../lib/api';
import { useAuth } from '../lib/auth';
import { BUSINESS_TYPES, CURRENCIES, formatDate, formatDateTime, formatNumber, guessCurrency, guessTimezone } from '../lib/format';
import { useToast } from '../lib/toast';
import type { Plan } from '../lib/types';

interface AdminOverview {
  workspaces: number;
  active_workspaces: number;
  users: number;
  channels: number;
  messages_24h: number;
  ai_replies_month: number;
  ai_cost_month: number;
  failed_jobs_24h: number;
  delayed_jobs: number;
}

interface AdminWorkspace {
  id: string;
  name: string;
  business_type: string;
  plan: string;
  status: 'active' | 'suspended';
  trial_ends_at: string | null;
  created_at: string;
  onboarded_at: string | null;
  owner_email: string | null;
  owner_is_admin: boolean | null;
  chat_key: string | null;
  channels: number;
  conversations_30d: number;
  orders_30d: number;
  ai_replies_month: number;
  ai_cost_month: number;
}

interface Job {
  id: number;
  type: string;
  payload: Record<string, unknown>;
  status: string;
  attempts: number;
  maxAttempts: number;
  lastError: string | null;
  runAt: string;
  updatedAt: string;
}

type TabId = 'workspaces' | 'jobs';

const usd = (n: number) => `$${n.toFixed(2)}`;

interface Login {
  email: string;
  password: string | null;
  existingUser: boolean;
}

function CopyButton({ text, label = 'Copy' }: { text: string; label?: string }) {
  const [done, setDone] = useState(false);
  return (
    <Button
      size="sm"
      variant="secondary"
      icon={done ? <Check className="size-4 text-emerald-600" /> : <Copy className="size-4" />}
      onClick={() => {
        navigator.clipboard
          .writeText(text)
          .then(() => {
            setDone(true);
            setTimeout(() => setDone(false), 1800);
          })
          .catch(() => {});
      }}
    >
      {done ? 'Copied' : label}
    </Button>
  );
}

/** Everything you'd send a client, in one message. */
function handoverMessage(businessName: string, chatUrl: string | null, login: Login | null): string {
  const lines = [`Your AI assistant for ${businessName} is ready.`];
  if (chatUrl) lines.push('', `Customer chat link (share it with your customers): ${chatUrl}`);
  if (login) {
    lines.push('', `Dashboard: ${window.location.origin}/login`, `Email: ${login.email}`);
    if (login.password) lines.push(`Password: ${login.password}`);
  }
  return lines.join('\n');
}

function Handover({ businessName, chatUrl, login }: { businessName: string; chatUrl: string | null; login: Login | null }) {
  return (
    <div className="space-y-3">
      {chatUrl && (
        <div>
          <p className="mb-1 text-sm font-medium text-zinc-800">Customer chat link</p>
          <p className="rounded-lg border border-zinc-200 bg-zinc-50 px-3 py-2 text-sm break-all text-zinc-800">{chatUrl}</p>
        </div>
      )}
      {login && (
        <div>
          <p className="mb-1 text-sm font-medium text-zinc-800">Client login</p>
          <div className="rounded-lg border border-zinc-200 bg-zinc-50 px-3 py-2 text-sm text-zinc-800">
            <div>Email: {login.email}</div>
            <div>{login.password ? `Password: ${login.password}` : 'Password: unchanged (this email already had an account)'}</div>
          </div>
          {login.password && <p className="mt-1 text-xs text-amber-700">This password is shown only now. Copy it before closing.</p>}
        </div>
      )}
      <CopyButton text={handoverMessage(businessName, chatUrl, login)} label="Copy message for the client" />
    </div>
  );
}

function AddClientModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  const qc = useQueryClient();
  const { refresh } = useAuth();
  const [name, setName] = useState('');
  const [type, setType] = useState('ecommerce');
  const [currency, setCurrency] = useState(guessCurrency());
  const [clientLogin, setClientLogin] = useState(false);
  const [email, setEmail] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [created, setCreated] = useState<{ workspace: { id: string; name: string }; chatUrl: string | null; login: Login | null } | null>(null);

  function close() {
    setName('');
    setEmail('');
    setClientLogin(false);
    setError(null);
    setCreated(null);
    onClose();
  }

  async function submit(e: FormEvent) {
    e.preventDefault();
    setLoading(true);
    setError(null);
    try {
      const res = await api<NonNullable<typeof created>>('/api/admin/clients', {
        body: {
          businessName: name,
          businessType: type,
          currency,
          timezone: guessTimezone(),
          ...(clientLogin && email.trim() ? { login: { email: email.trim() } } : {}),
        },
      });
      setCreated(res);
      qc.invalidateQueries({ queryKey: ['admin'] });
      await refresh();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setLoading(false);
    }
  }

  return (
    <Modal
      open={open}
      onClose={close}
      title={created ? `${created.workspace.name} is ready` : 'Add a client'}
      description={created ? 'Set up their assistant, then send them the chat link.' : 'You set it up. The client does not sign up or share anything.'}
      footer={
        created ? (
          <>
            <Button variant="secondary" onClick={close}>
              Done
            </Button>
            <Link to={`/w/${created.workspace.id}/onboarding`}>
              <Button icon={<ExternalLink className="size-4" />}>Set up their assistant</Button>
            </Link>
          </>
        ) : (
          <>
            <Button variant="secondary" onClick={close}>
              Cancel
            </Button>
            <Button type="submit" form="add-client" loading={loading}>
              Create client
            </Button>
          </>
        )
      }
    >
      {created ? (
        <Handover businessName={created.workspace.name} chatUrl={created.chatUrl} login={created.login} />
      ) : (
        <form id="add-client" onSubmit={submit} className="space-y-4">
          <Field label="Business name">
            <Input required autoFocus value={name} onChange={(e) => setName(e.target.value)} />
          </Field>
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Type of business">
              <Select value={type} onChange={(e) => setType(e.target.value)}>
                {BUSINESS_TYPES.map((t) => (
                  <option key={t.id} value={t.id}>
                    {t.label}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="Currency">
              <Select value={currency} onChange={(e) => setCurrency(e.target.value)}>
                {CURRENCIES.map((c) => (
                  <option key={c}>{c}</option>
                ))}
              </Select>
            </Field>
          </div>
          <div className="rounded-lg border border-zinc-200 p-3">
            <label className="flex items-start gap-2 text-sm">
              <input type="checkbox" className="mt-0.5" checked={clientLogin} onChange={(e) => setClientLogin(e.target.checked)} />
              <span>
                <span className="font-medium text-zinc-800">Also give the client their own login</span>
                <span className="block text-xs text-zinc-500">
                  Optional. Leave it off and you run the business from this console; the client only needs the chat link.
                </span>
              </span>
            </label>
            {clientLogin && (
              <Field className="mt-3" label="Client email" hint="Used only as their login name. A password is generated for you to pass on.">
                <Input type="email" required value={email} onChange={(e) => setEmail(e.target.value)} placeholder="owner@theirshop.com" />
              </Field>
            )}
          </div>
          {error && <p className="text-sm text-red-600">{error}</p>}
        </form>
      )}
    </Modal>
  );
}

function ClientLoginModal({ workspace, onClose }: { workspace: AdminWorkspace | null; onClose: () => void }) {
  const qc = useQueryClient();
  const [email, setEmail] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [login, setLogin] = useState<Login | null>(null);
  const hasClientLogin = Boolean(workspace && workspace.owner_email && !workspace.owner_is_admin);

  function close() {
    setEmail('');
    setError(null);
    setLogin(null);
    onClose();
  }

  async function submit(e: { preventDefault(): void }, resetPassword = false) {
    e.preventDefault();
    if (!workspace) return;
    setLoading(true);
    setError(null);
    try {
      const res = await api<{ login: Login }>(`/api/admin/workspaces/${workspace.id}/login`, {
        body: { email: (hasClientLogin ? workspace.owner_email : email.trim()) ?? '', resetPassword },
      });
      setLogin(res.login);
      qc.invalidateQueries({ queryKey: ['admin'] });
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setLoading(false);
    }
  }

  return (
    <Modal
      open={Boolean(workspace)}
      onClose={close}
      title={workspace ? `Client login for ${workspace.name}` : ''}
      description={hasClientLogin ? 'This client already has a login. You can set a new password for it.' : 'Give this client their own login to the dashboard.'}
      footer={
        login ? (
          <Button variant="secondary" onClick={close}>
            Done
          </Button>
        ) : (
          <>
            <Button variant="secondary" onClick={close}>
              Cancel
            </Button>
            {hasClientLogin ? (
              <Button loading={loading} icon={<KeyRound className="size-4" />} onClick={(e) => submit(e, true)}>
                Set a new password
              </Button>
            ) : (
              <Button type="submit" form="client-login" loading={loading}>
                Create login
              </Button>
            )}
          </>
        )
      }
    >
      {login && workspace ? (
        <Handover businessName={workspace.name} chatUrl={null} login={login} />
      ) : hasClientLogin && workspace ? (
        <div className="space-y-3">
          <p className="text-sm text-zinc-700">Login email: {workspace.owner_email}</p>
          {error && <p className="text-sm text-red-600">{error}</p>}
        </div>
      ) : (
        <form id="client-login" onSubmit={(e) => submit(e)} className="space-y-3">
          <Field label="Client email" hint="Used only as their login name. A password is generated for you to pass on.">
            <Input type="email" required value={email} onChange={(e) => setEmail(e.target.value)} placeholder="owner@theirshop.com" />
          </Field>
          {error && <p className="text-sm text-red-600">{error}</p>}
        </form>
      )}
    </Modal>
  );
}

export default function Admin() {
  const { user } = useAuth();
  const [tab, setTab] = useState<TabId>('workspaces');
  const [adding, setAdding] = useState(false);
  if (!user?.isSuperadmin) return <Navigate to="/" replace />;
  return (
    <div className="min-h-screen bg-zinc-50">
      <header className="flex h-14 items-center gap-3 border-b border-zinc-200 bg-white px-4 lg:px-8">
        <Link to="/" className="inline-flex items-center gap-1.5 text-sm text-zinc-600 hover:text-zinc-900">
          <ArrowLeft className="size-4" /> Back to app
        </Link>
        <span className="text-zinc-300">/</span>
        <span className="inline-flex items-center gap-1.5 text-sm font-medium text-zinc-900">
          <Shield className="size-4 text-brand-700" /> Admin console
        </span>
      </header>
      <div className="mx-auto max-w-7xl px-4 py-6 lg:px-8">
        <PageHeader
          title="Admin console"
          description="Every business on the platform: plans, usage, AI cost and background job health."
          actions={
            <Button icon={<Plus className="size-4" />} onClick={() => setAdding(true)}>
              Add a client
            </Button>
          }
        />
        <AddClientModal open={adding} onClose={() => setAdding(false)} />
        <OverviewTiles />
        <Tabs<TabId>
          className="mt-8 mb-6"
          value={tab}
          onChange={setTab}
          tabs={[
            { id: 'workspaces', label: 'Businesses' },
            { id: 'jobs', label: 'Background jobs' },
          ]}
        />
        {tab === 'workspaces' ? <WorkspacesTable /> : <Jobs />}
      </div>
    </div>
  );
}

function OverviewTiles() {
  const q = useQuery({ queryKey: ['admin', 'overview'], queryFn: () => api<{ overview: AdminOverview }>('/api/admin/overview'), refetchInterval: 60_000 });
  if (q.isLoading) return <PageLoader />;
  if (!q.data) return <ErrorState error={q.error} retry={() => q.refetch()} />;
  const o = q.data.overview;
  return (
    <div className="grid grid-cols-2 gap-4 md:grid-cols-3 lg:grid-cols-6">
      <Stat label="Businesses" value={formatNumber(o.workspaces)} hint={`${formatNumber(o.active_workspaces)} active`} />
      <Stat label="Users" value={formatNumber(o.users)} />
      <Stat label="Live channels" value={formatNumber(o.channels)} />
      <Stat label="Messages (24 h)" value={formatNumber(o.messages_24h)} />
      <Stat label="AI replies this month" value={formatNumber(o.ai_replies_month)} hint={`${usd(o.ai_cost_month)} model cost`} />
      <Stat
        label="Job health"
        value={o.failed_jobs_24h + o.delayed_jobs === 0 ? 'OK' : `${o.failed_jobs_24h} failed`}
        hint={o.delayed_jobs ? `${o.delayed_jobs} delayed` : 'Last 24 hours'}
      />
    </div>
  );
}

function WorkspacesTable() {
  const qc = useQueryClient();
  const toast = useToast();
  const [search, setSearch] = useState('');
  const [loginFor, setLoginFor] = useState<AdminWorkspace | null>(null);
  const list = useQuery({
    queryKey: ['admin', 'workspaces', search],
    queryFn: () => api<{ workspaces: AdminWorkspace[]; chatUrlBase: string }>(`/api/admin/workspaces?q=${encodeURIComponent(search)}`),
    placeholderData: keepPreviousData,
  });
  const plans = useQuery({ queryKey: ['admin', 'overview'], queryFn: () => api<{ overview: AdminOverview; plans: Plan[] }>('/api/admin/overview'), select: (d) => d.plans });
  const update = useMutation({
    mutationFn: ({ id, patch }: { id: string; patch: Record<string, unknown> }) => api(`/api/admin/workspaces/${id}`, { method: 'PATCH', body: patch }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['admin'] });
      toast.success('Updated');
    },
    onError: (err) => toast.error(errorMessage(err)),
  });

  const typeLabel = (t: string) => BUSINESS_TYPES.find((b) => b.id === t)?.label ?? t;
  const chatUrlBase = list.data?.chatUrlBase ?? '';

  return (
    <Card bodyClassName="p-0">
      <ClientLoginModal workspace={loginFor} onClose={() => setLoginFor(null)} />
      <div className="border-b border-zinc-100 p-3">
        <div className="relative max-w-sm">
          <Search className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-zinc-400" />
          <Input className="pl-9" placeholder="Search businesses" value={search} onChange={(e) => setSearch(e.target.value)} />
        </div>
      </div>
      {list.isLoading ? (
        <PageLoader />
      ) : !list.data ? (
        <div className="p-4">
          <ErrorState error={list.error} retry={() => list.refetch()} />
        </div>
      ) : list.data.workspaces.length === 0 ? (
        <p className="p-6 text-center text-sm text-zinc-500">No businesses found.</p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full min-w-[960px] text-sm">
            <thead>
              <tr className="border-b border-zinc-100 text-left text-xs text-zinc-500">
                <th className="px-4 py-2 font-medium">Business</th>
                <th className="px-4 py-2 font-medium">Plan</th>
                <th className="px-4 py-2 font-medium">Trial ends</th>
                <th className="px-4 py-2 font-medium">Status</th>
                <th className="px-4 py-2 text-right font-medium">Channels</th>
                <th className="px-4 py-2 text-right font-medium">Chats 30d</th>
                <th className="px-4 py-2 text-right font-medium">Orders 30d</th>
                <th className="px-4 py-2 text-right font-medium">AI replies (month)</th>
                <th className="px-4 py-2 text-right font-medium">AI cost (month)</th>
              </tr>
            </thead>
            <tbody>
              {list.data.workspaces.map((w) => (
                <tr key={w.id} className="border-b border-zinc-100 last:border-0">
                  <td className="px-4 py-2.5">
                    <Link
                      to={w.onboarded_at ? `/w/${w.id}/dashboard` : `/w/${w.id}/onboarding`}
                      className="font-medium text-zinc-900 hover:text-brand-700 hover:underline"
                      title="Open this business"
                    >
                      {w.name}
                    </Link>
                    <div className="text-xs text-zinc-500">
                      {typeLabel(w.business_type)} · {w.owner_is_admin ? 'managed by you' : (w.owner_email ?? 'no owner')} · added {formatDate(w.created_at)}
                      {!w.onboarded_at && ' · setup not finished'}
                    </div>
                    <div className="mt-1 flex gap-1.5">
                      {w.chat_key && <CopyButton text={`${chatUrlBase}${w.chat_key}`} label="Chat link" />}
                      <Button size="sm" variant="secondary" icon={<KeyRound className="size-4" />} onClick={() => setLoginFor(w)}>
                        {w.owner_is_admin ? 'Give login' : 'Login'}
                      </Button>
                    </div>
                  </td>
                  <td className="px-4 py-2.5">
                    <Select className="h-8 w-32" value={w.plan} onChange={(e) => update.mutate({ id: w.id, patch: { plan: e.target.value } })}>
                      {(plans.data ?? [{ id: w.plan, name: w.plan } as Plan]).map((p) => (
                        <option key={p.id} value={p.id}>
                          {p.name}
                        </option>
                      ))}
                    </Select>
                  </td>
                  <td className="px-4 py-2.5">
                    <Input
                      type="date"
                      className="h-8 w-40"
                      defaultValue={w.trial_ends_at ? new Date(w.trial_ends_at).toISOString().slice(0, 10) : ''}
                      onBlur={(e) => {
                        const v = e.target.value;
                        const before = w.trial_ends_at ? new Date(w.trial_ends_at).toISOString().slice(0, 10) : '';
                        if (v === before) return;
                        update.mutate({ id: w.id, patch: { trialEndsAt: v ? new Date(`${v}T23:59:59Z`).toISOString() : null } });
                      }}
                    />
                  </td>
                  <td className="px-4 py-2.5">
                    <button
                      onClick={() => {
                        const next = w.status === 'active' ? 'suspended' : 'active';
                        if (next === 'suspended' && !window.confirm(`Suspend ${w.name}? Their assistant stops replying.`)) return;
                        update.mutate({ id: w.id, patch: { status: next } });
                      }}
                      title={w.status === 'active' ? 'Click to suspend' : 'Click to reactivate'}
                    >
                      <Badge tone={w.status === 'active' ? 'green' : 'red'}>{w.status === 'active' ? 'Active' : 'Suspended'}</Badge>
                    </button>
                  </td>
                  <td className="px-4 py-2.5 text-right tabular-nums">{w.channels}</td>
                  <td className="px-4 py-2.5 text-right tabular-nums">{formatNumber(w.conversations_30d)}</td>
                  <td className="px-4 py-2.5 text-right tabular-nums">{formatNumber(w.orders_30d)}</td>
                  <td className="px-4 py-2.5 text-right tabular-nums">{formatNumber(w.ai_replies_month)}</td>
                  <td className="px-4 py-2.5 text-right tabular-nums">{usd(w.ai_cost_month)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Card>
  );
}

function Jobs() {
  const [status, setStatus] = useState<'failed' | 'queued' | 'running'>('failed');
  const q = useQuery({ queryKey: ['admin', 'jobs', status], queryFn: () => api<{ jobs: Job[] }>(`/api/admin/jobs?status=${status}`), refetchInterval: 30_000 });
  return (
    <Card
      title="Background jobs"
      description="Replies, media processing, follow-ups and reports run as jobs. Showing the last 7 days."
      actions={
        <Select className="h-9 w-36" value={status} onChange={(e) => setStatus(e.target.value as typeof status)}>
          <option value="failed">Failed</option>
          <option value="queued">Queued</option>
          <option value="running">Running</option>
        </Select>
      }
      bodyClassName="p-0"
    >
      {q.isLoading ? (
        <PageLoader />
      ) : !q.data ? (
        <div className="p-4">
          <ErrorState error={q.error} retry={() => q.refetch()} />
        </div>
      ) : q.data.jobs.length === 0 ? (
        <p className="p-6 text-center text-sm text-zinc-500">No {status} jobs. All good.</p>
      ) : (
        <ul className="divide-y divide-zinc-100">
          {q.data.jobs.map((j) => (
            <li key={j.id} className="px-5 py-3">
              <div className="flex flex-wrap items-center gap-2 text-sm">
                <span className="font-mono font-medium text-zinc-900">{j.type}</span>
                <Badge tone={j.status === 'failed' ? 'red' : 'zinc'}>
                  {j.status} · attempt {j.attempts}/{j.maxAttempts}
                </Badge>
                <span className="ml-auto text-xs text-zinc-500">{formatDateTime(j.updatedAt)}</span>
              </div>
              {j.lastError && <p className="mt-1 text-xs break-words text-red-700">{j.lastError}</p>}
              <details className="mt-1">
                <summary className="cursor-pointer text-xs text-zinc-500">Payload</summary>
                <pre className="scroll-thin mt-1 max-h-40 overflow-auto rounded bg-zinc-50 p-2 text-xs text-zinc-700">{JSON.stringify(j.payload, null, 2)}</pre>
              </details>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}
