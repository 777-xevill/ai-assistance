import { useQueryClient } from '@tanstack/react-query';
import { ArrowLeft, ArrowRight, Check, Globe, ImagePlus, Loader2, Plug, Plus, Trash2, Upload } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router';
import { ChatTester } from '../components/ChatTester';
import { cleanPayments, cleanZones, HoursEditor, PaymentsEditor, ZonesEditor } from '../components/editors';
import { Button, cx, Field, Input, PageLoader, Select, Textarea, Toggle } from '../components/ui';
import { errorMessage } from '../lib/api';
import { useAuth } from '../lib/auth';
import { BUSINESS_TYPES, CURRENCIES, formatMoney, timezones } from '../lib/format';
import { useToast } from '../lib/toast';
import type { AISettings, BookingSettings, BusinessProfile, BusinessType, CatalogItem, CommerceSettings } from '../lib/types';
import { useWid, useWorkspace, useWsApi } from '../lib/workspace';

const STEPS = ['Your business', 'What you sell', 'Your assistant', 'Test & connect'];

interface Draft {
  name: string;
  businessType: BusinessType;
  timezone: string;
  currency: string;
  profile: BusinessProfile;
  ai: AISettings;
  commerce: CommerceSettings;
  booking: BookingSettings;
}

export default function Onboarding() {
  const wid = useWid();
  const api = useWsApi();
  const qc = useQueryClient();
  const toast = useToast();
  const navigate = useNavigate();
  const { refresh } = useAuth();
  const { data, isLoading } = useWorkspace();
  const [step, setStep] = useState(0);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (data && !draft) {
      const w = data.workspace;
      setDraft({ name: w.name, businessType: w.businessType, timezone: w.timezone, currency: w.currency, profile: w.profile, ai: w.ai, commerce: w.commerce, booking: w.booking });
    }
  }, [data, draft]);

  if (isLoading || !draft || !data) return <PageLoader />;
  const set = (patch: Partial<Draft>) => setDraft({ ...draft, ...patch });

  async function save(next?: number) {
    setSaving(true);
    try {
      await api.patch('/settings', {
        name: draft!.name,
        businessType: draft!.businessType,
        timezone: draft!.timezone,
        currency: draft!.currency,
        profile: draft!.profile,
        ai: draft!.ai,
        commerce: { ...draft!.commerce, deliveryZones: cleanZones(draft!.commerce.deliveryZones), paymentMethods: cleanPayments(draft!.commerce.paymentMethods) },
        booking: draft!.booking,
      });
      await qc.invalidateQueries({ queryKey: ['ws', wid] });
      if (next !== undefined) setStep(next);
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setSaving(false);
    }
  }

  async function finish(to: string) {
    await save();
    await api.post('/onboarding/complete');
    await refresh();
    navigate(`/w/${wid}/${to}`, { replace: true });
  }

  return (
    <div className="min-h-full bg-zinc-50">
      <div className="mx-auto max-w-3xl px-4 py-8">
        <div className="mb-8 flex items-center gap-2">
          <img src="/favicon.svg" alt="" className="size-7" />
          <span className="font-semibold">Set up {draft.name}</span>
          <button onClick={() => finish('dashboard')} className="ml-auto text-sm text-zinc-500 hover:text-zinc-800">
            Skip setup
          </button>
        </div>
        <ol className="mb-8 grid grid-cols-4 gap-2">
          {STEPS.map((s, i) => (
            <li key={s}>
              <div className={cx('h-1.5 rounded-full', i <= step ? 'bg-brand-600' : 'bg-zinc-200')} />
              <div className={cx('mt-2 text-xs font-medium', i === step ? 'text-brand-800' : 'text-zinc-500')}>
                {i + 1}. {s}
              </div>
            </li>
          ))}
        </ol>

        <div className="rounded-2xl border border-zinc-200 bg-white p-6 shadow-sm">
          {step === 0 && <StepBusiness draft={draft} set={set} />}
          {step === 1 && <StepCatalog currency={draft.currency} businessType={draft.businessType} />}
          {step === 2 && <StepAssistant draft={draft} set={set} />}
          {step === 3 && <StepTest businessType={draft.businessType} />}
        </div>

        <div className="mt-6 flex items-center justify-between">
          <Button variant="ghost" icon={<ArrowLeft className="size-4" />} onClick={() => setStep(step - 1)} disabled={step === 0}>
            Back
          </Button>
          {step < 3 ? (
            <Button onClick={() => save(step + 1)} loading={saving} disabled={!draft.name.trim()}>
              Continue <ArrowRight className="size-4" />
            </Button>
          ) : (
            <div className="flex gap-2">
              <Button variant="secondary" onClick={() => finish('dashboard')}>
                Go to dashboard
              </Button>
              <Button icon={<Plug className="size-4" />} onClick={() => finish('channels')}>
                Get my chat link
              </Button>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function StepBusiness({ draft, set }: { draft: Draft; set: (p: Partial<Draft>) => void }) {
  const p = draft.profile;
  const setProfile = (patch: Partial<BusinessProfile>) => set({ profile: { ...p, ...patch } });
  return (
    <div className="space-y-5">
      <div>
        <h2 className="text-lg font-semibold">Tell us about your business</h2>
        <p className="text-sm text-zinc-500">Your assistant uses this to answer customers accurately.</p>
      </div>
      <div className="grid gap-2 sm:grid-cols-2">
        {BUSINESS_TYPES.map((t) => (
          <button
            key={t.id}
            onClick={() => set({ businessType: t.id })}
            className={cx(
              'rounded-xl border p-3 text-left transition-colors',
              draft.businessType === t.id ? 'border-brand-600 bg-brand-50 ring-1 ring-brand-600' : 'border-zinc-200 hover:border-zinc-300',
            )}
          >
            <div className="text-sm font-medium">{t.label}</div>
            <div className="text-xs text-zinc-500">{t.hint}</div>
          </button>
        ))}
      </div>
      <Field label="Business name">
        <Input value={draft.name} onChange={(e) => set({ name: e.target.value })} />
      </Field>
      <Field label="What do you offer?" hint="2-4 sentences: what you sell or do, for whom, and what makes you different.">
        <Textarea rows={3} value={p.description} onChange={(e) => setProfile({ description: e.target.value })} placeholder="We sell handmade cotton dresses and kurtis for women, delivered all over the country…" />
      </Field>
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Phone">
          <Input value={p.phone ?? ''} onChange={(e) => setProfile({ phone: e.target.value })} />
        </Field>
        <Field label="Website or page link">
          <Input value={p.website ?? ''} onChange={(e) => setProfile({ website: e.target.value })} />
        </Field>
        <Field label="Address" className="sm:col-span-2">
          <Input value={p.address ?? ''} onChange={(e) => setProfile({ address: e.target.value })} />
        </Field>
        <Field label="Timezone">
          <Select value={draft.timezone} onChange={(e) => set({ timezone: e.target.value })}>
            {timezones().map((tz) => (
              <option key={tz}>{tz}</option>
            ))}
          </Select>
        </Field>
        <Field label="Currency">
          <Select value={draft.currency} onChange={(e) => set({ currency: e.target.value })}>
            {CURRENCIES.map((c) => (
              <option key={c}>{c}</option>
            ))}
          </Select>
        </Field>
      </div>
    </div>
  );
}

function StepCatalog({ currency, businessType }: { currency: string; businessType: BusinessType }) {
  const api = useWsApi();
  const toast = useToast();
  const [items, setItems] = useState<CatalogItem[]>([]);
  const [form, setForm] = useState({ name: '', price: '', description: '' });
  const [photo, setPhoto] = useState<File | null>(null);
  const [adding, setAdding] = useState(false);
  const [url, setUrl] = useState('');
  const [importing, setImporting] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);
  const csvRef = useRef<HTMLInputElement>(null);
  const isService = ['services', 'agency', 'healthcare', 'education'].includes(businessType);

  const load = () => api.get<{ items: CatalogItem[] }>('/catalog').then((r) => setItems(r.items));
  useEffect(() => {
    load().catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function add() {
    if (!form.name.trim()) return;
    setAdding(true);
    try {
      const { item } = await api.post<{ item: CatalogItem }>('/catalog', {
        type: isService ? 'service' : 'product',
        name: form.name,
        price: form.price ? Number(form.price) : null,
        description: form.description,
      });
      if (photo) {
        const fd = new FormData();
        fd.append('files', photo);
        await api.upload(`/catalog/${item.id}/images`, fd);
      }
      setForm({ name: '', price: '', description: '' });
      setPhoto(null);
      await load();
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setAdding(false);
    }
  }

  async function importSite() {
    if (!url.trim()) return;
    setImporting(true);
    try {
      const { suggestion } = await api.post('/knowledge/import-website', { url });
      await api.post('/knowledge/import-website/apply', {
        profile: {
          description: suggestion.business_description,
          phone: suggestion.phone,
          email: suggestion.email,
          address: suggestion.address,
          shipping: suggestion.shipping_policy,
          returns: suggestion.returns_policy,
          payment: suggestion.payment_info,
        },
        faqs: suggestion.faqs,
        items: suggestion.items,
      });
      toast.success(`Imported ${suggestion.items.length} items and ${suggestion.faqs.length} FAQs. Review them later under Products and Knowledge.`);
      await load();
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setImporting(false);
    }
  }

  async function importCsv(file: File) {
    const fd = new FormData();
    fd.append('file', file);
    try {
      const r = await api.upload<{ created: number }>('/catalog/import-csv', fd);
      toast.success(`Imported ${r.created} items`);
      await load();
    } catch (err) {
      toast.error(errorMessage(err));
    }
  }

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-lg font-semibold">Add what you sell</h2>
        <p className="text-sm text-zinc-500">Add a few {isService ? 'services' : 'products'} now; you can add more later. Photos help the assistant recognise items customers send pictures of.</p>
      </div>

      <div className="rounded-xl border border-brand-200 bg-brand-50/50 p-4">
        <div className="mb-2 flex items-center gap-2 text-sm font-medium text-brand-900">
          <Globe className="size-4" /> Fastest: import from your website
        </div>
        <div className="flex gap-2">
          <Input placeholder="yourshop.com" value={url} onChange={(e) => setUrl(e.target.value)} />
          <Button onClick={importSite} loading={importing} variant="secondary">
            Import
          </Button>
        </div>
        {importing && <p className="mt-2 flex items-center gap-2 text-xs text-brand-800"><Loader2 className="size-3 animate-spin" /> Reading your website… this can take a minute.</p>}
      </div>

      <div className="space-y-3">
        <div className="grid gap-3 sm:grid-cols-[1fr_9rem]">
          <Input placeholder={isService ? 'Service name, e.g. Haircut' : 'Product name, e.g. Red floral dress'} value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
          <Input type="number" min={0} placeholder={`Price (${currency})`} value={form.price} onChange={(e) => setForm({ ...form, price: e.target.value })} />
        </div>
        <Textarea rows={2} placeholder="Short description: material, sizes, what's included…" value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} />
        <div className="flex flex-wrap items-center gap-2">
          <input ref={fileRef} type="file" accept="image/*" hidden onChange={(e) => setPhoto(e.target.files?.[0] ?? null)} />
          <Button variant="secondary" size="sm" icon={<ImagePlus className="size-4" />} onClick={() => fileRef.current?.click()}>
            {photo ? photo.name.slice(0, 24) : 'Add photo'}
          </Button>
          <Button size="sm" icon={<Plus className="size-4" />} onClick={add} loading={adding} disabled={!form.name.trim()}>
            Add
          </Button>
          <span className="mx-1 text-xs text-zinc-400">or</span>
          <input ref={csvRef} type="file" accept=".csv,text/csv" hidden onChange={(e) => e.target.files?.[0] && importCsv(e.target.files[0])} />
          <Button variant="ghost" size="sm" icon={<Upload className="size-4" />} onClick={() => csvRef.current?.click()}>
            Upload a CSV
          </Button>
        </div>
      </div>

      {items.length > 0 && (
        <ul className="divide-y divide-zinc-100 rounded-xl border border-zinc-200">
          {items.map((it) => (
            <li key={it.id} className="flex items-center gap-3 px-3 py-2">
              {it.images[0] ? <img src={it.images[0].url} alt="" className="size-10 rounded-lg object-cover" /> : <div className="size-10 rounded-lg bg-zinc-100" />}
              <div className="min-w-0 flex-1">
                <div className="truncate text-sm font-medium">{it.name}</div>
                <div className="text-xs text-zinc-500">{formatMoney(it.price, currency)}</div>
              </div>
              <button
                className="p-1 text-zinc-400 hover:text-red-600"
                aria-label="Remove"
                onClick={async () => {
                  await api.del(`/catalog/${it.id}`);
                  await load();
                }}
              >
                <Trash2 className="size-4" />
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function StepAssistant({ draft, set }: { draft: Draft; set: (p: Partial<Draft>) => void }) {
  const ai = draft.ai;
  const setAi = (patch: Partial<AISettings>) => set({ ai: { ...ai, ...patch } });
  const c = draft.commerce;
  const b = draft.booking;
  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-lg font-semibold">Your assistant</h2>
        <p className="text-sm text-zinc-500">How it introduces itself and talks to your customers.</p>
      </div>
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Assistant name">
          <Input value={ai.assistantName} onChange={(e) => setAi({ assistantName: e.target.value })} />
        </Field>
        <Field label="Tone">
          <Select value={ai.tone} onChange={(e) => setAi({ tone: e.target.value as AISettings['tone'] })}>
            <option value="friendly">Friendly</option>
            <option value="professional">Professional</option>
            <option value="casual">Casual</option>
            <option value="luxury">Elegant / luxury</option>
            <option value="playful">Playful</option>
          </Select>
        </Field>
        <Field label="Language" hint="“Match the customer” replies in Bangla, English, Banglish… whatever they write.">
          <Select value={ai.language} onChange={(e) => setAi({ language: e.target.value })}>
            <option value="auto">Match the customer</option>
            {['English', 'Bangla', 'Hindi', 'Urdu', 'Arabic', 'Spanish', 'French', 'Indonesian', 'Malay'].map((l) => (
              <option key={l}>{l}</option>
            ))}
          </Select>
        </Field>
        <Field label="Emojis">
          <Select value={ai.emoji} onChange={(e) => setAi({ emoji: e.target.value as AISettings['emoji'] })}>
            <option value="none">None</option>
            <option value="light">A few</option>
            <option value="lots">Lots</option>
          </Select>
        </Field>
      </div>

      <div className="space-y-3 rounded-xl border border-zinc-200 p-4">
        <Toggle checked={c.ordersEnabled} onChange={(v) => set({ commerce: { ...c, ordersEnabled: v } })} label="Take orders in chat" description="The assistant collects name, phone and address, confirms the total and creates the order." />
        {c.ordersEnabled && (
          <div className="space-y-4 pt-2">
            <div>
              <div className="mb-2 text-sm font-medium">Delivery areas and charges</div>
              <ZonesEditor value={c.deliveryZones} onChange={(v) => set({ commerce: { ...c, deliveryZones: v } })} currency={draft.currency} />
            </div>
            <div>
              <div className="mb-2 text-sm font-medium">Payment methods</div>
              <PaymentsEditor value={c.paymentMethods} onChange={(v) => set({ commerce: { ...c, paymentMethods: v } })} />
            </div>
          </div>
        )}
      </div>

      <div className="space-y-3 rounded-xl border border-zinc-200 p-4">
        <Toggle checked={b.enabled} onChange={(v) => set({ booking: { ...b, enabled: v } })} label="Book appointments in chat" description="Only times that are actually free are offered; bookings appear in your dashboard." />
        {b.enabled && (
          <div className="pt-2">
            <div className="mb-2 text-sm font-medium">Opening hours</div>
            <HoursEditor value={draft.profile.hours} onChange={(hours) => set({ profile: { ...draft.profile, hours } })} />
          </div>
        )}
      </div>
    </div>
  );
}

function StepTest({ businessType }: { businessType: BusinessType }) {
  const { data } = useWorkspace();
  const suggestions =
    businessType === 'ecommerce'
      ? ['Do you have this in red?', 'What is the delivery charge?', 'I want to order']
      : businessType === 'agency'
        ? ['How much does a website cost?', 'Can we talk this week?']
        : ['What are your prices?', 'Can I book for tomorrow?'];
  return (
    <div className="space-y-4">
      <div>
        <h2 className="text-lg font-semibold">Try your assistant</h2>
        <p className="text-sm text-zinc-500">Chat as a customer. This is a private test; nothing is sent to anyone.</p>
      </div>
      <ChatTester className="h-[460px]" suggestions={suggestions} />
      <div className="flex items-start gap-2 rounded-xl bg-zinc-50 p-3 text-sm text-zinc-600">
        <Check className="mt-0.5 size-4 shrink-0 text-brand-700" />
        <span>
          Happy with it? Finish setup and you'll get a chat link and QR code. Share them on Facebook, Instagram, WhatsApp or your website and {data?.workspace.ai.assistantName ?? 'your assistant'} starts replying to real customers. Nothing to connect.
        </span>
      </div>
    </div>
  );
}
