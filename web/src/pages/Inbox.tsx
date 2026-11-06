import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowLeft, Bot, CheckCircle2, Hand, ImagePlus, MessagesSquare, Pause, Play, Search, SendHorizontal, UserRound, X } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { Link, useSearchParams } from 'react-router';
import { ChannelIcon } from '../components/ChannelIcon';
import { MessageBubble } from '../components/MessageBubble';
import { Avatar, Badge, Button, Checkbox, cx, EmptyState, Field, IconButton, Input, Select, Spinner, Textarea } from '../components/ui';
import { errorMessage } from '../lib/api';
import {
  BOOKING_STATUS_META,
  CHANNEL_META,
  formatDateTime,
  formatMoney,
  formatTime,
  ORDER_STATUS_META,
  STAGE_META,
  timeAgo,
} from '../lib/format';
import { useToast } from '../lib/toast';
import type { Booking, Channel, ChannelType, Contact, Conversation, ConversationListItem, LeadStage, Message, Order } from '../lib/types';
import { useWid, useWorkspace, useWsApi } from '../lib/workspace';

type Filter = 'all' | 'needs_human' | 'unread' | 'ai_paused';

interface Detail {
  conversation: Conversation;
  contact: Contact;
  channel: Channel;
  messages: Message[];
  orders: Order[];
  bookings: Booking[];
  ai: { blocker: string | null };
  canReply: { ok: boolean; reason?: string };
}

export default function Inbox() {
  const api = useWsApi();
  const wid = useWid();
  const [params, setParams] = useSearchParams();
  const selected = params.get('c');
  const [filter, setFilter] = useState<Filter>('all');
  const [q, setQ] = useState('');
  const [channel, setChannel] = useState<ChannelType | ''>('');
  const query = new URLSearchParams({ filter, ...(q ? { q } : {}), ...(channel ? { channel } : {}) }).toString();
  const list = useQuery({
    queryKey: ['ws', wid, 'conversations', query],
    queryFn: () => api.get<{ conversations: ConversationListItem[] }>(`/conversations?${query}`),
    refetchInterval: 5000,
  });
  const select = (id: string | null) => setParams(id ? { c: id } : {}, { replace: true });
  const conversations = list.data?.conversations ?? [];

  return (
    <div className="flex h-full min-h-0">
      {/* Conversation list */}
      <div className={cx('flex w-full min-h-0 flex-col border-r border-zinc-200 bg-white md:w-80 lg:w-96', selected && 'hidden md:flex')}>
        <div className="space-y-3 border-b border-zinc-100 p-3">
          <div className="relative">
            <Search className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-zinc-400" />
            <Input className="pl-9" placeholder="Search name, phone or message" value={q} onChange={(e) => setQ(e.target.value)} />
          </div>
          <div className="flex items-center gap-2">
            <div className="flex flex-1 gap-1 overflow-x-auto">
              {(
                [
                  ['all', 'All'],
                  ['needs_human', 'Needs you'],
                  ['unread', 'Unread'],
                  ['ai_paused', 'AI paused'],
                ] as [Filter, string][]
              ).map(([id, label]) => (
                <button
                  key={id}
                  onClick={() => setFilter(id)}
                  className={cx('rounded-full px-2.5 py-1 text-xs font-medium whitespace-nowrap', filter === id ? 'bg-zinc-900 text-white' : 'bg-zinc-100 text-zinc-600 hover:bg-zinc-200')}
                >
                  {label}
                </button>
              ))}
            </div>
            <select
              aria-label="Channel"
              value={channel}
              onChange={(e) => setChannel(e.target.value as ChannelType | '')}
              className="h-7 rounded-md border border-zinc-200 bg-white px-1.5 text-xs text-zinc-600"
            >
              <option value="">All channels</option>
              {(['messenger', 'instagram', 'whatsapp', 'manychat', 'telegram', 'webchat'] as ChannelType[]).map((c) => (
                <option key={c} value={c}>
                  {CHANNEL_META[c].label}
                </option>
              ))}
            </select>
          </div>
        </div>
        <div className="scroll-thin min-h-0 flex-1 overflow-y-auto">
          {list.isLoading && (
            <div className="flex justify-center p-8">
              <Spinner />
            </div>
          )}
          {!list.isLoading && conversations.length === 0 && (
            <EmptyState
              icon={<MessagesSquare className="size-6" />}
              title={filter === 'all' && !q ? 'No conversations yet' : 'Nothing here'}
              description={filter === 'all' && !q ? 'When customers message your connected channels, conversations appear here.' : 'Try another filter.'}
              action={
                filter === 'all' && !q ? (
                  <Link to={`/w/${wid}/channels`}>
                    <Button variant="secondary">Connect a channel</Button>
                  </Link>
                ) : undefined
              }
            />
          )}
          {conversations.map((c) => (
            <button
              key={c.id}
              onClick={() => select(c.id)}
              className={cx('flex w-full gap-3 border-b border-zinc-50 px-3 py-3 text-left hover:bg-zinc-50', selected === c.id && 'bg-brand-50/60 hover:bg-brand-50')}
            >
              <div className="relative">
                <Avatar name={c.contact.name ?? c.contact.username ?? c.contact.phone} src={c.contact.avatarUrl} size={40} />
                <ChannelIcon type={c.channel.type} size={16} className="absolute -right-1 -bottom-1 ring-2 ring-white" />
              </div>
              <div className="min-w-0 flex-1">
                <div className="flex items-center justify-between gap-2">
                  <span className={cx('truncate text-sm', c.unreadCount > 0 ? 'font-semibold text-zinc-900' : 'font-medium text-zinc-800')}>
                    {c.contact.name ?? c.contact.username ?? c.contact.phone ?? 'Customer'}
                  </span>
                  <span className="shrink-0 text-xs text-zinc-400">{timeAgo(c.lastMessageAt)}</span>
                </div>
                <div className="mt-0.5 flex items-center gap-2">
                  <span className={cx('flex-1 truncate text-sm', c.unreadCount > 0 ? 'text-zinc-700' : 'text-zinc-500')}>{c.lastMessagePreview}</span>
                  {c.unreadCount > 0 && <span className="size-2 shrink-0 rounded-full bg-brand-600" />}
                </div>
                <div className="mt-1 flex flex-wrap gap-1">
                  {c.needsHuman && (
                    <Badge tone="red">
                      <Hand className="size-3" /> Needs you
                    </Badge>
                  )}
                  {c.aiPaused && !c.needsHuman && <Badge tone="amber">AI paused</Badge>}
                  {c.contact.stage !== 'new' && <Badge tone={STAGE_META[c.contact.stage].tone}>{STAGE_META[c.contact.stage].label}</Badge>}
                </div>
              </div>
            </button>
          ))}
        </div>
      </div>

      {/* Thread */}
      {selected ? (
        <Thread key={selected} id={selected} onBack={() => select(null)} />
      ) : (
        <div className="hidden flex-1 items-center justify-center bg-zinc-50 md:flex">
          <EmptyState icon={<MessagesSquare className="size-6" />} title="Select a conversation" description="Your assistant is replying automatically. Jump in any time." />
        </div>
      )}
    </div>
  );
}

