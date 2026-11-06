import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Check, Copy, Trash2, UserPlus } from 'lucide-react';
import { useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router';
import { HoursEditor } from '../components/editors';
import { PageContainer } from '../components/Layout';
import {
  Avatar,
  Badge,
  Banner,
  Button,
  Card,
  cx,
  ErrorState,
  Field,
  IconButton,
  Input,
  Modal,
  PageHeader,
  PageLoader,
  SaveBar,
  Select,
  Tabs,
  Textarea,
  Toggle,
} from '../components/ui';
import { api as rawApi, errorMessage } from '../lib/api';
import { useAuth } from '../lib/auth';
import { BUSINESS_TYPES, CURRENCIES, formatDate, formatNumber, timezones } from '../lib/format';
import { useDraft, useSaveSettings } from '../lib/settings';
import { useToast } from '../lib/toast';
import type { BusinessProfile, BusinessType, Plan, Role, Usage, WorkspaceDetail } from '../lib/types';
import { useWid, useWorkspace, useWsApi } from '../lib/workspace';

type TabId = 'profile' | 'team' | 'billing' | 'account' | 'danger';

export default function Settings() {
  const { data, isLoading, error, refetch } = useWorkspace();
  const [params, setParams] = useSearchParams();
  const raw = params.get('tab');
  const tab = (['profile', 'team', 'billing', 'account', 'danger'].includes(raw ?? '') ? raw : 'profile') as TabId;
  if (isLoading) return <PageLoader />;
  if (!data) {
    return (
      <PageContainer>
        <ErrorState error={error} retry={() => refetch()} />
      </PageContainer>
    );
  }
  const tabs: { id: TabId; label: string }[] = [
    { id: 'profile', label: 'Business profile' },
    { id: 'team', label: 'Team' },
    { id: 'billing', label: 'Plan & usage' },
    { id: 'account', label: 'My account' },
  ];
  if (data.role === 'owner') tabs.push({ id: 'danger', label: 'Delete business' });

  return (
    <PageContainer>
      <PageHeader title="Settings" />
      <Tabs<TabId> className="mb-6" value={tab} tabs={tabs} onChange={(id) => setParams({ tab: id }, { replace: true })} />
      {tab === 'profile' && <ProfileForm detail={data} />}
      {tab === 'team' && <Team detail={data} />}
      {tab === 'billing' && <Billing detail={data} />}
      {tab === 'account' && <Account />}
      {tab === 'danger' && data.role === 'owner' && <DangerZone detail={data} />}
    </PageContainer>
  );
}

// ---------------------------------------------------------------------------
// Business profile
// ---------------------------------------------------------------------------

function ProfileForm({ detail }: { detail: WorkspaceDetail }) {
  const w = detail.workspace;
  const canEdit = detail.role === 'owner' || detail.role === 'admin';
  const [draft, setDraft, dirty, reset] = useDraft({
    name: w.name,
    businessType: w.businessType,
    timezone: w.timezone,
    currency: w.currency,
    profile: w.profile,
  });
  const save = useSaveSettings('Business profile saved');
  const setProfile = (patch: Partial<BusinessProfile>) => setDraft((d) => ({ ...d, profile: { ...d.profile, ...patch } }));
  const setPolicy = (k: keyof BusinessProfile['policies'], v: string) => setDraft((d) => ({ ...d, profile: { ...d.profile, policies: { ...d.profile.policies, [k]: v } } }));
  const p = draft.profile;
  const zones = timezones();

  return (
    <>
      {!canEdit && <Banner tone="zinc">Only owners and admins can change the business profile.</Banner>}
      <fieldset disabled={!canEdit} className="space-y-6">
        <Card title="Business" description="The assistant uses all of this to answer customers accurately." bodyClassName="space-y-5">
          <div className="grid gap-5 sm:grid-cols-2">
            <Field label="Business name">
              <Input value={draft.name} maxLength={120} onChange={(e) => setDraft((d) => ({ ...d, name: e.target.value }))} />
            </Field>
            <Field label="Type of business">
              <Select value={draft.businessType} onChange={(e) => setDraft((d) => ({ ...d, businessType: e.target.value as BusinessType }))}>
                {BUSINESS_TYPES.map((t) => (
                  <option key={t.id} value={t.id}>
                    {t.label}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="Timezone" hint="Used for opening hours, bookings and report times.">
              <Select value={draft.timezone} onChange={(e) => setDraft((d) => ({ ...d, timezone: e.target.value }))}>
                {(zones.includes(draft.timezone) ? zones : [draft.timezone, ...zones]).map((z) => (
                  <option key={z} value={z}>
                    {z}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="Currency">
              <Select value={draft.currency} onChange={(e) => setDraft((d) => ({ ...d, currency: e.target.value }))}>
                {(CURRENCIES.includes(draft.currency) ? CURRENCIES : [draft.currency, ...CURRENCIES]).map((c) => (
                  <option key={c} value={c}>
                    {c}
                  </option>
                ))}
              </Select>
            </Field>
          </div>
          <Field label="About the business" hint="What you sell or do, who it's for, what makes you different.">
            <Textarea rows={4} maxLength={5000} value={p.description} onChange={(e) => setProfile({ description: e.target.value })} />
          </Field>
        </Card>

        <Card title="Contact details" description="Shared with customers when they ask." bodyClassName="grid gap-5 sm:grid-cols-2">
          <Field label="Phone">
            <Input value={p.phone ?? ''} onChange={(e) => setProfile({ phone: e.target.value })} />
          </Field>
          <Field label="Email">
            <Input type="email" value={p.email ?? ''} onChange={(e) => setProfile({ email: e.target.value })} />
          </Field>
          <Field label="Website">
            <Input value={p.website ?? ''} placeholder="https://" onChange={(e) => setProfile({ website: e.target.value })} />
          </Field>
          <Field label="Address">
            <Input value={p.address ?? ''} onChange={(e) => setProfile({ address: e.target.value })} />
          </Field>
        </Card>

        <Card title="Opening hours" description="The assistant tells customers when you're open; bookings follow these hours unless you set different ones.">
          <HoursEditor value={p.hours} onChange={(hours) => setProfile({ hours })} />
        </Card>

        <Card title="Policies" bodyClassName="space-y-5">
          <Field label="Delivery / shipping">
            <Textarea rows={3} value={p.policies.shipping ?? ''} onChange={(e) => setPolicy('shipping', e.target.value)} />
          </Field>
          <Field label="Returns & exchanges">
            <Textarea rows={3} value={p.policies.returns ?? ''} onChange={(e) => setPolicy('returns', e.target.value)} />
          </Field>
          <Field label="Payment">
            <Textarea rows={3} value={p.policies.payment ?? ''} onChange={(e) => setPolicy('payment', e.target.value)} />
          </Field>
          <Field label="Other policies">
            <Textarea rows={3} value={p.policies.other ?? ''} onChange={(e) => setPolicy('other', e.target.value)} />
          </Field>
          <Field label="Anything else the assistant should know" hint="Free-form notes: parking, warranty, sizes, ingredients, team members…">
            <Textarea rows={5} maxLength={20000} value={p.extraInfo ?? ''} onChange={(e) => setProfile({ extraInfo: e.target.value })} />
          </Field>
        </Card>
      </fieldset>
      <SaveBar
        dirty={dirty}
        saving={save.isPending}
        readOnly={!canEdit}
        onReset={reset}
        onSave={() => save.mutate({ ...draft, name: draft.name.trim() || w.name })}
      />
    </>
  );
}

// ---------------------------------------------------------------------------
// Team
// ---------------------------------------------------------------------------

interface Member {
  id: string;
  role: Role;
  emailAlerts: boolean;
  userId: string;
  name: string;
  email: string;
  joinedAt: string;
}
interface Invite {
  id: string;
  email: string;
  role: Role;
  expiresAt: string;
  createdAt: string;
}

const ROLE_LABEL: Record<Role, string> = { owner: 'Owner', admin: 'Admin', agent: 'Agent' };
const ROLE_HINT: Record<Role, string> = {
  owner: 'Everything, including billing and deleting the business',
  admin: 'Everything except billing and deleting the business',
  agent: 'Inbox, contacts, orders and bookings',
};

function Team({ detail }: { detail: WorkspaceDetail }) {
  const api = useWsApi();
  const wid = useWid();
  const qc = useQueryClient();
  const toast = useToast();
  const { user } = useAuth();
  const key = ['ws', wid, 'team'];
  const team = useQuery({ queryKey: key, queryFn: () => api.get<{ members: Member[]; invites: Invite[]; plan: Plan }>('/team') });
  const [email, setEmail] = useState('');
  const [role, setRole] = useState<'admin' | 'agent'>('agent');
  const [link, setLink] = useState<string | null>(null);
  const canManage = detail.role === 'owner' || detail.role === 'admin';
  const isOwner = detail.role === 'owner';

  const onError = (err: unknown) => toast.error(errorMessage(err));
  const refresh = () => qc.invalidateQueries({ queryKey: key });

  const invite = useMutation({
    mutationFn: () => api.post<{ link: string }>('/team/invite', { email, role }),
    onSuccess: (res) => {
      setEmail('');
      setLink(res.link);
      refresh();
      toast.success('Invitation sent');
    },
    onError,
  });
  const revoke = useMutation({ mutationFn: (id: string) => api.del(`/team/invites/${id}`), onSuccess: refresh, onError });
  const changeRole = useMutation({ mutationFn: ({ id, role }: { id: string; role: Role }) => api.patch(`/team/${id}`, { role }), onSuccess: refresh, onError });
  const remove = useMutation({ mutationFn: (id: string) => api.del(`/team/${id}`), onSuccess: refresh, onError });
  const alerts = useMutation({ mutationFn: (v: boolean) => api.patch('/team/me', { emailAlerts: v }), onSuccess: refresh, onError });

  if (team.isLoading) return <PageLoader />;
  if (!team.data) return <ErrorState error={team.error} retry={() => team.refetch()} />;
  const { members, invites, plan } = team.data;
  const mine = members.find((m) => m.userId === user?.id);
  const seatsUsed = members.length;

  return (
    <div className="space-y-6">
      {mine && (
        <Card>
          <Toggle
            checked={mine.emailAlerts}
            onChange={(v) => alerts.mutate(v)}
            disabled={alerts.isPending}
            label="Email me reports and alerts for this business"
            description={mine.role === 'agent' ? 'Reports and alerts go to owners and admins.' : 'Daily/weekly reports, new orders, bookings and hand-offs.'}
          />
        </Card>
      )}

      <Card title="Team members" description={`${seatsUsed} of ${plan.seats} seats used on the ${plan.name} plan.`} bodyClassName="p-0">
        <ul className="divide-y divide-zinc-100">
          {members.map((m) => (
            <li key={m.id} className="flex flex-wrap items-center gap-3 px-5 py-3">
              <Avatar name={m.name} />
              <div className="min-w-0 flex-1">
                <div className="truncate text-sm font-medium text-zinc-900">
                  {m.name} {m.userId === user?.id && <span className="font-normal text-zinc-500">(you)</span>}
                </div>
                <div className="truncate text-xs text-zinc-500">{m.email}</div>
              </div>
              {isOwner ? (
                <Select className="h-9 w-32" value={m.role} onChange={(e) => changeRole.mutate({ id: m.id, role: e.target.value as Role })}>
                  {(['owner', 'admin', 'agent'] as Role[]).map((r) => (
                    <option key={r} value={r}>
                      {ROLE_LABEL[r]}
                    </option>
                  ))}
                </Select>
              ) : (
                <Badge tone={m.role === 'owner' ? 'brand' : 'zinc'}>{ROLE_LABEL[m.role]}</Badge>
              )}
              {canManage && m.role !== 'owner' && m.userId !== user?.id && (
                <IconButton
                  label="Remove from team"
                  onClick={() => window.confirm(`Remove ${m.name} from ${detail.workspace.name}?`) && remove.mutate(m.id)}
                >
                  <Trash2 className="size-4" />
                </IconButton>
              )}
            </li>
          ))}
          {invites.map((i) => (
            <li key={i.id} className="flex flex-wrap items-center gap-3 px-5 py-3">
              <Avatar name={i.email} />
              <div className="min-w-0 flex-1">
                <div className="truncate text-sm text-zinc-700">{i.email}</div>
                <div className="text-xs text-zinc-500">Invited · expires {formatDate(i.expiresAt)}</div>
              </div>
              <Badge tone="amber">Pending · {ROLE_LABEL[i.role]}</Badge>
              {canManage && (
                <IconButton label="Cancel invitation" onClick={() => revoke.mutate(i.id)}>
                  <Trash2 className="size-4" />
                </IconButton>
              )}
            </li>
          ))}
        </ul>
      </Card>

      {canManage && (
        <Card title="Invite someone" description="They'll get an email with a link to join. No password sharing needed.">
          <form
            className="flex flex-wrap items-end gap-3"
            onSubmit={(e) => {
              e.preventDefault();
              if (email.trim()) invite.mutate();
            }}
          >
            <Field label="Email" className="min-w-56 flex-1">
              <Input type="email" required value={email} onChange={(e) => setEmail(e.target.value)} placeholder="teammate@example.com" />
            </Field>
            <Field label="Role" className="w-40">
              <Select value={role} onChange={(e) => setRole(e.target.value as 'admin' | 'agent')}>
                <option value="agent">Agent</option>
                <option value="admin">Admin</option>
              </Select>
            </Field>
            <Button type="submit" icon={<UserPlus className="size-4" />} loading={invite.isPending} disabled={seatsUsed >= plan.seats}>
              Send invite
            </Button>
          </form>
          <p className="mt-2 text-xs text-zinc-500">{ROLE_HINT[role]}.</p>
          {seatsUsed >= plan.seats && <p className="mt-2 text-xs text-amber-700">All seats are in use. Upgrade your plan to add more people.</p>}
          {link && <CopyLink link={link} />}
        </Card>
      )}
    </div>
  );
}

function CopyLink({ link }: { link: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="mt-4 rounded-lg bg-zinc-50 p-3 text-sm">
      <p className="mb-2 text-zinc-600">If the email doesn't arrive, send them this link directly (valid for 7 days):</p>
      <div className="flex items-center gap-2">
        <Input readOnly value={link} onFocus={(e) => e.target.select()} />
        <IconButton
          label="Copy link"
          onClick={() => {
            navigator.clipboard.writeText(link).then(() => {
              setCopied(true);
              setTimeout(() => setCopied(false), 1500);
            });
          }}
        >
          {copied ? <Check className="size-4 text-emerald-600" /> : <Copy className="size-4" />}
        </IconButton>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Plan & usage
// ---------------------------------------------------------------------------

function Billing({ detail }: { detail: WorkspaceDetail }) {
  const api = useWsApi();
  const wid = useWid();
  const toast = useToast();
  const billing = useQuery({
    queryKey: ['ws', wid, 'billing'],
    queryFn: () => api.get<{ plan: Plan; plans: Plan[]; usage: Usage; trialEndsAt: string | null; status: string }>('/billing'),
  });
  const [requesting, setRequesting] = useState<Plan | null>(null);
  const [note, setNote] = useState('');
  const request = useMutation({
    mutationFn: () => api.post('/billing/request', { planId: requesting!.id, note: note.trim() || undefined }),
    onSuccess: () => {
      toast.success("Request sent. We'll get in touch to set up your plan.");
      setRequesting(null);
      setNote('');
    },
    onError: (err) => toast.error(errorMessage(err)),
  });

  if (billing.isLoading) return <PageLoader />;
  if (!billing.data) return <ErrorState error={billing.error} retry={() => billing.refetch()} />;
  const { plan, plans, usage, trialEndsAt, status } = billing.data;
  const used = usage.aiReplies;
  const pct = Math.min(100, Math.round((used / Math.max(1, plan.aiRepliesPerMonth)) * 100));
  const trialDaysLeft = trialEndsAt ? Math.ceil((new Date(trialEndsAt).getTime() - Date.now()) / 86_400_000) : null;

  return (
    <div className="space-y-6">
      {status === 'suspended' && <Banner tone="red">This business is suspended, so the assistant is not replying. Contact support to reactivate it.</Banner>}
      {plan.id === 'trial' && trialDaysLeft !== null && (
        <Banner tone={trialDaysLeft <= 3 ? 'amber' : 'brand'}>
          {trialDaysLeft > 0 ? `Your free trial ends in ${trialDaysLeft} day${trialDaysLeft === 1 ? '' : 's'} (${formatDate(trialEndsAt!)}).` : 'Your free trial has ended. Choose a plan to keep the assistant replying.'}
        </Banner>
      )}

      <Card title={`${plan.name} plan`} description={`Usage for ${usage.month}`}>
        <div className="flex items-baseline justify-between text-sm">
          <span className="text-zinc-600">AI replies this month</span>
          <span className="font-medium text-zinc-900 tabular-nums">
            {formatNumber(used)} / {formatNumber(plan.aiRepliesPerMonth)}
          </span>
        </div>
        <div className="mt-2 h-2 overflow-hidden rounded-full bg-zinc-100" role="progressbar" aria-valuenow={pct} aria-valuemin={0} aria-valuemax={100}>
          <div className={cx('h-full rounded-full', pct >= 90 ? 'bg-[#d03b3b]' : 'bg-brand-600')} style={{ width: `${pct}%` }} />
        </div>
        {pct >= 100 && <p className="mt-2 text-sm text-red-700">You've used all AI replies for this month. New messages wait in your inbox for your team.</p>}
        <dl className="mt-5 grid grid-cols-2 gap-3 text-sm sm:grid-cols-3">
          <div className="rounded-lg bg-zinc-50 p-3">
            <dt className="text-xs text-zinc-500">Channels included</dt>
            <dd className="mt-0.5 font-semibold text-zinc-900">
              {detail.counts.channels} / {plan.channels}
            </dd>
          </div>
          <div className="rounded-lg bg-zinc-50 p-3">
            <dt className="text-xs text-zinc-500">Team seats</dt>
            <dd className="mt-0.5 font-semibold text-zinc-900">{plan.seats}</dd>
          </div>
          <div className="rounded-lg bg-zinc-50 p-3">
            <dt className="text-xs text-zinc-500">Voice minutes transcribed</dt>
            <dd className="mt-0.5 font-semibold text-zinc-900">{formatNumber(Math.round(usage.transcribedSeconds / 60))}</dd>
          </div>
        </dl>
      </Card>

      <div>
        <h2 className="mb-3 text-base font-semibold text-zinc-900">Plans</h2>
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {plans
            .filter((p) => p.id !== 'trial')
            .map((p) => {
              const current = p.id === plan.id;
              return (
                <div key={p.id} className={cx('flex flex-col rounded-xl border bg-white p-5 shadow-xs', current ? 'border-brand-600 ring-1 ring-brand-600' : 'border-zinc-200')}>
                  <div className="flex items-center justify-between">
                    <h3 className="font-semibold text-zinc-900">{p.name}</h3>
                    {current && <Badge tone="brand">Current</Badge>}
                  </div>
                  <div className="mt-2 text-2xl font-semibold text-zinc-900">
                    ${p.priceMonthly}
                    <span className="text-sm font-normal text-zinc-500"> / month</span>
                  </div>
                  <ul className="mt-3 flex-1 space-y-1.5 text-sm text-zinc-600">
                    {p.highlights.map((h) => (
                      <li key={h} className="flex gap-2">
                        <Check className="mt-0.5 size-4 shrink-0 text-brand-700" /> {h}
                      </li>
                    ))}
                  </ul>
                  {!current && detail.role === 'owner' && (
                    <Button variant="secondary" className="mt-4" onClick={() => setRequesting(p)}>
                      Choose {p.name}
                    </Button>
                  )}
                </div>
              );
            })}
        </div>
        {detail.role !== 'owner' && <p className="mt-3 text-xs text-zinc-500">Only the business owner can change the plan.</p>}
      </div>

      <Modal
        open={Boolean(requesting)}
        onClose={() => setRequesting(null)}
        title={`Switch to ${requesting?.name ?? ''}`}
        description="We'll contact you to confirm and set up payment. Your assistant keeps working in the meantime."
        footer={
          <>
            <Button variant="ghost" onClick={() => setRequesting(null)}>
              Cancel
            </Button>
            <Button loading={request.isPending} onClick={() => request.mutate()}>
              Send request
            </Button>
          </>
        }
      >
        <Field label="Anything we should know? (optional)">
          <Textarea rows={3} maxLength={1000} value={note} onChange={(e) => setNote(e.target.value)} placeholder="Preferred payment method, billing contact…" />
        </Field>
      </Modal>
    </div>
  );
}

// ---------------------------------------------------------------------------
// My account
// ---------------------------------------------------------------------------

function Account() {
  const { user, setSession, logout } = useAuth();
  const toast = useToast();
  const navigate = useNavigate();
  const [name, setName] = useState(user?.name ?? '');
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');

  const saveName = useMutation({
    mutationFn: () => rawApi('/api/auth/me', { method: 'PATCH', body: { name: name.trim() } }),
    onSuccess: (res) => {
      setSession({ user: res.user });
      toast.success('Name updated');
    },
    onError: (err) => toast.error(errorMessage(err)),
  });
  const changePassword = useMutation({
    mutationFn: () => rawApi('/api/auth/me', { method: 'PATCH', body: { currentPassword: current, newPassword: next } }),
    onSuccess: () => {
      setCurrent('');
      setNext('');
      toast.success('Password changed. Other devices were signed out.');
    },
    onError: (err) => toast.error(errorMessage(err)),
  });

  return (
    <div className="space-y-6">
      <Card title="Profile">
        <form
          className="flex flex-wrap items-end gap-3"
          onSubmit={(e) => {
            e.preventDefault();
            if (name.trim()) saveName.mutate();
          }}
        >
          <Field label="Your name" className="min-w-56 flex-1">
            <Input value={name} onChange={(e) => setName(e.target.value)} maxLength={100} />
          </Field>
          <Field label="Email" className="min-w-56 flex-1">
            <Input value={user?.email ?? ''} disabled />
          </Field>
          <Button type="submit" variant="secondary" loading={saveName.isPending} disabled={!name.trim() || name.trim() === user?.name}>
            Save
          </Button>
        </form>
      </Card>

      <Card title="Password">
        <form
          className="grid gap-4 sm:max-w-sm"
          onSubmit={(e) => {
            e.preventDefault();
            changePassword.mutate();
          }}
        >
          <Field label="Current password">
            <Input type="password" autoComplete="current-password" required value={current} onChange={(e) => setCurrent(e.target.value)} />
          </Field>
          <Field label="New password" hint="At least 8 characters.">
            <Input type="password" autoComplete="new-password" required minLength={8} value={next} onChange={(e) => setNext(e.target.value)} />
          </Field>
          <div>
            <Button type="submit" variant="secondary" loading={changePassword.isPending}>
              Change password
            </Button>
          </div>
        </form>
      </Card>

      <Card title="Sign out">
        <Button
          variant="secondary"
          onClick={async () => {
            await logout();
            navigate('/login');
          }}
        >
          Sign out of this device
        </Button>
      </Card>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Delete business
// ---------------------------------------------------------------------------

function DangerZone({ detail }: { detail: WorkspaceDetail }) {
  const api = useWsApi();
  const toast = useToast();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const { refresh } = useAuth();
  const [confirm, setConfirm] = useState('');
  const name = detail.workspace.name;
  const del = useMutation({
    mutationFn: () => api.del('/', { confirmName: confirm }),
    onSuccess: async () => {
      qc.clear();
      await refresh();
      toast.success(`${name} was deleted`);
      navigate('/', { replace: true });
    },
    onError: (err) => toast.error(errorMessage(err)),
  });

  return (
    <Card title="Delete this business" className="border-red-200">
      <p className="text-sm text-zinc-600">
        This permanently deletes <strong>{name}</strong>: all conversations, contacts, orders, bookings, products, reports and connected channels. Your
        Facebook, Instagram and WhatsApp accounts themselves are not affected. This cannot be undone.
      </p>
      <Field label={<>Type <strong>{name}</strong> to confirm</>} className="mt-4 max-w-sm">
        <Input value={confirm} onChange={(e) => setConfirm(e.target.value)} />
      </Field>
      <Button variant="danger" className="mt-4" disabled={confirm.trim() !== name} loading={del.isPending} onClick={() => del.mutate()}>
        Delete business permanently
      </Button>
    </Card>
  );
}
