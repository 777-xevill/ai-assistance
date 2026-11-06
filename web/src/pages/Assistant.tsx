import { Bot, CalendarDays, ShoppingBag, Target } from 'lucide-react';
import type { ReactNode } from 'react';
import { Link, useSearchParams } from 'react-router';
import { cleanFields, cleanPayments, cleanZones, HoursEditor, OrderFieldsEditor, PaymentsEditor, StringListEditor, ZonesEditor } from '../components/editors';
import { PageContainer } from '../components/Layout';
import { Banner, Card, ErrorState, Field, Input, PageHeader, PageLoader, SaveBar, Segmented, Select, Tabs, Textarea, Toggle } from '../components/ui';
import { minutesLabel } from '../lib/format';
import { useDraft, useSaveSettings } from '../lib/settings';
import type { AISettings, BookingSettings, CommerceSettings, WorkspaceDetail } from '../lib/types';
import { useWid, useWorkspace } from '../lib/workspace';

type TabId = 'behavior' | 'leads' | 'orders' | 'bookings';

const TONES: { id: AISettings['tone']; label: string }[] = [
  { id: 'friendly', label: 'Friendly and warm' },
  { id: 'professional', label: 'Professional' },
  { id: 'casual', label: 'Casual, like a friend' },
  { id: 'luxury', label: 'Elegant and premium' },
  { id: 'playful', label: 'Playful and fun' },
];

/** Options for a minutes select; keeps the current value selectable even if it is not a preset. */
function minuteOptions(presets: number[], current: number, zeroLabel?: string) {
  const values = [...new Set([...presets, current])].sort((a, b) => a - b);
  return values.map((m) => (
    <option key={m} value={m}>
      {m === 0 && zeroLabel ? zeroLabel : minutesLabel(m)}
    </option>
  ));
}

function NumberInput({ value, onChange, min, max, suffix }: { value: number; onChange: (v: number) => void; min?: number; max?: number; suffix?: string }) {
  return (
    <div className="flex items-center gap-2">
      <Input
        type="number"
        className="w-28"
        min={min}
        max={max}
        value={Number.isFinite(value) ? value : ''}
        onChange={(e) => onChange(e.target.value === '' ? 0 : Number(e.target.value))}
      />
      {suffix && <span className="text-sm text-zinc-500">{suffix}</span>}
    </div>
  );
}

function Section({ title, description, children }: { title: string; description?: ReactNode; children: ReactNode }) {
  return (
    <Card title={title} description={description} bodyClassName="space-y-5">
      {children}
    </Card>
  );
}

export default function Assistant() {
  const { data, isLoading, error, refetch } = useWorkspace();
  if (isLoading) return <PageLoader />;
  if (!data) {
    return (
      <PageContainer>
        <ErrorState error={error} retry={() => refetch()} />
      </PageContainer>
    );
  }
  return <AssistantForm detail={data} />;
}