function Thread({ id, onBack }: { id: string; onBack: () => void }) {
  const api = useWsApi();
  const wid = useWid();
  const qc = useQueryClient();
  const toast = useToast();
  const ws = useWorkspace().data?.workspace;
  const [text, setText] = useState('');
  const [keepAi, setKeepAi] = useState(false);
  const [file, setFile] = useState<File | null>(null);
  const [showDetails, setShowDetails] = useState(false);
  const listRef = useRef<HTMLDivElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const key = ['ws', wid, 'conversation', id];
  const { data, isLoading, error } = useQuery({ queryKey: key, queryFn: () => api.get<Detail>(`/conversations/${id}`), refetchInterval: 3000 });
  const team = useQuery({ queryKey: ['ws', wid, 'team'], queryFn: () => api.get<{ members: { userId: string; name: string }[] }>('/team'), staleTime: 300_000 });
  const names = useMemo(() => new Map((team.data?.members ?? []).map((m) => [m.userId, m.name])), [team.data]);

  const refresh = () => {
    qc.invalidateQueries({ queryKey: key });
    qc.invalidateQueries({ queryKey: ['ws', wid, 'conversations'] });
    qc.invalidateQueries({ queryKey: ['ws', wid, 'badge'] });
  };

  useEffect(() => {
    if (data && data.conversation.unreadCount > 0) api.post(`/conversations/${id}/read`).then(refresh).catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data?.conversation.unreadCount, id]);

  const lastId = data?.messages.at(-1)?.id;
  useEffect(() => {
    listRef.current?.scrollTo({ top: listRef.current.scrollHeight });
  }, [lastId]);

  const send = useMutation({
    mutationFn: async () => {
      const form = new FormData();
      if (text.trim()) form.append('text', text.trim());
      if (file) form.append('file', file);
      form.append('keepAi', String(keepAi));
      return api.upload(`/conversations/${id}/messages`, form);
    },
    onSuccess: () => {
      setText('');
      setFile(null);
      refresh();
    },
    onError: (err) => {
      toast.error(errorMessage(err));
      refresh();
    },
  });

  const setAi = useMutation({
    mutationFn: (paused: boolean) => api.post(`/conversations/${id}/ai`, { paused }),
    onSuccess: (_d, paused) => {
      toast.success(paused ? 'AI paused for this conversation' : 'AI resumed');
      refresh();
    },
  });

  const resolve = useMutation({
    mutationFn: () => api.patch(`/conversations/${id}`, { needsHuman: false }),
    onSuccess: refresh,
  });

  if (isLoading) {
    return (
      <div className="flex flex-1 items-center justify-center">
        <Spinner />
      </div>
    );
  }
  if (error || !data) {
    return (
      <div className="flex flex-1 items-center justify-center p-6 text-sm text-red-700">
        {errorMessage(error)}
      </div>
    );
  }
  const { conversation: conv, contact } = data;
  const displayName = contact.name ?? contact.username ?? contact.phone ?? 'Customer';
  const pausedUntil = conv.aiPausedUntil ? new Date(conv.aiPausedUntil) : null;

  return (
    <div className="flex min-h-0 min-w-0 flex-1">
      <div className="flex min-h-0 min-w-0 flex-1 flex-col bg-zinc-50">
        <header className="flex items-center gap-3 border-b border-zinc-200 bg-white px-3 py-2.5">
          <IconButton label="Back" className="md:hidden" onClick={onBack}>
            <ArrowLeft className="size-5" />
          </IconButton>
          <Avatar name={displayName} src={contact.avatarUrl} size={36} />
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2">
              <span className="truncate font-semibold text-zinc-900">{displayName}</span>
              <Badge tone={STAGE_META[contact.stage].tone}>{STAGE_META[contact.stage].label}</Badge>
            </div>
            <div className="flex items-center gap-1.5 text-xs text-zinc-500">
              <ChannelIcon type={data.channel.type} size={14} /> {data.channel.name}
              {contact.phone && <span>· {contact.phone}</span>}
            </div>
          </div>
          {conv.aiPaused ? (
            <Button size="sm" variant="subtle" icon={<Play className="size-4" />} onClick={() => setAi.mutate(false)} loading={setAi.isPending}>
              Resume AI
            </Button>
          ) : (
            <Button size="sm" variant="secondary" icon={<Pause className="size-4" />} onClick={() => setAi.mutate(true)} loading={setAi.isPending}>
              Pause AI
            </Button>
          )}
          <IconButton label="Customer details" className="xl:hidden" onClick={() => setShowDetails(true)}>
            <UserRound className="size-5" />
          </IconButton>
        </header>

        {(conv.needsHuman || conv.aiPaused || data.ai.blocker) && (
          <div className="space-y-2 border-b border-zinc-200 bg-white px-4 py-2">
            {conv.needsHuman && (
              <div className="flex flex-wrap items-center gap-2 rounded-lg bg-red-50 px-3 py-2 text-sm text-red-800">
                <Hand className="size-4" />
                <span className="flex-1">
                  <strong>Needs a team member</strong>
                  {conv.handoffReason ? `: ${conv.handoffReason}` : ''}
                </span>
                <Button size="sm" variant="ghost" icon={<CheckCircle2 className="size-4" />} onClick={() => resolve.mutate()}>
                  Mark handled
                </Button>
              </div>
            )}
            {conv.aiPaused && !conv.needsHuman && (
              <div className="flex items-center gap-2 rounded-lg bg-amber-50 px-3 py-2 text-sm text-amber-900">
                <Pause className="size-4" /> AI is paused here{pausedUntil ? ` until ${formatTime(pausedUntil)}` : ''}. You're in control.
              </div>
            )}
            {data.ai.blocker && !conv.aiPaused && (
              <div className="flex items-center gap-2 rounded-lg bg-zinc-100 px-3 py-2 text-sm text-zinc-700">
                <Bot className="size-4" /> AI won't reply: {data.ai.blocker}
              </div>
            )}
          </div>
        )}

        <div ref={listRef} className="scroll-thin min-h-0 flex-1 space-y-3 overflow-y-auto p-4">
          {conv.summary && (
            <div className="rounded-lg border border-dashed border-zinc-300 bg-white px-3 py-2 text-xs text-zinc-600">
              <strong>Earlier in this conversation:</strong> {conv.summary}
            </div>
          )}
          {data.messages.map((m) => (
            <MessageBubble key={m.id} message={m} senderName={m.senderUserId ? names.get(m.senderUserId) : undefined} />
          ))}
        </div>

        <div className="border-t border-zinc-200 bg-white p-3">
          {!data.canReply.ok ? (
            <p className="rounded-lg bg-zinc-100 p-3 text-sm text-zinc-600">{data.canReply.reason}</p>
          ) : (
            <>
              {file && (
                <div className="mb-2 flex items-center gap-2 text-sm text-zinc-600">
                  <ImagePlus className="size-4" /> {file.name}
                  <button onClick={() => setFile(null)} aria-label="Remove attachment" className="text-zinc-400 hover:text-zinc-700">
                    <X className="size-4" />
                  </button>
                </div>
              )}
              <div className="flex items-end gap-2">
                <input ref={fileRef} type="file" accept="image/*" hidden onChange={(e) => setFile(e.target.files?.[0] ?? null)} />
                <IconButton label="Attach a photo" onClick={() => fileRef.current?.click()}>
                  <ImagePlus className="size-5" />
                </IconButton>
                <textarea
                  rows={1}
                  value={text}
                  onChange={(e) => setText(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' && !e.shiftKey && (text.trim() || file)) {
                      e.preventDefault();
                      send.mutate();
                    }
                  }}
                  placeholder={`Reply to ${displayName}…`}
                  className="max-h-40 min-h-10 flex-1 resize-none rounded-xl border border-zinc-300 px-3 py-2 text-sm focus:border-brand-600 focus:ring-2 focus:ring-brand-600/20 focus:outline-none"
                />
                <Button onClick={() => send.mutate()} disabled={!text.trim() && !file} loading={send.isPending} icon={<SendHorizontal className="size-4" />}>
                  Send
                </Button>
              </div>
              <div className="mt-2 flex items-center justify-between gap-2 text-xs text-zinc-500">
                <Checkbox checked={keepAi} onChange={setKeepAi} label={<span className="text-xs">Keep AI replying after my message</span>} />
                {!keepAi && <span className="hidden sm:inline">AI pauses for {ws?.ai.pauseAfterHumanMinutes ?? 60} min when you reply</span>}
              </div>
            </>
          )}
        </div>
      </div>

      <aside className="scroll-thin hidden w-80 shrink-0 overflow-y-auto border-l border-zinc-200 bg-white xl:block">
        <ContactPanel data={data} onSaved={refresh} />
      </aside>
      {showDetails && (
        <div className="fixed inset-0 z-40 flex justify-end bg-zinc-950/30 xl:hidden" onClick={() => setShowDetails(false)}>
          <aside className="scroll-thin h-full w-80 max-w-[90vw] overflow-y-auto bg-white" onClick={(e) => e.stopPropagation()}>
            <div className="flex justify-end p-2">
              <IconButton label="Close" onClick={() => setShowDetails(false)}>
                <X className="size-5" />
              </IconButton>
            </div>
            <ContactPanel data={data} onSaved={refresh} />
          </aside>
        </div>
      )}
    </div>
  );
}

