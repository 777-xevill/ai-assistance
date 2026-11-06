import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { AlertTriangle, CheckCircle2, Code2, Copy, ExternalLink, Info, Lock, Plug, Settings2 } from 'lucide-react';
import { useState } from 'react';
import { ChannelIcon } from '../components/ChannelIcon';
import { ChatLinkCard } from '../components/ChatLinkCard';
import { PageContainer } from '../components/Layout';
import { Badge, Banner, Button, Card, Checkbox, ErrorState, Field, Input, Modal, PageHeader, PageLoader, Textarea, Toggle } from '../components/ui';
import { errorMessage } from '../lib/api';
import { CHANNEL_META } from '../lib/format';
import { loadFacebookSdk, loginForPages, whatsappEmbeddedSignup } from '../lib/meta';
import { useToast } from '../lib/toast';
import type { Channel } from '../lib/types';
import { useWid, useWorkspace, useWsApi } from '../lib/workspace';

interface ChannelsResponse {
  channels: Channel[];
  setup: {
    meta: { configured: boolean; appId: string | null; graphVersion: string; loginConfigId: string | null; whatsappConfigId: string | null };
    appUrl: string;
    publicServer: boolean;
    widgetScript: string;
    chatUrlBase: string;
  };
  limit: number;
}

interface PageOption {
  id: string;
  name: string;
  pictureUrl: string | null;
  messenger: 'available' | 'connected' | 'elsewhere';
  instagram: { id: string; username: string | null; status: 'available' | 'connected' | 'elsewhere' } | null;
}

