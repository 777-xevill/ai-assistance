import type { ChannelType } from '../types.ts';
import { manychatAdapter } from './manychat.ts';
import { instagramAdapter, messengerAdapter } from './meta.ts';
import { telegramAdapter } from './telegram.ts';
import type { ChannelAdapter } from './types.ts';
import { whatsappAdapter } from './whatsapp.ts';

// Website chat and the dashboard playground deliver replies by storing them; the widget polls.
const localAdapter: ChannelAdapter = {
  maxTextLength: 4000,
  async sendText() {
    return {};
  },
  async sendImage() {
    return {};
  },
};

const adapters: Record<ChannelType, ChannelAdapter> = {
  messenger: messengerAdapter,
  instagram: instagramAdapter,
  whatsapp: whatsappAdapter,
  telegram: telegramAdapter,
  manychat: manychatAdapter,
  webchat: localAdapter,
  playground: localAdapter,
};

export function adapterFor(type: ChannelType): ChannelAdapter {
  return adapters[type];
}

export const CHANNEL_LABELS: Record<ChannelType, string> = {
  messenger: 'Facebook Messenger',
  instagram: 'Instagram',
  whatsapp: 'WhatsApp',
  telegram: 'Telegram',
  manychat: 'Facebook, Instagram & WhatsApp (ManyChat)',
  webchat: 'Website chat',
  playground: 'Test chat',
};
