import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { CalendarDays, MessagesSquare, Phone } from 'lucide-react';
import { useMemo, useState } from 'react';
import { Link } from 'react-router';
import { PageContainer } from '../components/Layout';
import { Badge, Button, EmptyState, ErrorState, Modal, PageHeader, PageLoader, Segmented, Textarea } from '../components/ui';
import { errorMessage } from '../lib/api';
import { BOOKING_STATUS_META, formatDate, formatTime } from '../lib/format';
import { useToast } from '../lib/toast';
import type { Booking, BookingStatus } from '../lib/types';
import { useWid, useWorkspace, useWsApi } from '../lib/workspace';

export default function Bookings() {
  const api = useWsApi();
  const wid = useWid();
  const qc = useQueryClient();
  const toast = useToast();
  const ws = useWorkspace().data?.workspace;
  const [view, setView] = useState<'upcoming' | 'past'>('upcoming');
  const range = useMemo(() => {
    const now = Date.now();
    return view === 'upcoming'
      ? { from: new Date(now - 2 * 3600_000).toISOString(), to: new Date(now + 120 * 86_400_000).toISOString() }
      : { from: new Date(now - 90 * 86_400_000).toISOString(), to: new Date(now).toISOString() };
  }, [view]);
  const { data, isLoading, error, refetch } = useQuery({
    queryKey: ['ws', wid, 'bookings', view],
    queryFn: () => api.get<{ bookings: Booking[] }>(`/bookings?from=${encodeURIComponent(range.from)}&to=${encodeURIComponent(range.to)}`),
    refetchInterval: 30_000,
  });
  const [notifyFor, setNotifyFor] = useState<{ booking: Booking; status: BookingStatus } | null>(null);
  const [message, setMessage] = useState('');

  const update = useMutation({
    mutationFn: ({ id, status, customerMessage }: { id: string; status: BookingStatus; customerMessage?: string }) =>
      api.patch<{ notified: { sent: boolean; error?: string } | null }>(`/bookings/${id}`, { status, ...(customerMessage ? { customerMessage } : {}) }),
    onSuccess: (res) => {
      if (res.notified && !res.notified.sent) toast.error(`Updated, but the customer was not notified: ${res.notified.error}`);
      else toast.success('Booking updated');
      qc.invalidateQueries({ queryKey: ['ws', wid, 'bookings'] });
      setNotifyFor(null);
    },
    onError: (err) => toast.error(errorMessage(err)),
  });

  const groups = useMemo(() => {
    const list = [...(data?.bookings ?? [])].sort((a, b) => (view === 'upcoming' ? 1 : -1) * (new Date(a.startAt).getTime() - new Date(b.startAt).getTime()));
    const map = new Map<string, Booking[]>();
    for (const b of list) {
      const key = formatDate(b.startAt, { weekday: 'long', month: 'long', day: 'numeric' });
      map.set(key, [...(map.get(key) ?? []), b]);
    }
    return [...map.entries()];
  }, [data, view]);

  return (
    <PageContainer>
      <PageHeader
        title="Bookings"
        description={`Appointments your assistant booked. Times are shown in your browser's timezone${ws ? ` (business timezone: ${ws.timezone})` : ''}.`}
        actions={<Segmented value={view} onChange={setView} options={[{ id: 'upcoming', label: 'Upcoming' }, { id: 'past', label: 'Past' }]} />}
      />
      {error ? (
        <ErrorState error={error} retry={() => refetch()} />
      ) : isLoading ? (
        <PageLoader />
      ) : groups.length === 0 ? (
        <div className="rounded-xl border border-zinc-200 bg-white">
          <EmptyState
            icon={<CalendarDays className="size-6" />}
            title={view === 'upcoming' ? 'No upcoming bookings' : 'No past bookings'}
            description={ws?.booking.enabled ? 'When customers book in chat, appointments appear here.' : 'Turn on booking under AI assistant settings to let customers book in chat.'}
          />
        </div>
      ) : (
        <div className="space-y-6">
          {groups.map(([day, list]) => (
            <section key={day}>
              <h2 className="mb-2 text-sm font-semibold text-zinc-500">{day}</h2>
              <div className="divide-y divide-zinc-100 rounded-xl border border-zinc-200 bg-white shadow-xs">
                {list.map((b) => (
                  <div key={b.id} className="flex flex-wrap items-center gap-4 px-4 py-3">
                    <div className="w-20 shrink-0">
                      <div className="text-sm font-semibold text-zinc-900">{formatTime(b.startAt)}</div>
                      <div className="text-xs text-zinc-500">{Math.round((new Date(b.endAt).getTime() - new Date(b.startAt).getTime()) / 60000)} min</div>
                    </div>
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2">
                        <span className="font-medium text-zinc-900">{b.serviceName}</span>
                        <Badge tone={BOOKING_STATUS_META[b.status].tone}>{BOOKING_STATUS_META[b.status].label}</Badge>
                      </div>
                      <div className="mt-0.5 flex flex-wrap items-center gap-3 text-sm text-zinc-600">
                        <span>
                          #{b.number} · {b.customerName}
                        </span>
                        <a href={`tel:${b.phone}`} className="flex items-center gap-1 hover:underline">
                          <Phone className="size-3" /> {b.phone}
                        </a>
                      </div>
                      {b.notes && <p className="mt-1 text-xs text-zinc-500">{b.notes}</p>}
                    </div>
                    <div className="flex flex-wrap gap-2">
                      {b.conversationId && (
                        <Link to={`/w/${wid}/inbox?c=${b.conversationId}`}>
                          <Button size="sm" variant="ghost" icon={<MessagesSquare className="size-4" />}>
                            Chat
                          </Button>
                        </Link>
                      )}
                      {b.status === 'confirmed' && view === 'past' && (
                        <>
                          <Button size="sm" variant="secondary" onClick={() => update.mutate({ id: b.id, status: 'completed' })}>
                            Completed
                          </Button>
                          <Button size="sm" variant="ghost" onClick={() => update.mutate({ id: b.id, status: 'no_show' })}>
                            No-show
                          </Button>
                        </>
                      )}
                      {b.status === 'confirmed' && view === 'upcoming' && (
                        <Button
                          size="sm"
                          variant="ghost"
                          onClick={() => {
                            setNotifyFor({ booking: b, status: 'cancelled' });
                            setMessage(`Hi ${b.customerName}, unfortunately we need to cancel your ${b.serviceName} appointment on ${formatDate(b.startAt, { weekday: 'short', month: 'short', day: 'numeric' })} at ${formatTime(b.startAt)}. Reply here and we'll find another time for you.`);
                          }}
                        >
                          Cancel
                        </Button>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            </section>
          ))}
        </div>
      )}
      <Modal
        open={Boolean(notifyFor)}
        onClose={() => setNotifyFor(null)}
        title="Cancel booking"
        description="We'll send this message to the customer in the same chat."
        footer={
          <>
            <Button variant="secondary" onClick={() => notifyFor && update.mutate({ id: notifyFor.booking.id, status: 'cancelled' })}>
              Cancel without message
            </Button>
            <Button variant="danger" loading={update.isPending} onClick={() => notifyFor && update.mutate({ id: notifyFor.booking.id, status: 'cancelled', customerMessage: message })}>
              Cancel and notify
            </Button>
          </>
        }
      >
        <Textarea rows={4} value={message} onChange={(e) => setMessage(e.target.value)} />
      </Modal>
    </PageContainer>
  );
}