export default function Channels() {
  const api = useWsApi();
  const wid = useWid();
  const qc = useQueryClient();
  const toast = useToast();
  const key = ['ws', wid, 'channels'];
  const { data, isLoading, error, refetch } = useQuery({ queryKey: key, queryFn: () => api.get<ChannelsResponse>('/channels') });
  const [pages, setPages] = useState<{ sessionId: string; pages: PageOption[] } | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [telegramToken, setTelegramToken] = useState('');
  const [widget, setWidget] = useState<Channel | null>(null);
  const [manualWa, setManualWa] = useState(false);
  const [manychatKey, setManychatKey] = useState('');
  const [manychatSetup, setManychatSetup] = useState<Channel | null>(null);
  const detail = useWorkspace().data;
  const refresh = () => {
    qc.invalidateQueries({ queryKey: key });
    qc.invalidateQueries({ queryKey: ['ws', wid], exact: true });
  };

  const update = useMutation({
    mutationFn: ({ id, body }: { id: string; body: Record<string, unknown> }) => api.patch(`/channels/${id}`, body),
    onSuccess: refresh,
    onError: (err) => toast.error(errorMessage(err)),
  });
  const disconnect = useMutation({
    mutationFn: (id: string) => api.del(`/channels/${id}`),
    onSuccess: () => {
      toast.success('Channel disconnected');
      refresh();
    },
    onError: (err) => toast.error(errorMessage(err)),
  });

  if (isLoading) return <PageLoader />;
  if (error || !data) {
    return (
      <PageContainer>
        <ErrorState error={error} retry={() => refetch()} />
      </PageContainer>
    );
  }
  const meta = data.setup.meta;

  async function connectFacebook() {
    setBusy('facebook');
    try {
      const fb = await loadFacebookSdk(meta.appId!, meta.graphVersion);
      const login = await loginForPages(fb, meta.loginConfigId);
      const res = await api.post<{ sessionId: string; pages: PageOption[] }>('/channels/meta/pages', login);
      setPages(res);
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setBusy(null);
    }
  }

  async function connectWhatsApp() {
    if (!meta.whatsappConfigId) return;
    setBusy('whatsapp');
    try {
      const fb = await loadFacebookSdk(meta.appId!, meta.graphVersion);
      const result = await whatsappEmbeddedSignup(fb, meta.whatsappConfigId);
      const res = await api.post<{ channel: Channel }>('/channels/whatsapp/connect', result);
      toast.success(`${res.channel.name} is connected`);
      refresh();
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setBusy(null);
    }
  }

  async function connectTelegram() {
    setBusy('telegram');
    try {
      await api.post('/channels/telegram', { botToken: telegramToken.trim() });
      setTelegramToken('');
      toast.success('Telegram bot connected');
      refresh();
    } catch (err) {
      toast.error(errorMessage(err));
      refresh();
    } finally {
      setBusy(null);
    }
  }

  async function connectManychat() {
    setBusy('manychat');
    try {
      const res = await api.post<{ channel: Channel }>('/channels/manychat', { apiKey: manychatKey.trim() });
      setManychatKey('');
      toast.success(`${res.channel.name} is connected. One last step in ManyChat.`);
      refresh();
      setManychatSetup(res.channel);
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setBusy(null);
    }
  }

  const chatLink = data?.channels.find((c) => c.type === 'webchat' && c.status === 'active') ?? null;

  async function addWidget() {
    setBusy('webchat');
    try {
      const res = await api.post<{ channel: Channel }>('/channels/webchat', {});
      refresh();
      setWidget(res.channel);
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setBusy(null);
    }
  }

  return (
    <PageContainer>
      <PageHeader
        title="Channels"
        description="Start with your chat link: it works immediately and needs nothing from you. You can add a website chat bubble or a Telegram bot too. We never ask for passwords."
      />

      {chatLink && <ChatLinkCard url={data.setup.chatUrlBase + chatLink.externalId} businessName={detail?.workspace.name ?? 'our business'} onCustomize={() => setWidget(chatLink)} />}

      {!data.setup.publicServer && (
        <div className="mb-6">
          <Banner tone="zinc">
            <span className="flex items-start gap-2">
              <Info className="mt-0.5 size-4 shrink-0" />
              <span>
                This server's address ({data.setup.appUrl}) is not public HTTPS, so Telegram{meta.configured ? ', Facebook, Instagram and WhatsApp' : ''} can't deliver messages to it yet, and the chat link only opens on this computer. The test chat works.
                For local development, expose the server with a tunnel (e.g. ngrok) and set APP_URL.
              </span>
            </span>
          </Banner>
        </div>
      )}

      {data.channels.length > 0 && (
        <Card title="Connected" description={`${data.channels.length} of ${data.limit} channels on your plan`} className="mb-6" bodyClassName="p-0">
          <ul className="divide-y divide-zinc-100">
            {data.channels.map((c) => (
              <li key={c.id} className="flex flex-wrap items-center gap-4 px-5 py-4">
                <ChannelIcon type={c.type} size={36} />
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <span className="truncate font-medium text-zinc-900">{c.name}</span>
                    {c.status === 'active' ? (
                      <Badge tone="green">
                        <CheckCircle2 className="size-3" /> Connected
                      </Badge>
                    ) : (
                      <Badge tone="red">
                        <AlertTriangle className="size-3" /> Needs attention
                      </Badge>
                    )}
                  </div>
                  <div className="truncate text-sm text-zinc-500">
                    {CHANNEL_META[c.type].label}
                    {c.config.pageName && c.type === 'instagram' ? ` · linked to ${c.config.pageName}` : ''}
                    {c.config.displayPhone ? ` · ${c.config.displayPhone}` : ''}
                    {c.config.botUsername ? ` · @${c.config.botUsername}` : ''}
                  </div>
                  {c.statusDetail && <div className="mt-1 text-xs text-red-600">{c.statusDetail}</div>}
                </div>
                <Toggle checked={c.aiEnabled} onChange={(v) => update.mutate({ id: c.id, body: { aiEnabled: v } })} label="AI replies" />
                {c.type === 'manychat' && (
                  <Button size="sm" variant="secondary" icon={<Settings2 className="size-4" />} onClick={() => setManychatSetup(c)}>
                    Setup steps
                  </Button>
                )}
                {c.type === 'webchat' && (
                  <Button size="sm" variant="secondary" icon={<Code2 className="size-4" />} onClick={() => setWidget(c)}>
                    Install & style
                  </Button>
                )}
                <Button size="sm" variant="ghost" className="text-zinc-500" onClick={() => confirm(`Disconnect ${c.name}? Customers on this channel will no longer get replies.`) && disconnect.mutate(c.id)}>
                  Disconnect
                </Button>
              </li>
            ))}
          </ul>
        </Card>
      )}

      <h2 className="mb-3 text-base font-semibold text-zinc-900">More ways to reach customers <span className="font-normal text-zinc-500">(optional)</span></h2>
      <div className="grid gap-4 md:grid-cols-2">
        <Card className="md:col-span-2">
          <div className="flex items-center gap-2">
            <ChannelIcon type="messenger" size={28} />
            <ChannelIcon type="instagram" size={28} />
            <ChannelIcon type="whatsapp" size={28} />
            <h3 className="ml-1 font-semibold">Facebook, Instagram & WhatsApp through ManyChat</h3>
          </div>
          <p className="mt-2 text-sm text-zinc-600">
            Answer DMs inside the business's own Facebook Page, Instagram and WhatsApp. The business connects them in{' '}
            <a href="https://manychat.com" target="_blank" rel="noreferrer" className="font-medium text-brand-800 underline">
              ManyChat
            </a>{' '}
            (already approved by Meta, so no Meta review is needed here), then pastes ManyChat's API key below. Needs ManyChat Pro.
          </p>
          <div className="mt-4 flex gap-2">
            <Input type="password" placeholder="ManyChat → Settings → API → API key" value={manychatKey} onChange={(e) => setManychatKey(e.target.value)} />
            <Button onClick={connectManychat} loading={busy === 'manychat'} disabled={!manychatKey.trim()}>
              Connect
            </Button>
          </div>
        </Card>

        {/* Facebook, Instagram and WhatsApp only appear once the platform owner has a Meta app. Nothing here needs it. */}
        {meta.configured && (
          <>
            <Card>
              <div className="flex items-center gap-2">
                <ChannelIcon type="messenger" size={28} />
                <ChannelIcon type="instagram" size={28} />
                <h3 className="ml-1 font-semibold">Facebook Page & Instagram</h3>
              </div>
              <p className="mt-2 text-sm text-zinc-600">Reply to Messenger and Instagram DMs. Pick which Pages to connect in Facebook's own window. Instagram must be a professional account linked to the Page.</p>
              <div className="mt-4">
                <Button onClick={connectFacebook} loading={busy === 'facebook'} icon={<Lock className="size-4" />}>
                  Continue with Facebook
                </Button>
              </div>
            </Card>

            <Card>
              <div className="flex items-center gap-2">
                <ChannelIcon type="whatsapp" size={28} />
                <h3 className="ml-1 font-semibold">WhatsApp Business</h3>
              </div>
              <p className="mt-2 text-sm text-zinc-600">Connect a WhatsApp Business number through Meta's official sign-up. Use a number that isn't already in the WhatsApp app, or migrate it during sign-up.</p>
              <div className="mt-4 flex flex-wrap items-center gap-3">
                {meta.whatsappConfigId ? (
                  <Button onClick={connectWhatsApp} loading={busy === 'whatsapp'} icon={<Lock className="size-4" />}>
                    Connect WhatsApp
                  </Button>
                ) : (
                  <NotConfigured what="WhatsApp Embedded Signup (META_WA_CONFIG_ID)" />
                )}
                <button onClick={() => setManualWa(true)} className="text-xs text-zinc-500 underline hover:text-zinc-800">
                  Advanced: use an access token
                </button>
              </div>
            </Card>
          </>
        )}

        <Card>
          <div className="flex items-center gap-2">
            <ChannelIcon type="telegram" size={28} />
            <h3 className="ml-1 font-semibold">Telegram</h3>
          </div>
          <p className="mt-2 text-sm text-zinc-600">
            Create a bot with{' '}
            <a href="https://t.me/BotFather" target="_blank" rel="noreferrer" className="font-medium text-brand-800 underline">
              @BotFather
            </a>{' '}
            (send /newbot), then paste the bot token here.
          </p>
          <div className="mt-4 flex gap-2">
            <Input placeholder="123456789:AA..." value={telegramToken} onChange={(e) => setTelegramToken(e.target.value)} />
            <Button onClick={connectTelegram} loading={busy === 'telegram'} disabled={!telegramToken.trim()}>
              Connect
            </Button>
          </div>
        </Card>

        <Card>
          <div className="flex items-center gap-2">
            <ChannelIcon type="webchat" size={28} />
            <h3 className="ml-1 font-semibold">Website chat</h3>
          </div>
          <p className="mt-2 text-sm text-zinc-600">A chat bubble for your website. Visitors can type, send photos and voice notes. Works with any website builder: just paste one line.</p>
          <div className="mt-4">
            <Button variant="secondary" onClick={addWidget} loading={busy === 'webchat'} icon={<Plug className="size-4" />}>
              Add website chat
            </Button>
          </div>
        </Card>
      </div>

      {pages && <PagePicker data={pages} onClose={() => setPages(null)} onDone={refresh} />}
      {widget && <WidgetModal channel={widget} script={data.setup.widgetScript} onClose={() => setWidget(null)} onSaved={refresh} />}
      {manualWa && <ManualWhatsApp onClose={() => setManualWa(false)} onDone={refresh} />}
      {manychatSetup && <ManychatSetup channel={manychatSetup} onClose={() => setManychatSetup(null)} />}
    </PageContainer>
  );
}

