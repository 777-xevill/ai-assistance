import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Download, MessagesSquare, Search, Users } from 'lucide-react';
import { useEffect, useState } from 'react';
import { Link, useSearchParams } from 'react-router';
import { ChannelIcon } from '../components/ChannelIcon';
import { PageContainer } from '../components/Layout';
import { Avatar, Badge, Button, Drawer, EmptyState, ErrorState, Field, Input, PageHeader, PageLoader, Select, Textarea } from '../components/ui';
import { errorMessage } from '../lib/api';
import { formatDateTime, formatMoney, ORDER_STATUS_META, STAGE_META, timeAgo } from '../lib/format';
import { useToast } from '../lib/toast';
import type { Booking, ChannelType, Contact, LeadStage, Order } from '../lib/types';
import { useWid, useWsApi } from '../lib/workspace';

type Row = Contact & { channelType: ChannelType; conversationId: string | null; lastMessageAt: string | null };

export default function Contacts() {
  const api = useWsApi();
  const wid = useWid();
  const [params, setParams] = useSearchParams();
  const [stage, setStage] = useState<LeadStage | ''>('');
  const [q, setQ] = useState('');
  const openId = params.get('id');
  const query = new URLSearchParams({ ...(stage ? { stage } : {}), ...(q ? { q } : {}) }).toString();
  const { data, isLoading, error, refetch } = useQuery({
    queryKey: ['ws', wid, 'contacts', query],
    queryFn: () => api.get<{ contacts: Row[]; stageCounts: Record<string, number> }>(`/contacts?${query}`),
  });

  const counts = data?.stageCounts ?? {};
  const total = Object.values(counts).reduce((a, b) => a + b, 0);

  return (
    <PageContainer wide>
      <PageHeader
        title="Leads & customers"
        description="Everyone who has messaged you. The assistant updates stages and details as conversations progress."
        actions={
          <a href={api.url('/contacts/export.csv')}>
            <Button variant="secondary" icon={<Download className="size-4" />}>
              Export CSV
            </Button>
          </a>
        }
      />
      <div className="mb-4 flex flex-wrap items-center gap-2">
        <button onClick={() => setStage('')} className={`rounded-full px-3 py-1 text-sm font-medium ${stage === '' ? 'bg-zinc-900 text-white' : 'bg-white text-zinc-600 ring-1 ring-zinc-200 hover:bg-zinc-50'}`}>
          All {total > 0 && <span className="opacity-70">{total}</span>}
        </button>
        {(Object.keys(STAGE_META) as LeadStage[]).map((s) => (
          <button
            key={s}
            onClick={() => setStage(s)}
            className={`rounded-full px-3 py-1 text-sm font-medium ${stage === s ? 'bg-zinc-900 text-white' : 'bg-white text-zinc-600 ring-1 ring-zinc-200 hover:bg-zinc-50'}`}
          >
            {STAGE_META[s].label} {counts[s] ? <span className="opacity-70">{counts[s]}</span> : null}
          </button>
        ))}
        <div className="relative ml-auto w-full sm:w-64">
          <Search className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-zinc-400" />
          <Input className="pl-9" placeholder="Search name, phone, email" value={q} onChange={(e) => setQ(e.target.value)} />
        </div>
      </div>

      {error ? (
        <ErrorState error={error} retry={() => refetch()} />
      ) : isLoading ? (
        <PageLoader />
      ) : (data?.contacts.length ?? 0) === 0 ? (
        <div className="rounded-xl border border-zinc-200 bg-white">
          <EmptyState icon={<Users className="size-6" />} title="No contacts yet" description="People who message your connected channels appear here automatically." />
        </div>
      ) : (
        <div className="overflow-x-auto rounded-xl border border-zinc-200 bg-white shadow-xs">
          <table className="w-full min-w-[720px] text-sm">
            <thead className="bg-zinc-50 text-left text-xs font-medium text-zinc-500">
              <tr>
                <th className="px-4 py-2.5">Name</th>
                <th className="px-4 py-2.5">Stage</th>
                <th className="px-4 py-2.5">Wants</th>
                <th className="px-4 py-2.5">Phone</th>
                <th className="px-4 py-2.5 text-right">Last message</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-zinc-100">
              {data!.contacts.map((c) => (
                <tr key={c.id} className="cursor-pointer hover:bg-zinc-50" onClick={() => setParams({ id: c.id })}>
                  <td className="px-4 py-3">
                    <div className="flex items-center gap-3">
                      <div className="relative">
                        <Avatar name={c.name ?? c.username} src={c.avatarUrl} size={32} />
                        <ChannelIcon type={c.channelType} size={14} className="absolute -right-1 -bottom-1 ring-2 ring-white" />
                      </div>
                      <div className="min-w-0">
                        <div className="truncate font-medium text-zinc-900">{c.name ?? c.username ?? 'Unknown'}</div>
                        {c.email && <div className="truncate text-xs text-zinc-500">{c.email}</div>}
                      </div>
                    </div>
                  </td>
                  <td className="px-4 py-3">
                    <Badge tone={STAGE_META[c.stage].tone}>{STAGE_META[c.stage].label}</Badge>
                    {c.score > 0 && <span className="ml-2 text-xs text-zinc-500 tabular-nums">{c.score}</span>}
                  </td>
                  <td className="max-w-xs truncate px-4 py-3 text-zinc-600">{c.lead?.intent ?? '—'}</td>
                  <td className="px-4 py-3 text-zinc-600 tabular-nums">{c.phone ?? '—'}</td>
                  <td className="px-4 py-3 text-right text-zinc-500">{c.lastMessageAt ? timeAgo(c.lastMessageAt) : '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {openId && <ContactDrawer id={openId} onClose={() => setParams({})} />}
    </PageContainer>
  );
}

function ContactDrawer({ id, onClose }: { id: string; onClose: () => void }) {
  const api = useWsApi();
  const wid = useWid();
  const qc = useQueryClient();
  const toast = useToast();
  const { data, isLoading } = useQuery({
    queryKey: ['ws', wid, 'contact', id],
    queryFn: () => api.get<{ contact: Contact; conversation: { id: string } | null; orders: Order[]; bookings: Booking[] }>(`/contacts/${id}`),
  });
  const [form, setForm] = useState<Partial<Contact>>({});
  useEffect(() => {
    if (data) setForm(data.contact);
  }, [data]);
  const save = useMutation({
    mutationFn: () =>
      api.patch(`/contacts/${id}`, {
        name: form.name || null,
        phone: form.phone || null,
        email: form.email || null,
        address: form.address || null,
        city: form.city || null,
        notes: form.notes || null,
        stage: form.stage,
        score: form.score,
      }),
    onSuccess: () => {
      toast.success('Contact saved');
      qc.invalidateQueries({ queryKey: ['ws', wid, 'contacts'] });
      qc.invalidateQueries({ queryKey: ['ws', wid, 'contact', id] });
    },
    onError: (err) => toast.error(errorMessage(err)),
  });

  return (
    <Drawer
      open
      onClose={onClose}
      title={data?.contact.name ?? 'Contact'}
      footer={
        <>
          {data?.conversation && (
            <Link to={`/w/${wid}/inbox?c=${data.conversation.id}`}>
              <Button variant="secondary" icon={<MessagesSquare className="size-4" />}>
                Open conversation
              </Button>
            </Link>
          )}
          <Button onClick={() => save.mutate()} loading={save.isPending}>
            Save
          </Button>
        </>
      }
    >
      {isLoading || !data ? (
        <PageLoader />
      ) : (
        <div className="space-y-5">
          {(data.contact.lead.intent || data.contact.lead.budget || data.contact.lead.timeline) && (
            <div className="rounded-lg bg-brand-50/60 p-3 text-sm">
              {data.contact.lead.intent && <p><span className="text-zinc-500">Wants:</span> {data.contact.lead.intent}</p>}
              {data.contact.lead.budget && <p><span className="text-zinc-500">Budget:</span> {data.contact.lead.budget}</p>}
              {data.contact.lead.timeline && <p><span className="text-zinc-500">Timeline:</span> {data.contact.lead.timeline}</p>}
              {Object.entries(data.contact.lead.answers ?? {}).map(([q, a]) => (
                <p key={q}>
                  <span className="text-zinc-500">{q}</span> {a}
                </p>
              ))}
            </div>
          )}
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Stage">
              <Select value={form.stage ?? 'new'} onChange={(e) => setForm({ ...form, stage: e.target.value as LeadStage })}>
                {Object.entries(STAGE_META).map(([s, m]) => (
                  <option key={s} value={s}>
                    {m.label}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="Lead score (0-100)">
              <Input type="number" min={0} max={100} value={form.score ?? 0} onChange={(e) => setForm({ ...form, score: Number(e.target.value) })} />
            </Field>
            <Field label="Name">
              <Input value={form.name ?? ''} onChange={(e) => setForm({ ...form, name: e.target.value })} />
            </Field>
            <Field label="Phone">
              <Input value={form.phone ?? ''} onChange={(e) => setForm({ ...form, phone: e.target.value })} />
            </Field>
            <Field label="Email">
              <Input value={form.email ?? ''} onChange={(e) => setForm({ ...form, email: e.target.value })} />
            </Field>
            <Field label="City">
              <Input value={form.city ?? ''} onChange={(e) => setForm({ ...form, city: e.target.value })} />
            </Field>
            <Field label="Address" className="sm:col-span-2">
              <Textarea rows={2} value={form.address ?? ''} onChange={(e) => setForm({ ...form, address: e.target.value })} />
            </Field>
            <Field label="Notes" className="sm:col-span-2">
              <Textarea rows={3} value={form.notes ?? ''} onChange={(e) => setForm({ ...form, notes: e.target.value })} />
            </Field>
          </div>
          {data.orders.length > 0 && (
            <div>
              <div className="mb-2 text-sm font-semibold">Orders</div>
              <ul className="space-y-2">
                {data.orders.map((o) => (
                  <li key={o.id}>
                    <Link to={`/w/${wid}/orders?id=${o.id}`} className="flex items-center justify-between rounded-lg border border-zinc-200 px-3 py-2 text-sm hover:bg-zinc-50">
                      <span>
                        #{o.number} · {formatMoney(o.total, o.currency)}
                      </span>
                      <Badge tone={ORDER_STATUS_META[o.status].tone}>{ORDER_STATUS_META[o.status].label}</Badge>
                    </Link>
                  </li>
                ))}
              </ul>
            </div>
          )}
          {data.bookings.length > 0 && (
            <div>
              <div className="mb-2 text-sm font-semibold">Bookings</div>
              <ul className="space-y-2">
                {data.bookings.map((b) => (
                  <li key={b.id} className="rounded-lg border border-zinc-200 px-3 py-2 text-sm">
                    {b.serviceName} · {formatDateTime(b.startAt)} <span className="text-zinc-500">({b.status})</span>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>
      )}
    </Drawer>
  );
}
