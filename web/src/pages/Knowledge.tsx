import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { BookOpen, Check, Globe, HelpCircle, Loader2, Pencil, Plus, Trash2, X } from 'lucide-react';
import { useState } from 'react';
import { useSearchParams } from 'react-router';
import { PageContainer } from '../components/Layout';
import { Badge, Button, Card, Checkbox, EmptyState, Field, IconButton, Input, Modal, PageHeader, PageLoader, Tabs, Textarea } from '../components/ui';
import { errorMessage } from '../lib/api';
import { formatMoney, timeAgo } from '../lib/format';
import { useToast } from '../lib/toast';
import type { Faq, Gap } from '../lib/types';
import { useWid, useWorkspace, useWsApi } from '../lib/workspace';

type Tab = 'faqs' | 'gaps' | 'import';

export default function Knowledge() {
  const [params, setParams] = useSearchParams();
  const tab = (params.get('tab') as Tab) || 'faqs';
  const api = useWsApi();
  const wid = useWid();
  const gaps = useQuery({ queryKey: ['ws', wid, 'gaps', 'open'], queryFn: () => api.get<{ gaps: Gap[] }>('/knowledge/gaps?status=open') });
  return (
    <PageContainer>
      <PageHeader
        title="Knowledge"
        description="Answers your assistant can rely on. Anything it couldn't answer shows up under “Unanswered”, so the knowledge base gets better every day."
      />
      <Tabs
        value={tab}
        onChange={(t) => setParams({ tab: t })}
        className="mb-6"
        tabs={[
          { id: 'faqs', label: 'FAQs' },
          { id: 'gaps', label: 'Unanswered questions', count: gaps.data?.gaps.length },
          { id: 'import', label: 'Import from website' },
        ]}
      />
      {tab === 'faqs' && <Faqs />}
      {tab === 'gaps' && <Gaps />}
      {tab === 'import' && <WebsiteImport />}
    </PageContainer>
  );
}

function Faqs() {
  const api = useWsApi();
  const wid = useWid();
  const qc = useQueryClient();
  const toast = useToast();
  const { data, isLoading } = useQuery({ queryKey: ['ws', wid, 'faqs'], queryFn: () => api.get<{ faqs: Faq[] }>('/knowledge/faqs') });
  const [draft, setDraft] = useState({ question: '', answer: '' });
  const [editing, setEditing] = useState<Faq | null>(null);
  const invalidate = () => {
    qc.invalidateQueries({ queryKey: ['ws', wid, 'faqs'] });
    qc.invalidateQueries({ queryKey: ['ws', wid], exact: true });
  };
  const add = useMutation({
    mutationFn: () => api.post('/knowledge/faqs', draft),
    onSuccess: () => {
      setDraft({ question: '', answer: '' });
      invalidate();
    },
    onError: (err) => toast.error(errorMessage(err)),
  });
  const update = useMutation({
    mutationFn: (f: Faq) => api.patch(`/knowledge/faqs/${f.id}`, { question: f.question, answer: f.answer }),
    onSuccess: () => {
      setEditing(null);
      invalidate();
    },
    onError: (err) => toast.error(errorMessage(err)),
  });
  const remove = useMutation({ mutationFn: (id: string) => api.del(`/knowledge/faqs/${id}`), onSuccess: invalidate });

  if (isLoading) return <PageLoader />;
  return (
    <div className="space-y-6">
      <Card title="Add a question and answer">
        <div className="space-y-3">
          <Input placeholder="Question, e.g. Do you deliver outside the city?" value={draft.question} onChange={(e) => setDraft({ ...draft, question: e.target.value })} />
          <Textarea rows={3} placeholder="Answer, exactly as you'd like it explained" value={draft.answer} onChange={(e) => setDraft({ ...draft, answer: e.target.value })} />
          <div className="flex justify-end">
            <Button icon={<Plus className="size-4" />} onClick={() => add.mutate()} loading={add.isPending} disabled={!draft.question.trim() || !draft.answer.trim()}>
              Add FAQ
            </Button>
          </div>
        </div>
      </Card>
      {(data?.faqs.length ?? 0) === 0 ? (
        <EmptyState icon={<BookOpen className="size-6" />} title="No FAQs yet" description="Add the questions customers ask most: delivery, returns, sizes, payment, opening hours…" />
      ) : (
        <div className="divide-y divide-zinc-100 rounded-xl border border-zinc-200 bg-white shadow-xs">
          {data!.faqs.map((f) =>
            editing?.id === f.id ? (
              <div key={f.id} className="space-y-2 p-4">
                <Input value={editing.question} onChange={(e) => setEditing({ ...editing, question: e.target.value })} />
                <Textarea rows={3} value={editing.answer} onChange={(e) => setEditing({ ...editing, answer: e.target.value })} />
                <div className="flex justify-end gap-2">
                  <Button size="sm" variant="ghost" onClick={() => setEditing(null)}>
                    Cancel
                  </Button>
                  <Button size="sm" onClick={() => update.mutate(editing)} loading={update.isPending}>
                    Save
                  </Button>
                </div>
              </div>
            ) : (
              <div key={f.id} className="group flex gap-3 p-4">
                <HelpCircle className="mt-0.5 size-4 shrink-0 text-brand-600" />
                <div className="min-w-0 flex-1">
                  <div className="font-medium text-zinc-900">{f.question}</div>
                  <p className="mt-1 text-sm whitespace-pre-line text-zinc-600">{f.answer}</p>
                </div>
                <div className="flex shrink-0 gap-1 opacity-0 group-hover:opacity-100 focus-within:opacity-100">
                  <IconButton label="Edit" onClick={() => setEditing(f)}>
                    <Pencil className="size-4" />
                  </IconButton>
                  <IconButton label="Delete" onClick={() => confirm('Delete this FAQ?') && remove.mutate(f.id)}>
                    <Trash2 className="size-4" />
                  </IconButton>
                </div>
              </div>
            ),
          )}
        </div>
      )}
    </div>
  );
}