function NotConfigured({ what = 'the Meta app (META_APP_ID, META_APP_SECRET)' }: { what?: string }) {
  return (
    <p className="rounded-lg bg-zinc-50 p-3 text-xs text-zinc-600">
      Not available yet on this platform (the host still needs to finish setting up {what}). Your chat link above works in the meantime.
    </p>
  );
}

function PagePicker({ data, onClose, onDone }: { data: { sessionId: string; pages: PageOption[] }; onClose: () => void; onDone: () => void }) {
  const api = useWsApi();
  const toast = useToast();
  const [sel, setSel] = useState<Record<string, { messenger: boolean; instagram: boolean }>>(() =>
    Object.fromEntries(data.pages.map((p) => [p.id, { messenger: p.messenger === 'available', instagram: p.instagram?.status === 'available' }])),
  );
  const connect = useMutation({
    mutationFn: () =>
      api.post<{ connected: Channel[]; errors: { pageId: string; error: string }[] }>('/channels/meta/connect', {
        sessionId: data.sessionId,
        selections: Object.entries(sel)
          .filter(([, v]) => v.messenger || v.instagram)
          .map(([pageId, v]) => ({ pageId, ...v })),
      }),
    onSuccess: (r) => {
      if (r.connected.length) toast.success(`Connected ${r.connected.map((c) => c.name).join(', ')}`);
      for (const e of r.errors) toast.error(e.error);
      onDone();
      onClose();
    },
    onError: (err) => toast.error(errorMessage(err)),
  });
  const statusNote = (s: string) => (s === 'connected' ? 'already connected' : s === 'elsewhere' ? 'connected to another account' : '');
  return (
    <Modal
      open
      onClose={onClose}
      title="Choose what to connect"
      description="Select the Pages (and their Instagram accounts) your assistant should answer."
      footer={
        <Button onClick={() => connect.mutate()} loading={connect.isPending} disabled={!Object.values(sel).some((v) => v.messenger || v.instagram)}>
          Connect selected
        </Button>
      }
    >
      <ul className="space-y-3">
        {data.pages.map((p) => (
          <li key={p.id} className="rounded-xl border border-zinc-200 p-3">
            <div className="mb-2 flex items-center gap-2 font-medium">
              {p.pictureUrl && <img src={p.pictureUrl} alt="" className="size-7 rounded-full" />}
              {p.name}
            </div>
            <div className="space-y-2 pl-1">
              <Checkbox
                checked={sel[p.id]?.messenger ?? false}
                onChange={(v) => p.messenger !== 'elsewhere' && setSel({ ...sel, [p.id]: { ...sel[p.id], messenger: v } })}
                label={
                  <span className="flex items-center gap-2">
                    <ChannelIcon type="messenger" size={16} /> Messenger <span className="text-xs text-zinc-500">{statusNote(p.messenger)}</span>
                  </span>
                }
              />
              {p.instagram ? (
                <Checkbox
                  checked={sel[p.id]?.instagram ?? false}
                  onChange={(v) => p.instagram?.status !== 'elsewhere' && setSel({ ...sel, [p.id]: { ...sel[p.id], instagram: v } })}
                  label={
                    <span className="flex items-center gap-2">
                      <ChannelIcon type="instagram" size={16} /> Instagram {p.instagram.username ? `@${p.instagram.username}` : ''}{' '}
                      <span className="text-xs text-zinc-500">{statusNote(p.instagram.status)}</span>
                    </span>
                  }
                />
              ) : (
                <p className="text-xs text-zinc-500">No Instagram professional account is linked to this Page.</p>
              )}
            </div>
          </li>
        ))}
      </ul>
    </Modal>
  );
}

