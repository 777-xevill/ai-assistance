import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { AlertCircle, Download, MessagesSquare, Search, ShoppingBag } from 'lucide-react';
import { useEffect, useState } from 'react';
import { Link, useSearchParams } from 'react-router';
import { PageContainer } from '../components/Layout';
import { Badge, Button, Checkbox, Drawer, EmptyState, ErrorState, Field, Input, PageHeader, PageLoader, Select, Textarea } from '../components/ui';
import { errorMessage } from '../lib/api';
import { formatDateTime, formatMoney, ORDER_STATUS_META } from '../lib/format';
import { useToast } from '../lib/toast';
import type { Order, OrderStatus } from '../lib/types';
import { useWid, useWsApi } from '../lib/workspace';

const STATUSES = Object.keys(ORDER_STATUS_META) as OrderStatus[];

function customerTemplate(o: Order, status: OrderStatus): string {
  switch (status) {
    case 'confirmed':
      return `Hi ${o.customerName}! Your order #${o.number} is confirmed. We'll let you know as soon as it ships.`;
    case 'processing':
      return `Hi ${o.customerName}, we're preparing your order #${o.number} now.`;
    case 'shipped':
      return `Good news ${o.customerName}! Your order #${o.number} is on its way 🚚`;
    case 'delivered':
      return `Your order #${o.number} has been delivered. Thank you for shopping with us! We'd love to hear what you think.`;
    case 'cancelled':
      return `Hi ${o.customerName}, your order #${o.number} has been cancelled. If this wasn't expected, just reply here and we'll help.`;
    default:
      return '';
  }
}