function Gaps() {
  const api = useWsApi();
  const wid = useWid();
  const qc = useQueryClient();
  const toast = useToast();
  const { data, isLoading } = useQuery({ queryKey: ['ws', wid, 'gaps', 'open'], queryFn: () => api.get<{ gaps: Gap[] }>('/knowledge/gaps?status=open') });
  const [answering, setAnswering] = useState<Gap | null>(null);
  const [answer, setAnswer] = useState('');
  const [question, setQuestion] = useState('');
  const invalidate = () => {
    qc.invalidateQueries({ queryKey: ['ws', wid, 'gaps'] });
    qc.invalidateQueries({ queryKey: ['ws', wid, 'faqs'] });
  };
  const resolve = useMutation({
    mutationFn: () => api.post(`/knowledge/gaps/${answering!.id}/resolve`, { answer, question }),
    onSuccess: () => {
      toast.success('Added to your FAQs. The assistant will use it from now on.');
      setAnswering(null);
      invalidate();
    },
    onError: (err) => toast.error(errorMessage(err)),
  });
  const ignore = useMutation({ mutationFn: (id: string) => api.post(`/knowledge/gaps/${id}/ignore`), onSuccess: invalidate });

  if (isLoading) return <PageLoader />;
  if ((data?.gaps.length ?? 0) === 0) {
    return <EmptyState icon={<Check className="size-6" />} title="Nothing unanswered" description="When the assistant can't answer something, the question appears here so you can teach it." />;
  }
  return (
    <>
      <div className="divide-y divide-zinc-100 rounded-xl border border-zinc-200 bg-white shadow-xs">
        {data!.gaps.map((g) => (
          <div key={g.id} className="flex flex-wrap items-center gap-3 p-4">
            <div className="min-w-0 flex-1">
              <div className="font-medium text-zinc-900">{g.question}</div>
              <div className="mt-0.5 text-xs text-zinc-500">
                Asked {g.occurrences} time{g.occurrences === 1 ? '' : 's'} · last {timeAgo(g.updatedAt)}
              </div>
            </div>
            {g.occurrences > 2 && <Badge tone="amber">Popular</Badge>}
            <Button
              size="sm"
              onClick={() => {
                setAnswering(g);
                setQuestion(g.question);
                setAnswer('');
              }}
            >
              Answer
            </Button>
            <IconButton label="Ignore" onClick={() => ignore.mutate(g.id)}>
              <X className="size-4" />
            </IconButton>
          </div>
        ))}
      </div>
      <Modal
        open={Boolean(answering)}
        onClose={() => setAnswering(null)}
        title="Teach your assistant"
        description="This becomes an FAQ the assistant uses for every future customer."
        footer={
          <Button onClick={() => resolve.mutate()} loading={resolve.isPending} disabled={!answer.trim()}>
            Save answer
          </Button>
        }
      >
        <div className="space-y-3">
          <Field label="Question">
            <Input value={question} onChange={(e) => setQuestion(e.target.value)} />
          </Field>
          <Field label="Answer">
            <Textarea rows={4} value={answer} onChange={(e) => setAnswer(e.target.value)} autoFocus />
          </Field>
        </div>
      </Modal>
    </>
  );
}

interface Suggestion {
  business_description: string;
  phone: string;
  email: string;
  address: string;
  shipping_policy: string;
  returns_policy: string;
  payment_info: string;
  faqs: { question: string; answer: string }[];
  items: { type: 'product' | 'service'; name: string; description: string; price: number | null; category: string; image_url: string }[];
  pages_read: string[];
}