function WidgetModal({ channel, script, onClose, onSaved }: { channel: Channel; script: string; onClose: () => void; onSaved: () => void }) {
  const api = useWsApi();
  const toast = useToast();
  const [cfg, setCfg] = useState({
    widgetTitle: channel.config.widgetTitle ?? '',
    widgetColor: channel.config.widgetColor ?? '#0f766e',
    welcomeMessage: channel.config.welcomeMessage ?? '',
    allowedOrigins: (channel.config.allowedOrigins ?? []).join('\n'),
  });
  const snippet = `<script src="${script}" data-key="${channel.externalId}" async></script>`;
  const save = useMutation({
    mutationFn: () =>
      api.patch(`/channels/${channel.id}`, {
        config: {
          widgetTitle: cfg.widgetTitle,
          widgetColor: cfg.widgetColor,
          welcomeMessage: cfg.welcomeMessage,
          allowedOrigins: cfg.allowedOrigins.split(/\s+/).map((s) => s.trim()).filter(Boolean),
        },
      }),
    onSuccess: () => {
      toast.success('Website chat saved');
      onSaved();
      onClose();
    },
    onError: (err) => toast.error(errorMessage(err)),
  });
  return (
    <Modal
      open
      onClose={onClose}
      size="lg"
      title="Website chat"
      footer={
        <Button onClick={() => save.mutate()} loading={save.isPending}>
          Save
        </Button>
      }
    >
      <div className="space-y-5">
        <div>
          <div className="mb-1.5 text-sm font-medium">1. Paste this before &lt;/body&gt; on every page of your site</div>
          <div className="flex items-start gap-2 rounded-lg bg-zinc-900 p-3 font-mono text-xs break-all text-zinc-100">
            <span className="flex-1">{snippet}</span>
            <button
              aria-label="Copy"
              className="shrink-0 text-zinc-400 hover:text-white"
              onClick={() => {
                navigator.clipboard.writeText(snippet);
                toast.success('Copied');
              }}
            >
              <Copy className="size-4" />
            </button>
          </div>
          <p className="mt-1 text-xs text-zinc-500">WordPress: use a “header & footer scripts” plugin. Shopify: Online Store → Themes → Edit code → theme.liquid.</p>
        </div>
        <div>
          <div className="mb-2 text-sm font-medium">2. Make it yours</div>
          <div className="grid gap-4 sm:grid-cols-[1fr_9rem]">
            <Field label="Title">
              <Input value={cfg.widgetTitle} onChange={(e) => setCfg({ ...cfg, widgetTitle: e.target.value })} />
            </Field>
            <Field label="Color">
              <div className="flex items-center gap-2">
                <input type="color" value={cfg.widgetColor} onChange={(e) => setCfg({ ...cfg, widgetColor: e.target.value })} className="h-10 w-12 cursor-pointer rounded border border-zinc-300" />
                <Input value={cfg.widgetColor} onChange={(e) => setCfg({ ...cfg, widgetColor: e.target.value })} />
              </div>
            </Field>
            <Field label="Welcome message" className="sm:col-span-2">
              <Input value={cfg.welcomeMessage} onChange={(e) => setCfg({ ...cfg, welcomeMessage: e.target.value })} />
            </Field>
            <Field label="Allowed websites (optional)" hint="One per line, e.g. https://yourshop.com. Leave empty to allow any site." className="sm:col-span-2">
              <Textarea rows={2} value={cfg.allowedOrigins} onChange={(e) => setCfg({ ...cfg, allowedOrigins: e.target.value })} />
            </Field>
          </div>
        </div>
        <a href={`/widget-preview.html?key=${channel.externalId}`} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-sm font-medium text-brand-800 hover:underline">
          <ExternalLink className="size-4" /> Open a preview page
        </a>
        <p className="flex items-center gap-1 text-xs text-zinc-500">
          <Settings2 className="size-3" /> Changes apply to your website within a minute.
        </p>
      </div>
    </Modal>
  );
}