export default function Orders() {
  const api = useWsApi();
  const wid = useWid();
  const [params, setParams] = useSearchParams();
  const [status, setStatus] = useState<OrderStatus | ''>('');
  const [q, setQ] = useState('');
  const onlyChanges = params.get('changes') === '1';
  const openId = params.get('id');
  const query = new URLSearchParams({ ...(status ? { status } : {}), ...(q ? { q } : {}), ...(onlyChanges ? { changes: '1' } : {}) }).toString();
  const { data, isLoading, error, refetch } = useQuery({
    queryKey: ['ws', wid, 'orders', query],
    queryFn: () => api.get<{ orders: Order[]; statusCounts: Record<string, number> }>(`/orders?${query}`),
    refetchInterval: 30_000,
  });

  return (
    <PageContainer wide>
      <PageHeader
        title="Orders"
        description="Orders your assistant collected in chat. Update the status and optionally tell the customer in the same chat."
        actions={
          <a href={api.url('/orders/export.csv')}>
            <Button variant="secondary" icon={<Download className="size-4" />}>
              Export CSV
            </Button>
          </a>
        }
      />
      <div className="mb-4 flex flex-wrap items-center gap-2">
        <button onClick={() => { setStatus(''); setParams({}); }} className={`rounded-full px-3 py-1 text-sm font-medium ${status === '' && !onlyChanges ? 'bg-zinc-900 text-white' : 'bg-white text-zinc-600 ring-1 ring-zinc-200 hover:bg-zinc-50'}`}>
          All
        </button>
        {STATUSES.map((s) => (
          <button
            key={s}
            onClick={() => setStatus(s)}
            className={`rounded-full px-3 py-1 text-sm font-medium ${status === s ? 'bg-zinc-900 text-white' : 'bg-white text-zinc-600 ring-1 ring-zinc-200 hover:bg-zinc-50'}`}
          >
            {ORDER_STATUS_META[s].label} {data?.statusCounts[s] ? <span className="opacity-70">{data.statusCounts[s]}</span> : null}
          </button>
        ))}
        {onlyChanges && <Badge tone="amber">Showing change requests</Badge>}
        <div className="relative ml-auto w-full sm:w-64">
          <Search className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-zinc-400" />
          <Input className="pl-9" placeholder="Order #, name or phone" value={q} onChange={(e) => setQ(e.target.value)} />
        </div>
      </div>

      {error ? (
        <ErrorState error={error} retry={() => refetch()} />
      ) : isLoading ? (
        <PageLoader />
      ) : (data?.orders.length ?? 0) === 0 ? (
        <div className="rounded-xl border border-zinc-200 bg-white">
          <EmptyState icon={<ShoppingBag className="size-6" />} title="No orders yet" description="When a customer confirms an order in chat, it lands here and you get an alert." />
        </div>
      ) : (
        <div className="overflow-x-auto rounded-xl border border-zinc-200 bg-white shadow-xs">
          <table className="w-full min-w-[760px] text-sm">
            <thead className="bg-zinc-50 text-left text-xs font-medium text-zinc-500">
              <tr>
                <th className="px-4 py-2.5">Order</th>
                <th className="px-4 py-2.5">Customer</th>
                <th className="px-4 py-2.5">Items</th>
                <th className="px-4 py-2.5 text-right">Total</th>
                <th className="px-4 py-2.5">Status</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-zinc-100">
              {data!.orders.map((o) => (
                <tr key={o.id} className="cursor-pointer hover:bg-zinc-50" onClick={() => setParams({ id: o.id })}>
                  <td className="px-4 py-3">
                    <div className="font-medium text-zinc-900">#{o.number}</div>
                    <div className="text-xs text-zinc-500">{formatDateTime(o.createdAt)}</div>
                  </td>
                  <td className="px-4 py-3">
                    <div className="font-medium text-zinc-800">{o.customerName}</div>
                    <div className="text-xs text-zinc-500 tabular-nums">{o.phone}</div>
                  </td>
                  <td className="max-w-xs px-4 py-3 text-zinc-600">
                    <div className="truncate">{o.items.map((i) => `${i.quantity}× ${i.name}`).join(', ')}</div>
                    {o.changeRequest && (
                      <div className="mt-0.5 flex items-center gap-1 text-xs text-amber-700">
                        <AlertCircle className="size-3" /> Change requested
                      </div>
                    )}
                  </td>
                  <td className="px-4 py-3 text-right font-medium text-zinc-900 tabular-nums">{formatMoney(o.total, o.currency)}</td>
                  <td className="px-4 py-3">
                    <Badge tone={ORDER_STATUS_META[o.status].tone}>{ORDER_STATUS_META[o.status].label}</Badge>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {openId && <OrderDrawer id={openId} onClose={() => setParams(onlyChanges ? { changes: '1' } : {})} />}
    </PageContainer>
  );
}

function OrderDrawer({ id, onClose }: { id: string; onClose: () => void }) {
  const api = useWsApi();
  const wid = useWid();
  const qc = useQueryClient();
  const toast = useToast();
  const { data, isLoading } = useQuery({ queryKey: ['ws', wid, 'order', id], queryFn: () => api.get<{ order: Order }>(`/orders/${id}`) });
  const [status, setStatus] = useState<OrderStatus>('new');
  const [notify, setNotify] = useState(true);
  const [message, setMessage] = useState('');
  const [notes, setNotes] = useState('');
  useEffect(() => {
    if (data) {
      setStatus(data.order.status);
      setNotes(data.order.notes ?? '');
    }
  }, [data]);
  useEffect(() => {
    if (data && status !== data.order.status) setMessage(customerTemplate(data.order, status));
  }, [status, data]);

  const save = useMutation({
    mutationFn: (extra: Record<string, unknown> = {}) =>
      api.patch<{ notified: { sent: boolean; error?: string } | null }>(`/orders/${id}`, {
        status,
        notes: notes || null,
        ...(notify && message.trim() && data && status !== data.order.status ? { customerMessage: message.trim() } : {}),
        ...extra,
      }),
    onSuccess: (res) => {
      if (res.notified && !res.notified.sent) toast.error(`Saved, but the customer was not notified: ${res.notified.error}`);
      else toast.success(res.notified?.sent ? 'Saved and customer notified' : 'Order saved');
      qc.invalidateQueries({ queryKey: ['ws', wid, 'orders'] });
      qc.invalidateQueries({ queryKey: ['ws', wid, 'order', id] });
    },
    onError: (err) => toast.error(errorMessage(err)),
  });

  const o = data?.order;
  return (
    <Drawer
      open
      onClose={onClose}
      title={o ? `Order #${o.number}` : 'Order'}
      footer={
        <>
          {o?.conversationId && (
            <Link to={`/w/${wid}/inbox?c=${o.conversationId}`}>
              <Button variant="secondary" icon={<MessagesSquare className="size-4" />}>
                Conversation
              </Button>
            </Link>
          )}
          <Button onClick={() => save.mutate({})} loading={save.isPending}>
            Save
          </Button>
        </>
      }
    >
      {isLoading || !o ? (
        <PageLoader />
      ) : (
        <div className="space-y-5 text-sm">
          {o.changeRequest && (
            <div className="rounded-lg border border-amber-200 bg-amber-50 p-3">
              <div className="font-medium text-amber-900">The customer asked for a change</div>
              <p className="mt-1 text-amber-900">{o.changeRequest}</p>
              <Button size="sm" variant="secondary" className="mt-2" onClick={() => save.mutate({ clearChangeRequest: true })}>
                Mark as handled
              </Button>
            </div>
          )}
          <div className="rounded-lg border border-zinc-200">
            {o.items.map((i, idx) => (
              <div key={idx} className="flex justify-between gap-3 border-b border-zinc-100 px-3 py-2 last:border-0">
                <span>
                  {i.quantity} × {i.name}
                  {i.variant && <span className="text-zinc-500"> ({i.variant})</span>}
                </span>
                <span className="tabular-nums">{formatMoney(i.total, o.currency)}</span>
              </div>
            ))}
            <div className="space-y-1 bg-zinc-50 px-3 py-2">
              <div className="flex justify-between text-zinc-600">
                <span>Subtotal</span>
                <span className="tabular-nums">{formatMoney(o.subtotal, o.currency)}</span>
              </div>
              <div className="flex justify-between text-zinc-600">
                <span>Delivery{o.deliveryZone ? ` (${o.deliveryZone})` : ''}</span>
                <span className="tabular-nums">{formatMoney(o.deliveryFee, o.currency)}</span>
              </div>
              <div className="flex justify-between font-semibold">
                <span>Total</span>
                <span className="tabular-nums">{formatMoney(o.total, o.currency)}</span>
              </div>
            </div>
          </div>
          <dl className="grid grid-cols-[7rem_1fr] gap-x-3 gap-y-2">
            <dt className="text-zinc-500">Customer</dt>
            <dd>{o.customerName}</dd>
            <dt className="text-zinc-500">Phone</dt>
            <dd className="tabular-nums">{o.phone}</dd>
            {o.email && (
              <>
                <dt className="text-zinc-500">Email</dt>
                <dd>{o.email}</dd>
              </>
            )}
            <dt className="text-zinc-500">Address</dt>
            <dd className="whitespace-pre-line">{o.address ?? '—'}</dd>
            <dt className="text-zinc-500">Payment</dt>
            <dd>{o.paymentMethod ?? '—'}</dd>
            {Object.entries(o.extra).map(([k, v]) => (
              <div key={k} className="contents">
                <dt className="text-zinc-500">{k.replace(/_/g, ' ')}</dt>
                <dd>{v}</dd>
              </div>
            ))}
            <dt className="text-zinc-500">Placed</dt>
            <dd>
              {formatDateTime(o.createdAt)} · {o.source === 'ai' ? 'by the AI assistant' : 'manually'}
            </dd>
          </dl>
          <Field label="Status">
            <Select value={status} onChange={(e) => setStatus(e.target.value as OrderStatus)}>
              {STATUSES.map((s) => (
                <option key={s} value={s}>
                  {ORDER_STATUS_META[s].label}
                </option>
              ))}
            </Select>
          </Field>
          {status !== o.status && o.conversationId && (
            <div className="space-y-2 rounded-lg bg-zinc-50 p-3">
              <Checkbox checked={notify} onChange={setNotify} label="Message the customer about this update" />
              {notify && <Textarea rows={3} value={message} onChange={(e) => setMessage(e.target.value)} />}
            </div>
          )}
          <Field label="Internal notes">
            <Textarea rows={3} value={notes} onChange={(e) => setNotes(e.target.value)} />
          </Field>
        </div>
      )}
    </Drawer>
  );
}
