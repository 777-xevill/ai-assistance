import type { BookingStatus, BusinessType, ChannelType, LeadStage, OrderStatus } from './types';

export function formatMoney(amount: number | null | undefined, currency: string): string {
  if (amount === null || amount === undefined) return '—';
  try {
    return new Intl.NumberFormat(undefined, {
      style: 'currency',
      currency,
      currencyDisplay: 'narrowSymbol',
      minimumFractionDigits: Number.isInteger(amount) ? 0 : 2,
      maximumFractionDigits: 2,
    }).format(amount);
  } catch {
    return `${currency} ${amount}`;
  }
}

export function formatNumber(n: number): string {
  return new Intl.NumberFormat().format(n);
}

export function formatDate(iso: string | Date, opts: Intl.DateTimeFormatOptions = { month: 'short', day: 'numeric', year: 'numeric' }): string {
  return new Intl.DateTimeFormat(undefined, opts).format(new Date(iso));
}

export function formatDateTime(iso: string | Date): string {
  return new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }).format(new Date(iso));
}

export function formatTime(iso: string | Date): string {
  return new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit' }).format(new Date(iso));
}

/** "now", "5m", "3h", "Yesterday", "Mon", "Oct 12" */
export function timeAgo(iso: string | Date): string {
  const d = new Date(iso);
  const diff = (Date.now() - d.getTime()) / 1000;
  if (diff < 60) return 'now';
  if (diff < 3600) return `${Math.floor(diff / 60)}m`;
  if (diff < 86400 && new Date().getDate() === d.getDate()) return `${Math.floor(diff / 3600)}h`;
  if (diff < 2 * 86400) return 'Yesterday';
  if (diff < 7 * 86400) return new Intl.DateTimeFormat(undefined, { weekday: 'short' }).format(d);
  return new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric' }).format(d);
}

export function initials(name: string | null | undefined): string {
  const parts = (name ?? '').trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return '?';
  return (parts[0][0] + (parts.length > 1 ? parts[parts.length - 1][0] : '')).toUpperCase();
}

export const BUSINESS_TYPES: { id: BusinessType; label: string; hint: string }[] = [
  { id: 'ecommerce', label: 'Online store', hint: 'Sell products and take orders in chat' },
  { id: 'services', label: 'Salon, spa or local service', hint: 'Answer questions and book appointments' },
  { id: 'agency', label: 'Agency or B2B', hint: 'Qualify leads and book discovery calls' },
  { id: 'restaurant', label: 'Restaurant or food', hint: 'Menu questions, food orders and reservations' },
  { id: 'real_estate', label: 'Real estate', hint: 'Qualify buyers and book viewings' },
  { id: 'education', label: 'Education or coaching', hint: 'Explain courses and enrol students' },
  { id: 'healthcare', label: 'Clinic or healthcare', hint: 'Answer general questions and book visits' },
  { id: 'other', label: 'Something else', hint: 'Answer questions and capture leads' },
];

export const CHANNEL_META: Record<ChannelType, { label: string; color: string }> = {
  messenger: { label: 'Messenger', color: '#0866FF' },
  instagram: { label: 'Instagram', color: '#E1306C' },
  whatsapp: { label: 'WhatsApp', color: '#25D366' },
  telegram: { label: 'Telegram', color: '#229ED9' },
  manychat: { label: 'Facebook · Instagram · WhatsApp', color: '#4F46E5' },
  webchat: { label: 'Website', color: '#0f766e' },
  playground: { label: 'Test chat', color: '#71717a' },
};

export type Tone = 'zinc' | 'brand' | 'green' | 'amber' | 'red' | 'blue' | 'violet';

export const STAGE_META: Record<LeadStage, { label: string; tone: Tone }> = {
  new: { label: 'New', tone: 'zinc' },
  interested: { label: 'Interested', tone: 'blue' },
  qualified: { label: 'Qualified', tone: 'amber' },
  negotiating: { label: 'Negotiating', tone: 'violet' },
  won: { label: 'Won', tone: 'green' },
  lost: { label: 'Lost', tone: 'red' },
};

export const ORDER_STATUS_META: Record<OrderStatus, { label: string; tone: Tone }> = {
  new: { label: 'New', tone: 'blue' },
  confirmed: { label: 'Confirmed', tone: 'brand' },
  processing: { label: 'Processing', tone: 'amber' },
  shipped: { label: 'Shipped', tone: 'violet' },
  delivered: { label: 'Delivered', tone: 'green' },
  cancelled: { label: 'Cancelled', tone: 'red' },
  returned: { label: 'Returned', tone: 'zinc' },
};

export const BOOKING_STATUS_META: Record<BookingStatus, { label: string; tone: Tone }> = {
  confirmed: { label: 'Confirmed', tone: 'brand' },
  completed: { label: 'Completed', tone: 'green' },
  cancelled: { label: 'Cancelled', tone: 'red' },
  no_show: { label: 'No-show', tone: 'zinc' },
};

const REGION_CURRENCY: Record<string, string> = {
  BD: 'BDT', IN: 'INR', PK: 'PKR', LK: 'LKR', NP: 'NPR', US: 'USD', GB: 'GBP', CA: 'CAD', AU: 'AUD', NZ: 'NZD',
  AE: 'AED', SA: 'SAR', QA: 'QAR', KW: 'KWD', OM: 'OMR', BH: 'BHD', MY: 'MYR', SG: 'SGD', ID: 'IDR', PH: 'PHP',
  TH: 'THB', VN: 'VND', NG: 'NGN', KE: 'KES', ZA: 'ZAR', EG: 'EGP', TR: 'TRY', BR: 'BRL', MX: 'MXN', JP: 'JPY',
  DE: 'EUR', FR: 'EUR', IT: 'EUR', ES: 'EUR', NL: 'EUR', IE: 'EUR', PT: 'EUR', BE: 'EUR', AT: 'EUR', FI: 'EUR',
};

const TZ_CURRENCY: Record<string, string> = { 'Asia/Dhaka': 'BDT', 'Asia/Kolkata': 'INR', 'Asia/Calcutta': 'INR', 'Asia/Karachi': 'PKR', 'Asia/Dubai': 'AED' };

export function guessTimezone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  } catch {
    return 'UTC';
  }
}

export function guessCurrency(): string {
  const tz = guessTimezone();
  if (TZ_CURRENCY[tz]) return TZ_CURRENCY[tz];
  const region = (navigator.language.split('-')[1] ?? '').toUpperCase();
  return REGION_CURRENCY[region] ?? 'USD';
}

export const CURRENCIES = ['BDT', 'USD', 'EUR', 'GBP', 'INR', 'PKR', 'AED', 'SAR', 'MYR', 'SGD', 'IDR', 'PHP', 'NGN', 'KES', 'ZAR', 'CAD', 'AUD', 'LKR', 'NPR', 'THB', 'VND', 'TRY', 'EGP', 'QAR', 'KWD', 'JPY', 'BRL', 'MXN'];

export function timezones(): string[] {
  try {
    return (Intl as unknown as { supportedValuesOf(k: string): string[] }).supportedValuesOf('timeZone');
  } catch {
    return ['UTC', 'Asia/Dhaka', 'Asia/Kolkata', 'Asia/Dubai', 'Europe/London', 'America/New_York'];
  }
}

export function minutesLabel(m: number): string {
  if (m < 60) return `${m} min`;
  if (m % 60 === 0) return `${m / 60} h`;
  return `${Math.floor(m / 60)} h ${m % 60} min`;
}
