// Domain types shared across the server. Settings objects are stored as JSONB on the workspace row.

export type BusinessType =
  | 'ecommerce'
  | 'services'
  | 'agency'
  | 'restaurant'
  | 'real_estate'
  | 'education'
  | 'healthcare'
  | 'other';

export type Role = 'owner' | 'admin' | 'agent';

export type ChannelType = 'messenger' | 'instagram' | 'whatsapp' | 'telegram' | 'manychat' | 'webchat' | 'playground';

export type LeadStage = 'new' | 'interested' | 'qualified' | 'negotiating' | 'won' | 'lost';

export type OrderStatus = 'new' | 'confirmed' | 'processing' | 'shipped' | 'delivered' | 'cancelled' | 'returned';

export type BookingStatus = 'confirmed' | 'completed' | 'cancelled' | 'no_show';

export type MessageStatus = 'received' | 'queued' | 'sent' | 'delivered' | 'read' | 'failed';

export type Weekday = 'mon' | 'tue' | 'wed' | 'thu' | 'fri' | 'sat' | 'sun';

export interface TimeRange {
  open: string; // "09:00"
  close: string; // "18:00"
}

export type WeeklyHours = Record<Weekday, TimeRange[]>;

export interface BusinessProfile {
  description: string;
  website?: string;
  phone?: string;
  email?: string;
  address?: string;
  hours: WeeklyHours;
  policies: {
    shipping?: string;
    returns?: string;
    payment?: string;
    other?: string;
  };
  extraInfo?: string;
}

export interface OrderField {
  key: string; // "name", "phone", "address", or a custom key
  label: string;
  required: boolean;
}

export interface AISettings {
  enabled: boolean;
  assistantName: string;
  tone: 'friendly' | 'professional' | 'casual' | 'luxury' | 'playful';
  /** "auto" mirrors the customer's language; otherwise a language name such as "English". */
  language: string;
  emoji: 'none' | 'light' | 'lots';
  /** Extra seconds to wait before replying, on top of simulated typing time. */
  replyDelaySeconds: number;
  /** Primary objective, pre-filled per business type and editable. */
  goal: string;
  customInstructions: string;
  handoffRules: string;
  /** Questions to qualify a lead (agencies, real estate, B2B). */
  leadQuestions: string[];
  followUp: {
    enabled: boolean;
    /** Minutes of customer silence before the first and second follow-up. */
    firstAfterMinutes: number;
    secondAfterMinutes: number;
  };
  /** How long the AI stays quiet after a team member replies (minutes). */
  pauseAfterHumanMinutes: number;
  /** How long the AI stays quiet after it hands a conversation to a human (minutes). */
  pauseAfterHandoffMinutes: number;
}

export interface DeliveryZone {
  id: string;
  name: string;
  fee: number;
  eta?: string;
}

export interface PaymentMethod {
  id: string;
  name: string;
  instructions?: string;
}

export interface CommerceSettings {
  ordersEnabled: boolean;
  orderFields: OrderField[];
  deliveryZones: DeliveryZone[];
  paymentMethods: PaymentMethod[];
  freeDeliveryMinimum?: number | null;
  /** Told to the customer after an order is placed, e.g. "We'll call you to confirm before shipping." */
  afterOrderMessage?: string;
}

export interface BookingSettings {
  enabled: boolean;
  slotMinutes: number;
  defaultDurationMinutes: number;
  capacityPerSlot: number;
  minNoticeMinutes: number;
  maxDaysAhead: number;
  /** Overrides business hours for appointments when set. */
  hours?: WeeklyHours | null;
  afterBookingMessage?: string;
}

export interface ReportSettings {
  dailyEnabled: boolean;
  /** Local hour (0-23) at which the daily report is generated. */
  dailyHour: number;
  weeklyEnabled: boolean;
  /** Extra recipients besides workspace owners/admins. */
  extraRecipients: string[];
  alerts: {
    newOrder: boolean;
    newBooking: boolean;
    hotLead: boolean;
    handoff: boolean;
  };
}

export interface LeadInfo {
  intent?: string;
  budget?: string;
  timeline?: string;
  answers?: Record<string, string>;
  lostReason?: string;
  interestedIn?: string[];
}

export interface Attachment {
  kind: 'image' | 'audio' | 'video' | 'file' | 'location' | 'sticker';
  /** Local media URL (/media/...) once downloaded. */
  url?: string;
  /** Provider URL before download (Messenger/Instagram CDN). */
  remoteUrl?: string;
  /** Provider media id (WhatsApp media id, Telegram file_id). */
  remoteId?: string;
  mime?: string;
  name?: string;
  size?: number;
  /** Speech-to-text transcript for audio. */
  transcript?: string;
  /** AI description for images. */
  description?: string;
  location?: { lat: number; lng: number; name?: string; address?: string };
  status?: 'pending' | 'ready' | 'failed';
}

export interface CatalogImage {
  url: string;
  description?: string;
}

export interface Variant {
  name: string; // "Size"
  options: string[]; // ["S", "M", "L"]
}

export interface OrderItem {
  itemId: string | null;
  name: string;
  variant?: string;
  quantity: number;
  unitPrice: number;
  total: number;
}

export interface ChannelConfig {
  // Meta
  pageId?: string;
  pageName?: string;
  pictureUrl?: string;
  igUsername?: string;
  wabaId?: string;
  displayPhone?: string;
  verifiedName?: string;
  // Telegram
  botUsername?: string;
  webhookSecret?: string;
  // Website chat widget
  widgetTitle?: string;
  widgetColor?: string;
  welcomeMessage?: string;
  allowedOrigins?: string[];
}

export interface ChannelCredentials {
  accessToken?: string; // Page token / WhatsApp business token
  botToken?: string; // Telegram
  apiKey?: string; // ManyChat
}
