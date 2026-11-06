import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { FileText, Mail, Sparkles } from 'lucide-react';
import { useState } from 'react';
import { useSearchParams } from 'react-router';
import { StringListEditor } from '../components/editors';
import { PageContainer } from '../components/Layout';
import { Markdown } from '../components/Markdown';
import { Badge, Banner, Button, Card, Checkbox, cx, EmptyState, ErrorState, Field, PageHeader, PageLoader, SaveBar, Segmented, Select, Tabs, Toggle } from '../components/ui';
import { errorMessage } from '../lib/api';
import { useAuth } from '../lib/auth';
import { formatDateTime, formatMoney, formatNumber } from '../lib/format';
import { useDraft, useSaveSettings } from '../lib/settings';
import { useToast } from '../lib/toast';
import type { Report, ReportSettings, WorkspaceDetail } from '../lib/types';
import { useWid, useWorkspace, useWsApi } from '../lib/workspace';

type TabId = 'reports' | 'settings';

export default function Reports() {
  const { data, isLoading, error, refetch } = useWorkspace();
  const [params, setParams] = useSearchParams();
  const tab: TabId = params.get('tab') === 'settings' ? 'settings' : 'reports';
  if (isLoading) return <PageLoader />;
  if (!data) {
    return (
      <PageContainer>
        <ErrorState error={error} retry={() => refetch()} />
      </PageContainer>
    );
  }
  return (
    <PageContainer wide>
      <PageHeader
        title="Reports"
        description="Daily and weekly summaries of what your assistant handled: sales, hot leads to follow up, and questions it couldn't answer."
      />
      <Tabs<TabId>
        className="mb-6"
        value={tab}
        onChange={(id) =>
          setParams(
            (p) => {
              p.set('tab', id);
              p.delete('id');
              return p;
            },
            { replace: true },
          )
        }
        tabs={[
          { id: 'reports', label: 'Reports' },
          { id: 'settings', label: 'Email & alerts' },
        ]}
      />
      {tab === 'reports' ? <ReportsList detail={data} /> : <ReportSettingsForm detail={data} />}
    </PageContainer>
  );
}

function ReportsList({ detail }: { detail: WorkspaceDetail }) {
  const api = useWsApi();
  const wid = useWid();
  const qc = useQueryClient();
  const toast = useToast();
  const { app } = useAuth();
  const [params, setParams] = useSearchParams();
  const [period, setPeriod] = useState<'daily' | 'weekly'>('daily');
  const [email, setEmail] = useState(false);

  const list = useQuery({ queryKey: ['ws', wid, 'reports'], queryFn: () => api.get<{ reports: Report[] }>('/reports') });
  const reports = list.data?.reports ?? [];
  const selectedId = params.get('id') ?? reports[0]?.id ?? null;
  const report = useQuery({
    queryKey: ['ws', wid, 'reports', selectedId],
    queryFn: () => api.get<{ report: Report }>(`/reports/${selectedId}`),
    enabled: Boolean(selectedId),
  });

  const generate = useMutation({
    mutationFn: () => api.post<{ report: Report }>('/reports/generate', { period, email }),
    onSuccess: async (res) => {
      await qc.invalidateQueries({ queryKey: ['ws', wid, 'reports'], exact: true });
      setParams((p) => (p.set('id', res.report.id), p), { replace: true });
      toast.success(email && res.report.emailedAt ? 'Report created and emailed' : 'Report created');
    },
    onError: (err) => toast.error(errorMessage(err)),
  });

  const select = (id: string) => setParams((p) => (p.set('id', id), p), { replace: true });

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-3 rounded-xl border border-zinc-200 bg-white p-3 shadow-xs">
        <span className="text-sm font-medium text-zinc-700">Create a report now:</span>
        <Segmented
          value={period}
          onChange={setPeriod}
          options={[
            { id: 'daily', label: 'Last 24 hours' },
            { id: 'weekly', label: 'Last 7 days' },
          ]}
        />
        <Checkbox checked={email} onChange={setEmail} label="Also email it" />
        <Button icon={<Sparkles className="size-4" />} loading={generate.isPending} onClick={() => generate.mutate()}>
          Generate
        </Button>
      </div>
      {app && !app.emailConfigured && (
        <Banner tone="zinc">Email is not set up on the server yet (SMTP_URL), so scheduled reports are saved here but not emailed.</Banner>
      )}

      {list.isLoading ? (
        <PageLoader />
      ) : list.error ? (
        <ErrorState error={list.error} retry={() => list.refetch()} />
      ) : reports.length === 0 ? (
        <Card>
          <EmptyState
            icon={<FileText className="size-6" />}
            title="No reports yet"
            description={`Your first daily report arrives automatically at ${hourLabel(detail.workspace.reporting.dailyHour)}. You can also create one now.`}
          />
        </Card>
      ) : (
        <div className="grid gap-4 lg:grid-cols-[18rem_minmax(0,1fr)]">
          <Card bodyClassName="p-2">
            <ul className="scroll-thin max-h-[70vh] space-y-0.5 overflow-y-auto">
              {reports.map((r) => (
                <li key={r.id}>
                  <button
                    onClick={() => select(r.id)}
                    className={cx(
                      'w-full rounded-lg px-3 py-2 text-left transition-colors',
                      r.id === selectedId ? 'bg-brand-50 text-brand-900' : 'text-zinc-700 hover:bg-zinc-50',
                    )}
                  >
                    <div className="flex items-center justify-between gap-2">
                      <span className="truncate text-sm font-medium">{r.label.split(' · ')[0]}</span>
                      {r.emailedAt && <Mail className="size-3.5 shrink-0 text-zinc-400" aria-label="Emailed" />}
                    </div>
                    <div className="text-xs text-zinc-500">{formatDateTime(r.createdAt)}</div>
                  </button>
                </li>
              ))}
            </ul>
          </Card>
          <div>
            {report.isLoading ? (
              <PageLoader />
            ) : report.error ? (
              <ErrorState error={report.error} retry={() => report.refetch()} />
            ) : report.data ? (
              <ReportView report={report.data.report} currency={detail.workspace.currency} />
            ) : null}
          </div>
        </div>
      )}
    </div>
  );
}

