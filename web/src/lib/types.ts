// API types (mirror the server's JSON).

export type BusinessType = 'ecommerce' | 'services' | 'agency' | 'restaurant' | 'real_estate' | 'education' | 'healthcare' | 'other';
export type Role = 'owner' | 'admin' | 'agent';
export type ChannelType = 'messenger' | 'instagram' | 'whatsapp' | 'telegram' | 'manychat' | 'webchat' | 'playground';
export type LeadStage = 'new' | 'interested' | 'qualified' | 'negotiating' | 'won' | 'lost';
export type OrderStatus = 'new' | 'confirmed' | 'processing' | 'shipped' | 'delivered' | 'cancelled' | 'returned';
export type BookingStatus = 'confirmed' | 'completed' | 'cancelled' | 'no_show';
export type Weekday = 'mon' | 'tue' | 'wed' | 'thu' | 'fri' | 'sat' | 'sun';

export interface TimeRange {
  open: string;
  close: string;
}
export type WeeklyHours = Record<Weekday, TimeRange[]>;

export interface BusinessProfile {
  description: string;
  website?: string;
  phone?: string;
  email?: string;
  address?: string;
  hours: WeeklyHours;
  policies: { shipping?: string; returns?: string; payment?: string; other?: string };
  extraInfo?: string;
}

export interface AISettings {
  enabled: boolean;
  assistantName: string;
  tone: 'friendly' | 'professional' | 'casual' | 'luxury' | 'playful';
  language: string;
  emoji: 'none' | 'light' | 'lots';
  replyDelaySeconds: number;
  goal: string;
  customInstructions: string;
  handoffRules: string;
  leadQuestions: string[];
  followUp: { enabled: boolean; firstAfterMinutes: number; secondAfterMinutes: number };
  pauseAfterHumanMinutes: number;
  pauseAfterHandoffMinutes: number;
}

export interface OrderField {
  key: string;
  label: string;
  required: boolean;
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
  afterOrderMessage?: string;
}
export interface BookingSettings {
  enabled: boolean;
  slotMinutes: number;
  defaultDurationMinutes: number;
  capacityPerSlot: number;
  minNoticeMinutes: number;
  maxDaysAhead: number;
  hours?: WeeklyHours | null;
  afterBookingMessage?: string;
}
export interface ReportSettings {
  dailyEnabled: boolean;
  dailyHour: number;
  weeklyEnabled: boolean;
  extraRecipients: string[];
  alerts: { newOrder: boolean; newBooking: boolean; hotLead: boolean; handoff: boolean };
}

export interface User {
  id: string;
  email: string;
  name: string;
  isSuperadmin: boolean;
}

export interface WorkspaceSummary {
  id: string;
  name: string;
  businessType: BusinessType;
  onboarded: boolean;
  role: Role;
}

export interface AppInfo {
  appName: string;
  aiConfigured: boolean;
  aiMock: boolean;
  model: string;
  transcription: boolean;
  metaConfigured: boolean;
  emailConfigured: boolean;
  signupsEnabled: boolean;
}

export interface Workspace {
  id: string;
  name: string;
  businessType: BusinessType;
  timezone: string;
  currency: string;
  plan: string;
  trialEndsAt: string | null;
  status: 'active' | 'suspended';
  onboardedAt: string | null;
  profile: BusinessProfile;
  ai: AISettings;
  commerce: CommerceSettings;
  booking: BookingSettings;
  reporting: ReportSettings;
  createdAt: string;
}

export interface Plan {
  id: string;
  name: string;
  priceMonthly: number;
  aiRepliesPerMonth: number;
  channels: number;
  seats: number;
  highlights: string[];
}

export interface Usage {
  month: string;
  aiReplies: number;
  aiRuns: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  costUsd: number;
  transcribedSeconds: number;
}

export interface WorkspaceDetail {
  workspace: Workspace;
  role: Role;
  plan: Plan;
  usage: Usage;
  counts: { catalog: number; faqs: number; channels: number };
  checklist: { profile: boolean; catalog: boolean; tested: boolean; channel: boolean };
}

export interface ChannelConfig {
  pageId?: string;
  pageName?: string;
  pictureUrl?: string;
  igUsername?: string;
  wabaId?: string;
  displayPhone?: string;
  verifiedName?: string;
  botUsername?: string;
  widgetTitle?: string;
  widgetColor?: string;
  welcomeMessage?: string;
  allowedOrigins?: string[];
}

export interface Channel {
  id: string;
  type: ChannelType;
  name: string;
  externalId: string;
  status: 'active' | 'error' | 'disconnected';
  statusDetail: string | null;
  config: ChannelConfig;
  aiEnabled: boolean;
  connected: boolean;
  /** ManyChat only: the External Request URL. */
  inboundUrl?: string;
  createdAt: string;
}

export interface LeadInfo {
  intent?: string;
  budget?: string;
  timeline?: string;
  answers?: Record<string, string>;
  lostReason?: string;
}