function ContactPanel({ data, onSaved }: { data: Detail; onSaved: () => void }) {
  const api = useWsApi();
  const toast = useToast();
  const ws = useWorkspace().data?.workspace;
  const c = data.contact;
  const [form, setForm] = useState({ name: c.name ?? '', phone: c.phone ?? '', email: c.email ?? '', address: c.address ?? '', notes: c.notes ?? '', stage: c.stage });
  useEffect(() => {
    setForm({ name: c.name ?? '', phone: c.phone ?? '', email: c.email ?? '', address: c.address ?? '', notes: c.notes ?? '', stage: c.stage });
  }, [c.id, c.updatedAt]); // eslint-disable-line react-hooks/exhaustive-deps
  const dirty = form.name !== (c.name ?? '') || form.phone !== (c.phone ?? '') || form.email !== (c.email ?? '') || form.address !== (c.address ?? '') || form.notes !== (c.notes ?? '') || form.stage !== c.stage;
  const save = useMutation({
    mutationFn: () =>
      api.patch(`/contacts/${c.id}`, {
        name: form.name || null,
        phone: form.phone || null,
        email: form.email || null,
        address: form.address || null,
        notes: form.notes || null,
        stage: form.stage,
      }),
    onSuccess: () => {
      toast.success('Saved');
      onSaved();
    },
    onError: (err) => toast.error(errorMessage(err)),
  });
  const lead = c.lead ?? {};
  return (
    <div className="space-y-5 p-4">
      <div className="text-center">
        <Avatar name={c.name ?? c.username ?? c.phone} src={c.avatarUrl} size={56} className="mx-auto" />
        <div className="mt-2 font-semibold">{c.name ?? c.username ?? 'Customer'}</div>
        {c.username && <div className="text-xs text-zinc-500">@{c.username}</div>}
        <div className="mt-1 text-xs text-zinc-500">Lead score {c.score}/100</div>
      </div>

      {(lead.intent || lead.budget || lead.timeline || (lead.answers && Object.keys(lead.answers).length > 0)) && (
        <div className="rounded-lg bg-brand-50/60 p-3 text-sm">
          <div className="mb-1 text-xs font-semibold tracking-wide text-brand-900 uppercase">What the AI learned</div>
          {lead.intent && <p><span className="text-zinc-500">Wants:</span> {lead.intent}</p>}
          {lead.budget && <p><span className="text-zinc-500">Budget:</span> {lead.budget}</p>}
          {lead.timeline && <p><span className="text-zinc-500">Timeline:</span> {lead.timeline}</p>}
          {Object.entries(lead.answers ?? {}).map(([q, a]) => (
            <p key={q}>
              <span className="text-zinc-500">{q}</span> {a}
            </p>
          ))}
          {lead.lostReason && <p><span className="text-zinc-500">Lost because:</span> {lead.lostReason}</p>}
        </div>
      )}

      <div className="space-y-3">
        <Field label="Stage">
          <Select value={form.stage} onChange={(e) => setForm({ ...form, stage: e.target.value as LeadStage })}>
            {Object.entries(STAGE_META).map(([id, m]) => (
              <option key={id} value={id}>
                {m.label}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Name">
          <Input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
        </Field>
        <Field label="Phone">
          <Input value={form.phone} onChange={(e) => setForm({ ...form, phone: e.target.value })} />
        </Field>
        <Field label="Email">
          <Input value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} />
        </Field>
        <Field label="Address">
          <Textarea rows={2} value={form.address} onChange={(e) => setForm({ ...form, address: e.target.value })} />
        </Field>
        <Field label="Notes">
          <Textarea rows={3} value={form.notes} onChange={(e) => setForm({ ...form, notes: e.target.value })} />
        </Field>
        {dirty && (
          <Button size="sm" onClick={() => save.mutate()} loading={save.isPending} className="w-full">
            Save changes
          </Button>
        )}
      </div>

      {data.orders.length > 0 && (
        <div>
          <div className="mb-2 text-xs font-semibold tracking-wide text-zinc-500 uppercase">Orders</div>
          <div className="space-y-2">
            {data.orders.map((o) => (
              <Link key={o.id} to={`../orders?id=${o.id}`} relative="path" className="block rounded-lg border border-zinc-200 p-2.5 text-sm hover:bg-zinc-50">
                <div className="flex items-center justify-between">
                  <span className="font-medium">#{o.number}</span>
                  <Badge tone={ORDER_STATUS_META[o.status].tone}>{ORDER_STATUS_META[o.status].label}</Badge>
                </div>
                <div className="mt-1 text-xs text-zinc-500">
                  {formatMoney(o.total, o.currency)} · {formatDateTime(o.createdAt)}
                </div>
              </Link>
            ))}
          </div>
        </div>
      )}

      {data.bookings.length > 0 && (
        <div>
          <div className="mb-2 text-xs font-semibold tracking-wide text-zinc-500 uppercase">Bookings</div>
          <div className="space-y-2">
            {data.bookings.map((b) => (
              <div key={b.id} className="rounded-lg border border-zinc-200 p-2.5 text-sm">
                <div className="flex items-center justify-between">
                  <span className="font-medium">{b.serviceName}</span>
                  <Badge tone={BOOKING_STATUS_META[b.status].tone}>{BOOKING_STATUS_META[b.status].label}</Badge>
                </div>
                <div className="mt-1 text-xs text-zinc-500">
                  #{b.number} · {formatDateTime(b.startAt)}
                </div>
              </div>
            ))}
          </div>
        </div>
      )}
      {ws && c.tags.length > 0 && (
        <div className="flex flex-wrap gap-1">
          {c.tags.map((t) => (
            <Badge key={t}>{t}</Badge>
          ))}
        </div>
      )}
    </div>
  );
}