function ReportView({ report, currency }: { report: Report; currency: string }) {
  const s = report.stats as Record<string, any>;
  const tiles: [string, string][] = [
    ['Customers who messaged', formatNumber(Number(s.activeConversations ?? 0))],
    ['New conversations', formatNumber(Number(s.newConversations ?? 0))],
    ['Orders', formatNumber(Number(s.orders ?? 0))],
    ['Revenue', formatMoney(Number(s.revenue ?? 0), currency)],
    ['Bookings', formatNumber(Number(s.bookings ?? 0))],
    ['New leads', formatNumber(Number(s.newLeads ?? 0))],
    ['Handled fully by AI', `${s.aiHandledRate ?? 0}%`],
    ['Needed your team', formatNumber(Number(s.handoffs ?? 0))],
  ];
  const best = (s.bestSellers ?? []) as { name: string; quantity: number; revenue: number }[];
  const asked = (s.mostAskedAbout ?? []) as { name: string; count: number }[];
  return (
    <div className="space-y-4">
      <Card
        title={report.label}
        description={report.periodStart && report.periodEnd ? `${formatDateTime(report.periodStart)} – ${formatDateTime(report.periodEnd)}` : undefined}
        actions={report.emailedAt ? <Badge tone="green"><Mail className="size-3" /> Emailed {formatDateTime(report.emailedAt)}</Badge> : undefined}
      >
        <dl className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          {tiles.map(([label, value]) => (
            <div key={label} className="rounded-lg bg-zinc-50 p-3">
              <dt className="text-xs text-zinc-500">{label}</dt>
              <dd className="mt-0.5 text-lg font-semibold text-zinc-900">{value}</dd>
            </div>
          ))}
        </dl>
      </Card>
      {report.summary && (
        <Card title="Summary">
          <Markdown text={report.summary} />
        </Card>
      )}
      {(best.length > 0 || asked.length > 0) && (
        <div className="grid gap-4 md:grid-cols-2">
          <Card title="Best sellers">
            {best.length === 0 ? (
              <p className="text-sm text-zinc-500">No orders in this period.</p>
            ) : (
              <table className="w-full text-sm">
                <tbody>
                  {best.map((b) => (
                    <tr key={b.name} className="border-b border-zinc-100 last:border-0">
                      <td className="py-1.5 text-zinc-700">{b.name}</td>
                      <td className="py-1.5 text-right text-zinc-500 tabular-nums">×{b.quantity}</td>
                      <td className="py-1.5 text-right font-medium text-zinc-900 tabular-nums">{formatMoney(b.revenue, currency)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </Card>
          <Card title="Most asked about">
            {asked.length === 0 ? (
              <p className="text-sm text-zinc-500">No product questions in this period.</p>
            ) : (
              <table className="w-full text-sm">
                <tbody>
                  {asked.map((a) => (
                    <tr key={a.name} className="border-b border-zinc-100 last:border-0">
                      <td className="py-1.5 text-zinc-700">{a.name}</td>
                      <td className="py-1.5 text-right text-zinc-500 tabular-nums">{a.count} conversations</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </Card>
        </div>
      )}
    </div>
  );
}

function hourLabel(h: number): string {
  const d = new Date();
  d.setHours(h, 0, 0, 0);
  return new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit' }).format(d);
}

function ReportSettingsForm({ detail }: { detail: WorkspaceDetail }) {
  const canEdit = detail.role === 'owner' || detail.role === 'admin';
  const [draft, setDraft, dirty, reset] = useDraft<ReportSettings>(detail.workspace.reporting);
  const save = useSaveSettings('Report settings saved');
  const set = (patch: Partial<ReportSettings>) => setDraft((d) => ({ ...d, ...patch }));
  const setAlert = (k: keyof ReportSettings['alerts'], v: boolean) => setDraft((d) => ({ ...d, alerts: { ...d.alerts, [k]: v } }));
  const invalidEmail = draft.extraRecipients.find((e) => e.trim() && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e.trim()));

  return (
    <div className="space-y-6">
      {!canEdit && <Banner tone="zinc">Only owners and admins can change these settings.</Banner>}
      <fieldset disabled={!canEdit} className="space-y-6">
        <Card title="Scheduled reports" description={`Times are in your business timezone (${detail.workspace.timezone}).`} bodyClassName="space-y-5">
          <Toggle checked={draft.dailyEnabled} onChange={(v) => set({ dailyEnabled: v })} label="Daily report" description="A summary of the last 24 hours, every day." />
          {draft.dailyEnabled && (
            <Field label="Send it at" className="max-w-xs">
              <Select value={draft.dailyHour} onChange={(e) => set({ dailyHour: Number(e.target.value) })}>
                {Array.from({ length: 24 }, (_, h) => (
                  <option key={h} value={h}>
                    {hourLabel(h)}
                  </option>
                ))}
              </Select>
            </Field>
          )}
          <Toggle checked={draft.weeklyEnabled} onChange={(v) => set({ weeklyEnabled: v })} label="Weekly report" description="Every Monday: the last 7 days, trends and suggestions." />
        </Card>

        <Card title="Instant alerts" description="Emails sent the moment something important happens." bodyClassName="space-y-4">
          <Toggle checked={draft.alerts.newOrder} onChange={(v) => setAlert('newOrder', v)} label="New order" />
          <Toggle checked={draft.alerts.newBooking} onChange={(v) => setAlert('newBooking', v)} label="New booking" />
          <Toggle checked={draft.alerts.hotLead} onChange={(v) => setAlert('hotLead', v)} label="Hot lead" description="A customer is ready to buy but hasn't ordered yet." />
          <Toggle checked={draft.alerts.handoff} onChange={(v) => setAlert('handoff', v)} label="A customer needs a person" description="The assistant handed a conversation to your team." />
        </Card>

        <Card
          title="Who receives them"
          description="Owners and admins get reports and alerts unless they turn them off under Settings → Team. Add anyone else here."
        >
          <StringListEditor value={draft.extraRecipients} onChange={(v) => set({ extraRecipients: v })} placeholder="name@example.com" addLabel="Add email" />
          {invalidEmail && <p className="mt-2 text-xs text-red-600">“{invalidEmail}” is not a valid email address.</p>}
        </Card>
      </fieldset>
      <SaveBar
        dirty={dirty}
        saving={save.isPending}
        readOnly={!canEdit}
        onReset={reset}
        onSave={() => {
          if (invalidEmail) return;
          save.mutate({ reporting: { ...draft, extraRecipients: draft.extraRecipients.map((e) => e.trim()).filter(Boolean) } });
        }}
      />
    </div>
  );
}