export interface Contact {
  id: string;
  name: string | null;
  username: string | null;
  phone: string | null;
  email: string | null;
  address: string | null;
  city: string | null;
  avatarUrl: string | null;
  notes: string | null;
  tags: string[];
  stage: LeadStage;
  score: number;
  lead: LeadInfo;
  lastSeenAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface Attachment {
  kind: 'image' | 'audio' | 'video' | 'file' | 'location' | 'sticker';
  url?: string;
  mime?: string;
  name?: string;
  transcript?: string;
  description?: string;
  location?: { lat: number; lng: number; name?: string; address?: string };
  status?: 'pending' | 'ready' | 'failed';
}

export interface Message {
  id: string;
  conversationId: string;
  direction: 'in' | 'out';
  sender: 'customer' | 'ai' | 'human' | 'system';
  senderUserId: string | null;
  text: string | null;
  attachments: Attachment[];
  status: 'received' | 'queued' | 'sent' | 'delivered' | 'read' | 'failed';
  error: string | null;
  createdAt: string;
}

export interface Conversation {
  id: string;
  status: 'open' | 'closed';
  aiPaused: boolean;
  aiPausedUntil: string | null;
  needsHuman: boolean;
  handoffReason: string | null;
  unreadCount: number;
  lastMessageAt: string;
  lastMessagePreview: string | null;
  lastInboundAt: string | null;
  firstResponseMs: number | null;
  summary: string | null;
  createdAt: string;
}

export interface ConversationListItem extends Conversation {
  contact: Pick<Contact, 'id' | 'name' | 'username' | 'avatarUrl' | 'phone' | 'stage' | 'score'>;
  channel: { id: string; type: ChannelType; name: string };
}

export interface CatalogImage {
  url: string;
  description?: string;
}
export interface Variant {
  name: string;
  options: string[];
}

export interface CatalogItem {
  id: string;
  type: 'product' | 'service';
  name: string;
  description: string;
  category: string | null;
  price: number | null;
  salePrice: number | null;
  sku: string | null;
  stock: number | null;
  variants: Variant[];
  durationMinutes: number | null;
  images: CatalogImage[];
  tags: string[];
  attributes: Record<string, string>;
  active: boolean;
  createdAt: string;
}

export interface Faq {
  id: string;
  question: string;
  answer: string;
  active: boolean;
  createdAt: string;
}

export interface Gap {
  id: string;
  question: string;
  status: 'open' | 'resolved' | 'ignored';
  occurrences: number;
  answer: string | null;
  conversationId: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface OrderItem {
  itemId: string | null;
  name: string;
  variant?: string;
  quantity: number;
  unitPrice: number;
  total: number;
}

export interface Order {
  id: string;
  number: number;
  contactId: string | null;
  conversationId: string | null;
  status: OrderStatus;
  items: OrderItem[];
  subtotal: number;
  deliveryFee: number;
  discount: number;
  total: number;
  currency: string;
  customerName: string;
  phone: string;
  email: string | null;
  address: string | null;
  deliveryZone: string | null;
  paymentMethod: string | null;
  notes: string | null;
  extra: Record<string, string>;
  changeRequest: string | null;
  source: 'ai' | 'manual';
  createdAt: string;
}

export interface Booking {
  id: string;
  number: number;
  contactId: string | null;
  conversationId: string | null;
  serviceId: string | null;
  serviceName: string;
  startAt: string;
  endAt: string;
  status: BookingStatus;
  customerName: string;
  phone: string;
  notes: string | null;
  createdAt: string;
}

export interface Stats {
  newConversations: number;
  activeConversations: number;
  inboundMessages: number;
  aiReplies: number;
  humanReplies: number;
  newLeads: number;
  qualifiedLeads: number;
  lostLeads: number;
  orders: number;
  revenue: number;
  avgOrderValue: number;
  bookings: number;
  handoffs: number;
  knowledgeGaps: number;
  followups: number;
  avgFirstResponseSec: number | null;
  conversionRate: number;
  aiHandledRate: number;
  byChannel: { channel: ChannelType; conversations: number }[];
}

export interface Overview {
  range: { from: string; to: string; days: number };
  stats: Stats;
  previous: Stats;
  series: { date: string; conversations: number; orders: number; revenue: number; bookings: number }[];
  items: { mostAskedAbout: { name: string; count: number }[]; bestSellers: { name: string; quantity: number; revenue: number }[] };
  funnel: { stage: string; count: number }[];
  activity: { id: string; type: string; data: Record<string, unknown>; created_at: string; contact_name: string | null; conversation_id: string | null }[];
  attention: {
    needsHuman: { id: string; reason: string | null; lastMessageAt: string; name: string | null; preview: string | null }[];
    openGaps: number;
    orderChanges: number;
    failedMessages: number;
  };
}

export interface Report {
  id: string;
  period: 'daily' | 'weekly' | 'custom';
  label: string;
  periodStart?: string;
  periodEnd?: string;
  stats: Partial<Stats> & Record<string, unknown>;
  summary?: string;
  emailedAt: string | null;
  createdAt: string;
}

export interface Notification {
  id: string;
  type: string;
  title: string;
  body: string | null;
  link: string | null;
  readAt: string | null;
  createdAt: string;
}

export interface ToolCall {
  name: string;
  input: unknown;
  isError?: boolean;
}
