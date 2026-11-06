import type { Channel, Contact, Conversation } from '../db/schema.ts';
import type { Attachment } from '../types.ts';

export interface SendResult {
  externalId?: string;
}

export interface ChannelAdapter {
  /** Longest text a single message may carry on this platform. */
  maxTextLength: number;
  sendText(channel: Channel, contact: Contact, text: string, opts?: { conversation?: Conversation; humanAgent?: boolean }): Promise<SendResult>;
  sendImage(channel: Channel, contact: Contact, url: string, caption?: string): Promise<SendResult>;
  /** Shows "typing…" to the customer (best effort). */
  typing?(channel: Channel, contact: Contact, lastInboundExternalId?: string | null): Promise<void>;
  /** Downloads a customer attachment so it can be stored, transcribed or shown to the AI. */
  download?(channel: Channel, attachment: Attachment): Promise<{ data: Buffer; mime: string }>;
  /** Platform messaging-window rules (e.g. WhatsApp's 24h customer service window). */
  canSend?(conversation: Conversation, sender: 'ai' | 'human'): { ok: true } | { ok: false; reason: string };
}

/** Error from a messaging platform. `reconnect` means the stored token no longer works. */
export class ChannelError extends Error {
  status?: number;
  code?: number;
  reconnect: boolean;
  constructor(message: string, opts: { status?: number; code?: number; reconnect?: boolean } = {}) {
    super(message);
    this.status = opts.status;
    this.code = opts.code;
    this.reconnect = opts.reconnect ?? false;
  }
}