function WebsiteImport() {
  const api = useWsApi();
  const wid = useWid();
  const qc = useQueryClient();
  const toast = useToast();
  const currency = useWorkspace().data?.workspace.currency ?? 'USD';
  const [url, setUrl] = useState('');
  const [s, setS] = useState<Suggestion | null>(null);
  const [useProfile, setUseProfile] = useState(true);
  const [faqSel, setFaqSel] = useState<boolean[]>([]);
  const [itemSel, setItemSel] = useState<boolean[]>([]);

  const read = useMutation({
    mutationFn: () => api.post<{ suggestion: Suggestion }>('/knowledge/import-website', { url }),
    onSuccess: ({ suggestion }) => {
      setS(suggestion);
      setFaqSel(suggestion.faqs.map(() => true));
      setItemSel(suggestion.items.map(() => true));
    },
    onError: (err) => toast.error(errorMessage(err)),
  });
  const apply = useMutation({
    mutationFn: () =>
      api.post<{ faqsCreated: number; itemsCreated: number }>('/knowledge/import-website/apply', {
        profile: useProfile
          ? {
              description: s!.business_description,
              phone: s!.phone,
              email: s!.email,
              address: s!.address,
              website: url,
              shipping: s!.shipping_policy,
              returns: s!.returns_policy,
              payment: s!.payment_info,
            }
          : undefined,
        faqs: s!.faqs.filter((_, i) => faqSel[i]),
        items: s!.items.filter((_, i) => itemSel[i]).map((it) => ({ ...it, price: it.price ?? null })),
      }),
    onSuccess: (r) => {
      toast.success(`Saved ${r.faqsCreated} FAQs and ${r.itemsCreated} items`);
      setS(null);
      qc.invalidateQueries({ queryKey: ['ws', wid] });
    },
    onError: (err) => toast.error(errorMessage(err)),
  });

  return (
    <div className="space-y-6">
      <Card title="Read your website" description="We read your homepage and a few key pages (about, FAQ, shipping, products), then draft everything for you to review. Nothing is saved until you confirm.">
        <div className="flex gap-2">
          <div className="relative flex-1">
            <Globe className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-zinc-400" />
            <Input className="pl-9" placeholder="https://yourshop.com" value={url} onChange={(e) => setUrl(e.target.value)} />
          </div>
          <Button onClick={() => read.mutate()} loading={read.isPending} disabled={!url.trim()}>
            Read website
          </Button>
        </div>
        {read.isPending && (
          <p className="mt-3 flex items-center gap-2 text-sm text-zinc-500">
            <Loader2 className="size-4 animate-spin" /> Reading pages and drafting answers… usually under a minute.
          </p>
        )}
      </Card>

      {s && (
        <>
          <Card title="Business details" actions={<Checkbox checked={useProfile} onChange={setUseProfile} label="Use these" />}>
            <dl className="grid gap-x-4 gap-y-2 text-sm sm:grid-cols-[9rem_1fr]">
              {[
                ['About', s.business_description],
                ['Phone', s.phone],
                ['Email', s.email],
                ['Address', s.address],
                ['Shipping', s.shipping_policy],
                ['Returns', s.returns_policy],
                ['Payment', s.payment_info],
              ]
                .filter(([, v]) => v)
                .map(([k, v]) => (
                  <div key={k} className="contents">
                    <dt className="text-zinc-500">{k}</dt>
                    <dd className="text-zinc-800">{v}</dd>
                  </div>
                ))}
            </dl>
            <p className="mt-3 text-xs text-zinc-400">Read: {s.pages_read.join(', ')}</p>
          </Card>
          {s.faqs.length > 0 && (
            <Card title={`FAQs (${faqSel.filter(Boolean).length}/${s.faqs.length} selected)`}>
              <div className="space-y-3">
                {s.faqs.map((f, i) => (
                  <Checkbox
                    key={i}
                    checked={faqSel[i]}
                    onChange={(v) => setFaqSel(faqSel.map((x, idx) => (idx === i ? v : x)))}
                    label={
                      <span>
                        <span className="font-medium">{f.question}</span>
                        <span className="block text-zinc-600">{f.answer}</span>
                      </span>
                    }
                  />
                ))}
              </div>
            </Card>
          )}
          {s.items.length > 0 && (
            <Card title={`Products & services (${itemSel.filter(Boolean).length}/${s.items.length} selected)`}>
              <div className="space-y-2">
                {s.items.map((it, i) => (
                  <Checkbox
                    key={i}
                    checked={itemSel[i]}
                    onChange={(v) => setItemSel(itemSel.map((x, idx) => (idx === i ? v : x)))}
                    label={
                      <span>
                        <span className="font-medium">{it.name}</span> <span className="text-zinc-500">· {it.price === null ? 'no price' : formatMoney(it.price, currency)}</span>
                        {it.description && <span className="block text-xs text-zinc-500">{it.description}</span>}
                      </span>
                    }
                  />
                ))}
              </div>
            </Card>
          )}
          <div className="flex justify-end gap-2">
            <Button variant="secondary" onClick={() => setS(null)}>
              Discard
            </Button>
            <Button onClick={() => apply.mutate()} loading={apply.isPending}>
              Save selected
            </Button>
          </div>
        </>
      )}
    </div>
  );
}
