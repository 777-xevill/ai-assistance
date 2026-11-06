import { AlertTriangle, CheckCircle2, Hand, Wrench } from 'lucide-react';
import { useState } from 'react';
import { Link } from 'react-router';
import { ChatTester, type TestDebug } from '../components/ChatTester';
import { PageContainer } from '../components/Layout';
import { Badge, Banner, Card, PageHeader } from '../components/ui';
import { useAuth } from '../lib/auth';
import { formatNumber } from '../lib/format';
import type { BusinessType } from '../lib/types';
import { useWid, useWorkspace } from '../lib/workspace';

const SUGGESTIONS: Record<BusinessType, string[]> = {
  ecommerce: ['Hi, what do you have in stock?', 'How much is delivery?', 'I want to order this'],
  services: ['Do you have a slot tomorrow afternoon?', 'How much is a haircut?', 'Where are you located?'],
  agency: ['How much does a website cost?', 'Can we book a call this week?', 'Do you do social media ads?'],
  restaurant: ['Can I see the menu?', 'Do you deliver to my area?', 'Table for 4 tonight?'],
  real_estate: ['Any 3-bedroom flats for rent?', 'Can I visit this weekend?', "What's the price range?"],
  education: ['What courses do you offer?', 'How much is the fee?', 'When does the next batch start?'],
  healthcare: ['Can I book an appointment?', 'What are your visiting hours?', 'How much is a consultation?'],
  other: ['Hi, can you help me?', 'What are your prices?', 'Where are you located?'],
};

const TOOL_LABELS: Record<string, string> = {
  search_catalog: 'Searched products',
  get_item_details: 'Looked up a product',
  search_faq: 'Checked the knowledge base',
  save_customer_details: 'Saved customer details',
  update_lead: 'Updated the lead',
  quote_order: 'Calculated the order total',
  create_order: 'Placed an order',
  get_my_orders: "Looked up the customer's orders",
  request_order_change: 'Requested an order change',
  check_availability: 'Checked free times',
  book_appointment: 'Booked an appointment',
  manage_booking: 'Changed a booking',
  send_item_photos: 'Sent product photos',
  request_human: 'Handed over to the team',
  log_unanswered_question: "Noted a question it couldn't answer",
};

function DebugPanel({ debug }: { debug: TestDebug | null }) {
  if (!debug) {
    return (
      <Card title="What the assistant did">
        <p className="text-sm text-zinc-500">
          After each reply you'll see which actions the assistant took (searching products, saving details, placing orders) and what the reply cost.
        </p>
      </Card>
    );
  }
  const u = debug.usage;
  return (
    <Card title="What the assistant did" description={`Reply took ${(debug.durationMs / 1000).toFixed(1)}s`}>
      <div className="space-y-4">
        {(debug.handoff || debug.noReply) && (
          <div className="flex flex-wrap gap-2">
            {debug.handoff && (
              <Badge tone="amber">
                <Hand className="size-3" /> Handed off to your team
              </Badge>
            )}
            {debug.noReply && <Badge tone="zinc">Chose not to reply</Badge>}
          </div>
        )}
        {debug.toolCalls.length === 0 ? (
          <p className="text-sm text-zinc-500">Answered directly, without any actions.</p>
        ) : (
          <ol className="space-y-2">
            {debug.toolCalls.map((t, i) => (
              <li key={i} className="rounded-lg border border-zinc-200 p-2.5">
                <div className="flex items-center gap-2 text-sm font-medium text-zinc-800">
                  {t.isError ? <AlertTriangle className="size-4 text-amber-600" /> : t.name === 'create_order' || t.name === 'book_appointment' ? <CheckCircle2 className="size-4 text-emerald-600" /> : <Wrench className="size-4 text-zinc-400" />}
                  {TOOL_LABELS[t.name] ?? t.name}
                  {t.isError && <span className="text-xs font-normal text-amber-700">(failed)</span>}
                </div>
                <details className="mt-1">
                  <summary className="cursor-pointer text-xs text-zinc-500">Details</summary>
                  <pre className="scroll-thin mt-1 max-h-48 overflow-auto rounded bg-zinc-50 p-2 text-xs text-zinc-700">{JSON.stringify(t.input, null, 2)}</pre>
                </details>
              </li>
            ))}
          </ol>
        )}
        <dl className="grid grid-cols-2 gap-x-4 gap-y-1 border-t border-zinc-100 pt-3 text-xs text-zinc-500">
          <dt>Model</dt>
          <dd className="text-right text-zinc-700">{u.model}</dd>
          <dt>Tokens in / out</dt>
          <dd className="text-right text-zinc-700 tabular-nums">
            {formatNumber(u.inputTokens + u.cacheReadTokens + u.cacheWriteTokens)} / {formatNumber(u.outputTokens)}
          </dd>
          <dt>From cache</dt>
          <dd className="text-right text-zinc-700 tabular-nums">{formatNumber(u.cacheReadTokens)}</dd>
          <dt>Cost of this reply</dt>
          <dd className="text-right font-medium text-zinc-800 tabular-nums">${debug.costUsd.toFixed(4)}</dd>
        </dl>
      </div>
    </Card>
  );
}

export default function Playground() {
  const wid = useWid();
  const { app } = useAuth();
  const { data } = useWorkspace();
  const [debug, setDebug] = useState<TestDebug | null>(null);
  const type = data?.workspace.businessType ?? 'other';

  return (
    <PageContainer wide>
      <PageHeader
        title="Test chat"
        description="Chat with your assistant exactly as a customer would. Orders and bookings made here are marked as tests and don't count in your reports."
      />
      <div className="mb-4 space-y-3">
        {app && !app.aiConfigured && !app.aiMock && (
          <Banner tone="red">The AI is not connected yet: the server needs an AI key (GROQ_API_KEY for the free Groq tier, or ANTHROPIC_API_KEY).</Banner>
        )}
        {app?.aiMock && <Banner tone="zinc">Demo mode: replies are simulated. Add an AI key (GROQ_API_KEY or ANTHROPIC_API_KEY) on the server for real answers.</Banner>}
        {app && !app.transcription && <Banner tone="zinc">Voice messages can't be transcribed until a speech-to-text provider is configured on the server.</Banner>}
        {data && !data.workspace.ai.enabled && (
          <Banner tone="amber" action={<Link to={`/w/${wid}/assistant`} className="text-sm font-medium underline">Turn it on</Link>}>
            The assistant is switched off for real customers. Test chat still works.
          </Banner>
        )}
      </div>
      <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_22rem]">
        <ChatTester className="h-[70vh] min-h-[480px]" onDebug={setDebug} suggestions={SUGGESTIONS[type]} />
        <div className="space-y-4">
          <DebugPanel debug={debug} />
          <Card title="Not quite right?">
            <ul className="space-y-2 text-sm text-zinc-600">
              <li>
                Wrong or missing answers → add them in{' '}
                <Link to={`/w/${wid}/knowledge`} className="font-medium text-brand-800 hover:underline">Knowledge</Link> or{' '}
                <Link to={`/w/${wid}/catalog`} className="font-medium text-brand-800 hover:underline">Products & services</Link>.
              </li>
              <li>
                Tone, goals or hand-off rules → adjust the{' '}
                <Link to={`/w/${wid}/assistant`} className="font-medium text-brand-800 hover:underline">AI assistant</Link> settings.
              </li>
            </ul>
          </Card>
        </div>
      </div>
    </PageContainer>
  );
}