function AssistantForm({ detail }: { detail: WorkspaceDetail }) {
  const wid = useWid();
  const w = detail.workspace;
  const canEdit = detail.role === 'owner' || detail.role === 'admin';
  const [params, setParams] = useSearchParams();
  const tab = (['behavior', 'leads', 'orders', 'bookings'].includes(params.get('tab') ?? '') ? params.get('tab') : 'behavior') as TabId;
  const [draft, setDraft, dirty, reset] = useDraft({ ai: w.ai, commerce: w.commerce, booking: w.booking });
  const save = useSaveSettings('Assistant settings saved');

  const ai = draft.ai;
  const commerce = draft.commerce;
  const booking = draft.booking;
  const setAi = (patch: Partial<AISettings>) => setDraft((d) => ({ ...d, ai: { ...d.ai, ...patch } }));
  const setCommerce = (patch: Partial<CommerceSettings>) => setDraft((d) => ({ ...d, commerce: { ...d.commerce, ...patch } }));
  const setBooking = (patch: Partial<BookingSettings>) => setDraft((d) => ({ ...d, booking: { ...d.booking, ...patch } }));

  function submit() {
    save.mutate({
      ai: { ...ai, leadQuestions: ai.leadQuestions.map((q) => q.trim()).filter(Boolean) },
      commerce: {
        ...commerce,
        orderFields: cleanFields(commerce.orderFields),
        deliveryZones: cleanZones(commerce.deliveryZones),
        paymentMethods: cleanPayments(commerce.paymentMethods),
        afterOrderMessage: commerce.afterOrderMessage?.trim() || undefined,
      },
      booking: { ...booking, afterBookingMessage: booking.afterBookingMessage?.trim() || undefined },
    });
  }

  return (
    <PageContainer>
      <PageHeader
        title="AI assistant"
        description="Decide how your assistant talks, what it aims for, when it hands over to your team, and how it takes orders and bookings."
        actions={
          <Link to={`/w/${wid}/playground`} className="text-sm font-medium text-brand-800 hover:underline">
            Test it in the chat →
          </Link>
        }
      />

      {!canEdit && <Banner tone="zinc">Only owners and admins can change these settings.</Banner>}

      <div className="mt-2 mb-6 rounded-xl border border-zinc-200 bg-white p-4 shadow-xs">
        <Toggle
          checked={ai.enabled}
          onChange={(v) => setAi({ enabled: v })}
          disabled={!canEdit}
          label={ai.enabled ? 'The assistant is answering customers' : 'The assistant is switched off'}
          description={
            ai.enabled
              ? 'New messages on every connected channel get an automatic reply. You can still pause it per conversation from the inbox.'
              : 'Messages still arrive in your inbox, but nobody answers them automatically.'
          }
        />
      </div>

      <Tabs<TabId>
        className="mb-6"
        value={tab}
        onChange={(id) => setParams((p) => (p.set('tab', id), p), { replace: true })}
        tabs={[
          { id: 'behavior', label: <><Bot className="size-4" /> Personality</> },
          { id: 'leads', label: <><Target className="size-4" /> Leads & hand-off</> },
          { id: 'orders', label: <><ShoppingBag className="size-4" /> Orders</> },
          { id: 'bookings', label: <><CalendarDays className="size-4" /> Bookings</> },
        ]}
      />

      <fieldset disabled={!canEdit} className="space-y-6">
        {tab === 'behavior' && (
          <>
            <Section title="Personality" description="How the assistant introduces itself and sounds. It always says it is a virtual assistant if asked.">
              <div className="grid gap-5 sm:grid-cols-2">
                <Field label="Assistant name" hint="Customers see this name when it introduces itself.">
                  <Input value={ai.assistantName} maxLength={40} onChange={(e) => setAi({ assistantName: e.target.value })} />
                </Field>
                <Field label="Tone of voice">
                  <Select value={ai.tone} onChange={(e) => setAi({ tone: e.target.value as AISettings['tone'] })}>
                    {TONES.map((t) => (
                      <option key={t.id} value={t.id}>
                        {t.label}
                      </option>
                    ))}
                  </Select>
                </Field>
                <Field label="Language" hint="“auto” replies in whatever language the customer writes, including mixes like Banglish.">
                  <Input value={ai.language} placeholder="auto" onChange={(e) => setAi({ language: e.target.value })} />
                </Field>
                <Field label="Reply delay" hint="A short pause feels more natural and lets customers finish typing.">
                  <Select value={ai.replyDelaySeconds} onChange={(e) => setAi({ replyDelaySeconds: Number(e.target.value) })}>
                    {[...new Set([0, 3, 5, 10, 20, 30, 60, ai.replyDelaySeconds])]
                      .sort((a, b) => a - b)
                      .map((s) => (
                        <option key={s} value={s}>
                          {s === 0 ? 'Reply right away' : `${s} seconds`}
                        </option>
                      ))}
                  </Select>
                </Field>
              </div>
              <Field label="Emoji">
                <div>
                  <Segmented
                    value={ai.emoji}
                    onChange={(v) => canEdit && setAi({ emoji: v })}
                    options={[
                      { id: 'none', label: 'None' },
                      { id: 'light', label: 'A few' },
                      { id: 'lots', label: 'Lots 🎉' },
                    ]}
                  />
                </div>
              </Field>
            </Section>

            <Section title="Goal and instructions" description="What a successful conversation looks like for your business.">
              <Field label="Main goal" hint="For example: “Help customers pick the right product and place a cash-on-delivery order.”">
                <Textarea rows={3} maxLength={2000} value={ai.goal} onChange={(e) => setAi({ goal: e.target.value })} />
              </Field>
              <Field
                label="Extra instructions"
                hint="Anything else it should always or never do: upsells, phrases to use, topics to avoid, how to handle discounts."
              >
                <Textarea
                  rows={6}
                  maxLength={10000}
                  value={ai.customInstructions}
                  placeholder={'- Always mention our 7-day exchange policy when someone hesitates.\n- Never offer discounts above 10%.\n- Suggest a matching item after an order.'}
                  onChange={(e) => setAi({ customInstructions: e.target.value })}
                />
              </Field>
            </Section>
          </>
        )}

        {tab === 'leads' && (
          <>
            <Section
              title="Qualifying questions"
              description="The assistant works these into the conversation naturally (never as a form) and saves the answers on the lead."
            >
              <StringListEditor
                value={ai.leadQuestions}
                onChange={(v) => setAi({ leadQuestions: v })}
                placeholder="e.g. What is your budget?"
                addLabel="Add question"
              />
            </Section>

            <Section title="Hand-off to your team" description="When the assistant should stop and bring in a person. It always hands off for angry customers and requests for a human.">
              <Field label="Also hand off when…">
                <Textarea
                  rows={3}
                  maxLength={2000}
                  value={ai.handoffRules}
                  placeholder="e.g. Someone asks for a wholesale price, or wants to order more than 10 items."
                  onChange={(e) => setAi({ handoffRules: e.target.value })}
                />
              </Field>
              <div className="grid gap-5 sm:grid-cols-2">
                <Field label="After a hand-off, stay quiet for" hint="Gives your team time to reply. The assistant picks up again afterwards.">
                  <Select value={ai.pauseAfterHandoffMinutes} onChange={(e) => setAi({ pauseAfterHandoffMinutes: Number(e.target.value) })}>
                    {minuteOptions([0, 30, 60, 120, 240, 720, 1440, 10080], ai.pauseAfterHandoffMinutes, "Don't pause")}
                  </Select>
                </Field>
                <Field label="When your team replies, pause the assistant for" hint="So it doesn't talk over a person on your team.">
                  <Select value={ai.pauseAfterHumanMinutes} onChange={(e) => setAi({ pauseAfterHumanMinutes: Number(e.target.value) })}>
                    {minuteOptions([0, 15, 30, 60, 120, 240, 720, 1440], ai.pauseAfterHumanMinutes, "Don't pause")}
                  </Select>
                </Field>
              </div>
            </Section>

            <Section title="Follow-ups" description="Gently re-engage customers who went quiet before ordering or booking. Messaging apps only allow this within 24 hours of their last message.">
              <Toggle checked={ai.followUp.enabled} onChange={(v) => setAi({ followUp: { ...ai.followUp, enabled: v } })} label="Send follow-ups to quiet leads" />
              {ai.followUp.enabled && (
                <div className="grid gap-5 sm:grid-cols-2">
                  <Field label="First follow-up after">
                    <Select value={ai.followUp.firstAfterMinutes} onChange={(e) => setAi({ followUp: { ...ai.followUp, firstAfterMinutes: Number(e.target.value) } })}>
                      {minuteOptions([30, 60, 120, 240, 480, 720], ai.followUp.firstAfterMinutes)}
                    </Select>
                  </Field>
                  <Field label="Second follow-up after" hint="Counted from the customer's last message.">
                    <Select value={ai.followUp.secondAfterMinutes} onChange={(e) => setAi({ followUp: { ...ai.followUp, secondAfterMinutes: Number(e.target.value) } })}>
                      {minuteOptions([0, 240, 480, 720, 1200, 1380], ai.followUp.secondAfterMinutes, 'No second follow-up')}
                    </Select>
                  </Field>
                </div>
              )}
            </Section>
          </>
        )}

        {tab === 'orders' && (
          <>
            <div className="rounded-xl border border-zinc-200 bg-white p-4 shadow-xs">
              <Toggle
                checked={commerce.ordersEnabled}
                onChange={(v) => setCommerce({ ordersEnabled: v })}
                label="Take orders in chat"
                description="The assistant collects the details below, confirms the order summary with the customer, and saves it to Orders."
              />
            </div>
            {commerce.ordersEnabled && (
              <>
                <Section title="Details to collect" description="Name and phone number are always collected.">
                  <OrderFieldsEditor value={commerce.orderFields} onChange={(v) => setCommerce({ orderFields: v })} />
                </Section>
                <Section title="Delivery areas and fees" description="The assistant uses these to quote the delivery charge.">
                  <ZonesEditor value={commerce.deliveryZones} onChange={(v) => setCommerce({ deliveryZones: v })} currency={w.currency} />
                  <Field label="Free delivery on orders above" hint="Leave empty if you never offer free delivery.">
                    <div className="flex items-center gap-2">
                      <Input
                        type="number"
                        min={0}
                        className="w-40"
                        value={commerce.freeDeliveryMinimum ?? ''}
                        onChange={(e) => setCommerce({ freeDeliveryMinimum: e.target.value === '' ? null : Number(e.target.value) })}
                      />
                      <span className="text-sm text-zinc-500">{w.currency}</span>
                    </div>
                  </Field>
                </Section>
                <Section title="Payment methods">
                  <PaymentsEditor value={commerce.paymentMethods} onChange={(v) => setCommerce({ paymentMethods: v })} />
                </Section>
                <Section title="After the order">
                  <Field label="Extra message after an order is placed" hint="Optional. For example how long confirmation takes or how to pay the advance.">
                    <Textarea rows={3} maxLength={1000} value={commerce.afterOrderMessage ?? ''} onChange={(e) => setCommerce({ afterOrderMessage: e.target.value })} />
                  </Field>
                </Section>
              </>
            )}
          </>
        )}

        {tab === 'bookings' && (
          <>
            <div className="rounded-xl border border-zinc-200 bg-white p-4 shadow-xs">
              <Toggle
                checked={booking.enabled}
                onChange={(v) => setBooking({ enabled: v })}
                label="Book appointments in chat"
                description="The assistant checks free times, offers slots, and saves confirmed bookings to Bookings. Service durations come from Products & services."
              />
            </div>
            {booking.enabled && (
              <>
                <Section title="Availability">
                  <div className="grid gap-5 sm:grid-cols-2">
                    <Field label="Offer start times every">
                      <Select value={booking.slotMinutes} onChange={(e) => setBooking({ slotMinutes: Number(e.target.value) })}>
                        {minuteOptions([15, 30, 45, 60, 90, 120], booking.slotMinutes)}
                      </Select>
                    </Field>
                    <Field label="Default appointment length" hint="Used when a service has no duration of its own.">
                      <Select value={booking.defaultDurationMinutes} onChange={(e) => setBooking({ defaultDurationMinutes: Number(e.target.value) })}>
                        {minuteOptions([15, 30, 45, 60, 90, 120, 180, 240], booking.defaultDurationMinutes)}
                      </Select>
                    </Field>
                    <Field label="Customers at the same time" hint="How many bookings can share one time slot (e.g. number of staff or chairs).">
                      <NumberInput value={booking.capacityPerSlot} min={1} max={100} onChange={(v) => setBooking({ capacityPerSlot: v })} />
                    </Field>
                    <Field label="Minimum notice">
                      <Select value={booking.minNoticeMinutes} onChange={(e) => setBooking({ minNoticeMinutes: Number(e.target.value) })}>
                        {minuteOptions([0, 30, 60, 120, 240, 720, 1440, 2880], booking.minNoticeMinutes, 'None')}
                      </Select>
                    </Field>
                    <Field label="Book up to">
                      <NumberInput value={booking.maxDaysAhead} min={1} max={365} suffix="days ahead" onChange={(v) => setBooking({ maxDaysAhead: v })} />
                    </Field>
                  </div>
                </Section>
                <Section title="Booking hours">
                  <Toggle
                    checked={Boolean(booking.hours)}
                    onChange={(v) => setBooking({ hours: v ? structuredClone(w.profile.hours) : null })}
                    label="Use different hours for appointments"
                    description="Off: appointments follow your business opening hours (Settings → Business profile)."
                  />
                  {booking.hours && <HoursEditor value={booking.hours} onChange={(v) => setBooking({ hours: v })} />}
                </Section>
                <Section title="After the booking">
                  <Field label="Extra message after a booking" hint="Optional. For example what to bring or your cancellation policy.">
                    <Textarea rows={3} maxLength={1000} value={booking.afterBookingMessage ?? ''} onChange={(e) => setBooking({ afterBookingMessage: e.target.value })} />
                  </Field>
                </Section>
              </>
            )}
          </>
        )}
      </fieldset>

      <SaveBar dirty={dirty} saving={save.isPending} onSave={submit} onReset={reset} readOnly={!canEdit} />
    </PageContainer>
  );
}