function ManualWhatsApp({ onClose, onDone }: { onClose: () => void; onDone: () => void }) {
  const api = useWsApi();
  const toast = useToast();
  const [form, setForm] = useState({ phoneNumberId: '', wabaId: '', accessToken: '' });
  const save = useMutation({
    mutationFn: () => api.post('/channels/whatsapp/manual', form),
    onSuccess: () => {
      toast.success('WhatsApp connected');
      onDone();
      onClose();
    },
    onError: (err) => toast.error(errorMessage(err)),
  });
  return (
    <Modal
      open
      onClose={onClose}
      title="Connect WhatsApp with an access token"
      description="For testing with Meta's test number or your own Business Manager system user. Most businesses should use “Connect WhatsApp” instead."
      footer={
        <Button onClick={() => save.mutate()} loading={save.isPending} disabled={!form.phoneNumberId || !form.wabaId || !form.accessToken}>
          Connect
        </Button>
      }
    >
      <div className="space-y-3">
        <Field label="Phone number ID">
          <Input value={form.phoneNumberId} onChange={(e) => setForm({ ...form, phoneNumberId: e.target.value })} />
        </Field>
        <Field label="WhatsApp Business Account ID">
          <Input value={form.wabaId} onChange={(e) => setForm({ ...form, wabaId: e.target.value })} />
        </Field>
        <Field label="Access token" hint="A permanent system-user token with whatsapp_business_messaging and whatsapp_business_management.">
          <Input type="password" value={form.accessToken} onChange={(e) => setForm({ ...form, accessToken: e.target.value })} />
        </Field>
      </div>
    </Modal>
  );
}

