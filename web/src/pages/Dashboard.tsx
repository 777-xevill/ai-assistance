import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { AlertTriangle, ArrowRight, BookOpen, CalendarCheck, CheckCircle2, Circle, Hand, MessageCircle, Repeat, ShoppingBag, TrendingUp } from 'lucide-react';
import { useState, type ReactNode } from 'react';
import { Link } from 'react-router';
import { ChannelIcon } from '../components/ChannelIcon';
import { BarList, DailyAreaChart, VIZ } from '../components/charts';
import { PageContainer } from '../components/Layout';
import { Card, cx, ErrorState, PageHeader, PageLoader, Segmented, Stat } from '../components/ui';
import { useAuth } from '../lib/auth';
import { CHANNEL_META, formatMoney, formatNumber, timeAgo } from '../lib/format';
import type { ChannelType, Overview } from '../lib/types';
import { useWid, useWorkspace, useWsApi } from '../lib/workspace';

function pctDelta(now: number, before: number): number | null {
  if (before === 0) return now === 0 ? 0 : null;
  return ((now - before) / before) * 100;
}

function greeting() {
  const h = new Date().getHours();
  return h < 12 ? 'Good morning' : h < 18 ? 'Good afternoon' : 'Good evening';
}

const ACTIVITY: Record<string, { icon: ReactNode; text: (a: Overview['activity'][number], currency: string) => string }> = {
  conversation_started: {
    icon: <MessageCircle className="size-4" />,
    text: (a) => `New conversation with ${a.contact_name ?? 'a customer'}${a.data.channel ? ` on ${CHANNEL_META[a.data.channel as ChannelType]?.label ?? a.data.channel}` : ''}`,
  },
  order_created: {
    icon: <ShoppingBag className="size-4" />,
    text: (a, cur) => `${a.contact_name ?? 'A customer'} placed order #${a.data.number} · ${formatMoney(Number(a.data.total), cur)}`,
  },
  booking_created: { icon: <CalendarCheck className="size-4" />, text: (a) => `${a.contact_name ?? 'A customer'} booked ${a.data.service ?? 'an appointment'}` },
  booking_changed: { icon: <CalendarCheck className="size-4" />, text: (a) => `Booking #${a.data.number} ${a.data.action}` },
  handoff: { icon: <Hand className="size-4" />, text: (a) => `${a.contact_name ?? 'A customer'} needs a team member: ${a.data.reason ?? ''}` },
  knowledge_gap: { icon: <BookOpen className="size-4" />, text: (a) => `Couldn't answer: “${a.data.question}”` },
  lead_stage_changed: { icon: <TrendingUp className="size-4" />, text: (a) => `${a.contact_name ?? 'A lead'} moved to ${a.data.to}` },
  followup_sent: { icon: <Repeat className="size-4" />, text: (a) => `Followed up with ${a.contact_name ?? 'a quiet lead'}` },
  order_change_requested: { icon: <ShoppingBag className="size-4" />, text: (a) => `${a.contact_name ?? 'A customer'} asked to change order #${a.data.number}` },
};

export default function Dashboard() {
  const api = useWsApi();
  const wid = useWid();
  const { user } = useAuth();
  const ws = useWorkspace().data;
  const [days, setDays] = useState<'7' | '30' | '90'>('7');
  const { data, isLoading, isFetching, error, refetch } = useQuery({
    queryKey: ['ws', wid, 'overview', days],
    queryFn: () => api.get<Overview>(`/analytics/overview?days=${days}`),
    placeholderData: keepPreviousData,
    refetchInterval: 60_000,
  });

  if (isLoading || !ws) return <PageLoader />;
  if (error || !data) {
    return (
      <PageContainer wide>
        <ErrorState error={error} retry={() => refetch()} />
      </PageContainer>
    );
  }
  const w = ws.workspace;
  const s = data.stats;
  const p = data.previous;
  const period = `previous ${days} days`;
  const cur = w.currency;
  const checklist = ws.checklist;
  const setupDone = checklist.profile && checklist.catalog && checklist.tested && checklist.channel;
  const link = (path: string) => `/w/${wid}/${path}`;
  const attention = data.attention;
  const hasAttention = attention.needsHuman.length + attention.openGaps + attention.orderChanges + attention.failedMessages > 0;

  return (
    <PageContainer wide>
      <PageHeader title={`${greeting()}, ${user?.name.split(' ')[0] ?? ''}`} description={`Here's how ${w.ai.assistantName} is doing for ${w.name}.`} />

      {!setupDone && (
        <Card title="Finish setting up" description="A few steps and your assistant is ready for real customers." className="mb-6">
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            {[
              { done: checklist.profile, label: 'Describe your business', to: 'settings' },
              { done: checklist.catalog, label: 'Add products, services or FAQs', to: 'catalog' },
              { done: checklist.tested, label: 'Test your assistant', to: 'playground' },
              { done: checklist.channel, label: 'Share your chat link with customers', to: 'channels' },
            ].map((item) => (
              <Link
                key={item.label}
                to={link(item.to)}
                className={cx('flex items-center gap-2 rounded-lg border px-3 py-2.5 text-sm', item.done ? 'border-zinc-100 text-zinc-400' : 'border-zinc-200 font-medium text-zinc-800 hover:border-brand-300 hover:bg-brand-50/50')}
              >
                {item.done ? <CheckCircle2 className="size-4 text-brand-600" /> : <Circle className="size-4 text-zinc-300" />}
                <span className={cx('flex-1', item.done && 'line-through')}>{item.label}</span>
                {!item.done && <ArrowRight className="size-4 text-zinc-400" />}
              </Link>
            ))}
          </div>
        </Card>
      )}

      {/* One filter row scopes everything below it. */}
      <div className="mb-4 flex items-center gap-3">
        <Segmented
          value={days}
          onChange={setDays}
          options={[
            { id: '7', label: 'Last 7 days' },
            { id: '30', label: 'Last 30 days' },
            { id: '90', label: 'Last 90 days' },
          ]}
        />
        {isFetching && <span className="text-xs text-zinc-400">Updating…</span>}
      </div>

      <div className={cx('space-y-6 transition-opacity', isFetching && 'opacity-60')}>
        {hasAttention && (
          <div className="rounded-xl border border-amber-200 bg-amber-50/60 p-4">
            <div className="mb-2 flex items-center gap-2 text-sm font-semibold text-amber-900">
              <AlertTriangle className="size-4" /> Needs your attention
            </div>
            <div className="grid gap-2 md:grid-cols-2">
              {attention.needsHuman.map((c) => (
                <Link key={c.id} to={link(`inbox?c=${c.id}`)} className="flex items-center gap-2 rounded-lg bg-white px-3 py-2 text-sm shadow-xs hover:bg-zinc-50">
                  <Hand className="size-4 text-red-600" />
                  <span className="font-medium">{c.name ?? 'Customer'}</span>
                  <span className="flex-1 truncate text-zinc-500">{c.reason ?? c.preview}</span>
                  <span className="text-xs text-zinc-400">{timeAgo(c.lastMessageAt)}</span>
                </Link>
              ))}
              {attention.openGaps > 0 && (
                <Link to={link('knowledge?tab=gaps')} className="flex items-center gap-2 rounded-lg bg-white px-3 py-2 text-sm shadow-xs hover:bg-zinc-50">
                  <BookOpen className="size-4 text-amber-700" />
                  <span className="flex-1">
                    {attention.openGaps} question{attention.openGaps === 1 ? '' : 's'} the assistant couldn't answer
                  </span>
                  <ArrowRight className="size-4 text-zinc-400" />
                </Link>
              )}
              {attention.orderChanges > 0 && (
                <Link to={link('orders?changes=1')} className="flex items-center gap-2 rounded-lg bg-white px-3 py-2 text-sm shadow-xs hover:bg-zinc-50">
                  <ShoppingBag className="size-4 text-amber-700" />
                  <span className="flex-1">
                    {attention.orderChanges} order change request{attention.orderChanges === 1 ? '' : 's'}
                  </span>
                  <ArrowRight className="size-4 text-zinc-400" />
                </Link>
              )}
              {attention.failedMessages > 0 && (
                <Link to={link('channels')} className="flex items-center gap-2 rounded-lg bg-white px-3 py-2 text-sm shadow-xs hover:bg-zinc-50">
                  <AlertTriangle className="size-4 text-red-600" />
                  <span className="flex-1">
                    {attention.failedMessages} message{attention.failedMessages === 1 ? '' : 's'} failed to send in the last 24h
                  </span>
                  <ArrowRight className="size-4 text-zinc-400" />
                </Link>
              )}
            </div>
          </div>
        )}

        <div className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-6">
          <Stat label="Conversations" value={formatNumber(s.activeConversations)} delta={{ value: pctDelta(s.activeConversations, p.activeConversations) ?? NaN, period }} />
          {w.commerce.ordersEnabled && (
            <Stat label="Orders" value={formatNumber(s.orders)} hint={formatMoney(s.revenue, cur)} delta={{ value: pctDelta(s.orders, p.orders) ?? NaN, period }} />
          )}
          {w.booking.enabled && <Stat label="Bookings" value={formatNumber(s.bookings)} delta={{ value: pctDelta(s.bookings, p.bookings) ?? NaN, period }} />}
          {!w.commerce.ordersEnabled && !w.booking.enabled && (
            <Stat label="Qualified leads" value={formatNumber(s.qualifiedLeads)} delta={{ value: pctDelta(s.qualifiedLeads, p.qualifiedLeads) ?? NaN, period }} />
          )}
          <Stat label="Conversion" value={`${s.conversionRate}%`} hint="Orders + bookings ÷ new chats" />
          <Stat label="Handled by AI" value={`${s.aiHandledRate}%`} hint={`${s.handoffs} handed to your team`} />
          <Stat label="First reply" value={s.avgFirstResponseSec === null ? '—' : s.avgFirstResponseSec < 60 ? `${s.avgFirstResponseSec}s` : `${Math.round(s.avgFirstResponseSec / 60)}m`} hint="Average time to first answer" />
          <Stat label="New leads" value={formatNumber(s.newLeads)} delta={{ value: pctDelta(s.newLeads, p.newLeads) ?? NaN, period }} />
        </div>

        <div className="grid gap-4 lg:grid-cols-2">
          <DailyAreaChart data={data.series} dataKey="conversations" title="Conversations per day" seriesLabel="conversations" days={Number(days)} />
          {w.commerce.ordersEnabled ? (
            <DailyAreaChart
              data={data.series}
              dataKey="orders"
              title="Orders per day"
              seriesLabel="orders"
              days={Number(days)}
              extra={(row) => <div className="mt-0.5 text-zinc-500">{formatMoney(Number(row.revenue), cur)} revenue</div>}
            />
          ) : (
            <DailyAreaChart data={data.series} dataKey="bookings" title="Bookings per day" seriesLabel="bookings" days={Number(days)} />
          )}
        </div>

        <div className="grid gap-4 lg:grid-cols-2">
          <Card title="Lead funnel" description="Customers who started chatting in this period, by how far they got">
            <BarList
              rows={data.funnel.map((f, i) => ({
                key: f.stage,
                label: f.stage,
                value: f.count,
                display: formatNumber(f.count),
                color: VIZ.ordinal[i] ?? VIZ.series,
              }))}
            />
          </Card>
          <Card title="Conversations by channel">
            <BarList
              empty="No conversations in this period"
              rows={s.byChannel.map((c) => ({
                key: c.channel,
                label: (
                  <span className="flex items-center gap-2">
                    <ChannelIcon type={c.channel} size={16} /> {CHANNEL_META[c.channel]?.label ?? c.channel}
                  </span>
                ),
                value: c.conversations,
                detail: `${CHANNEL_META[c.channel]?.label ?? c.channel}: ${c.conversations}`,
              }))}
            />
          </Card>
        </div>

        <div className="grid gap-4 lg:grid-cols-2">
          <Card title="Most asked about" description="Products and services customers asked for details on">
            <BarList empty="Nothing yet" rows={data.items.mostAskedAbout.map((i) => ({ key: i.name, label: i.name, value: i.count }))} />
          </Card>
          {w.commerce.ordersEnabled ? (
            <Card title="Best sellers" description="Units sold through chat">
              <BarList
                empty="No orders yet"
                rows={data.items.bestSellers.map((i) => ({
                  key: i.name,
                  label: i.name,
                  value: i.quantity,
                  display: `${i.quantity}`,
                  detail: `${i.name}: ${i.quantity} sold · ${formatMoney(i.revenue, cur)}`,
                }))}
              />
            </Card>
          ) : (
            <Card title="Lead quality" description="How conversations progressed">
              <BarList
                rows={[
                  { key: 'new', label: 'New leads', value: s.newLeads },
                  { key: 'qualified', label: 'Qualified', value: s.qualifiedLeads },
                  { key: 'lost', label: 'Lost', value: s.lostLeads },
                ]}
              />
            </Card>
          )}
        </div>

        <Card title="Recent activity" bodyClassName="p-0">
          {data.activity.length === 0 ? (
            <p className="px-5 py-8 text-center text-sm text-zinc-500">Activity from your channels will show up here.</p>
          ) : (
            <ul className="divide-y divide-zinc-100">
              {data.activity.map((a) => {
                const meta = ACTIVITY[a.type];
                if (!meta) return null;
                const body = (
                  <>
                    <span className="flex size-8 shrink-0 items-center justify-center rounded-full bg-zinc-100 text-zinc-600">{meta.icon}</span>
                    <span className="flex-1 text-sm text-zinc-700">{meta.text(a, cur)}</span>
                    <span className="shrink-0 text-xs text-zinc-400">{timeAgo(a.created_at)}</span>
                  </>
                );
                return (
                  <li key={a.id}>
                    {a.conversation_id ? (
                      <Link to={link(`inbox?c=${a.conversation_id}`)} className="flex items-center gap-3 px-5 py-3 hover:bg-zinc-50">
                        {body}
                      </Link>
                    ) : (
                      <div className="flex items-center gap-3 px-5 py-3">{body}</div>
                    )}
                  </li>
                );
              })}
            </ul>
          )}
        </Card>
      </div>
    </PageContainer>
  );
}