const MANYCHAT_BODY = `{
  "subscriber_id": "{{Contact Id}}",
  "platform": "instagram",
  "name": "{{Full Name}}",
  "text": "{{Last Text Input}}"
}`;

function CopyBlock({ text }: { text: string }) {
  const toast = useToast();
  return (
    <div className="flex items-start gap-2 rounded-lg bg-zinc-900 p-3 font-mono text-xs text-zinc-100">
      <pre className="min-w-0 flex-1 overflow-x-auto whitespace-pre-wrap break-all">{text}</pre>
      <button
        className="shrink-0 text-zinc-400 hover:text-white"
        onClick={() => {
          navigator.clipboard.writeText(text);
          toast.success('Copied');
        }}
      >
        <Copy className="size-4" />
      </button>
    </div>
  );
}

function ManychatSetup({ channel, onClose }: { channel: Channel; onClose: () => void }) {
  return (
    <Modal open onClose={onClose} title="Finish in ManyChat" description={`Send ${channel.name}'s messages to the assistant. About 5 minutes per app.`}>
      <ol className="list-decimal space-y-4 pl-5 text-sm text-zinc-700">
        <li>In ManyChat, connect the Facebook Page, Instagram account and/or WhatsApp number (Settings → Channels). ManyChat uses Meta's own login window.</li>
        <li>
          Open <b>Automation → Default Reply</b> for each app (Facebook, Instagram, WhatsApp). Remove the existing message so customers don't get two answers, then add an <b>Action → External Request</b>:
          <div className="mt-2 space-y-2">
            <div>
              Method <b>POST</b>, Request URL:
            </div>
            {channel.inboundUrl ? <CopyBlock text={channel.inboundUrl} /> : <p className="text-red-600">Reconnect this channel to get its URL.</p>}
            <div>
              Body (JSON). Insert the three <code>{'{{…}}'}</code> values with ManyChat's field picker, and set <code>platform</code> to <code>facebook</code>, <code>instagram</code> or <code>whatsapp</code> for that app:
            </div>
            <CopyBlock text={MANYCHAT_BODY} />
          </div>
        </li>
        <li>
          Click <b>Test the request</b> in ManyChat. A <code>{'{"ok":true}'}</code> response means it is connected. Publish the flow and send the Page a message from another account.
        </li>
      </ol>
      <p className="mt-4 rounded-lg bg-zinc-50 p-3 text-xs text-zinc-600">
        Optional fields: <code>username</code>, <code>phone</code>, <code>email</code>, <code>image_url</code>, <code>audio_url</code>. Photos and voice notes arrive as a link in Last Text Input and are recognized automatically. As with any Meta inbox, replies can only go out within 24 hours of the customer's last message.
      </p>
    </Modal>
  );
}
