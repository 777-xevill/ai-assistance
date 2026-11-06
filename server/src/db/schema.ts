import { sql } from 'drizzle-orm';
import {
  bigint,
  bigserial,
  boolean,
  doublePrecision,
  index,
  integer,
  jsonb,
  numeric,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import type {
  AISettings,
  Attachment,
  BookingSettings,
  BookingStatus,
  BusinessProfile,
  BusinessType,
  CatalogImage,
  ChannelConfig,
  ChannelType,
  CommerceSettings,
  LeadInfo,
  LeadStage,
  MessageStatus,
  OrderItem,
  OrderStatus,
  ReportSettings,
  Role,
  Variant,
} from '../types.ts';

const tz = { withTimezone: true } as const;
const id = () => uuid('id').primaryKey().defaultRandom();
const createdAt = () => timestamp('created_at', tz).notNull().defaultNow();
const updatedAt = () =>
  timestamp('updated_at', tz)
    .notNull()
    .defaultNow()
    .$onUpdate(() => new Date());
const money = (name: string) => numeric(name, { precision: 12, scale: 2, mode: 'number' });

// ---------------------------------------------------------------------------
// Accounts
// ---------------------------------------------------------------------------

export const users = pgTable(
  'users',
  {
    id: id(),
    email: text('email').notNull(), // always stored lowercase
    name: text('name').notNull(),
    passwordHash: text('password_hash').notNull(),
    isSuperadmin: boolean('is_superadmin').notNull().default(false),
    lastLoginAt: timestamp('last_login_at', tz),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex('users_email_idx').on(t.email)],
);

export const sessions = pgTable(
  'sessions',
  {
    id: id(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    tokenHash: text('token_hash').notNull(),
    expiresAt: timestamp('expires_at', tz).notNull(),
    userAgent: text('user_agent'),
    ip: text('ip'),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex('sessions_token_idx').on(t.tokenHash), index('sessions_user_idx').on(t.userId)],
);

export const passwordResets = pgTable(
  'password_resets',
  {
    id: id(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    tokenHash: text('token_hash').notNull(),
    expiresAt: timestamp('expires_at', tz).notNull(),
    usedAt: timestamp('used_at', tz),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex('password_resets_token_idx').on(t.tokenHash)],
);

// ---------------------------------------------------------------------------
// Workspaces (one per business / tenant)
// ---------------------------------------------------------------------------

export const workspaces = pgTable('workspaces', {
  id: id(),
  name: text('name').notNull(),
  businessType: text('business_type').$type<BusinessType>().notNull().default('ecommerce'),
  timezone: text('timezone').notNull().default('UTC'),
  currency: text('currency').notNull().default('USD'),
  plan: text('plan').notNull().default('trial'),
  trialEndsAt: timestamp('trial_ends_at', tz),
  status: text('status').$type<'active' | 'suspended'>().notNull().default('active'),
  onboardedAt: timestamp('onboarded_at', tz),
  profile: jsonb('profile').$type<BusinessProfile>().notNull(),
  ai: jsonb('ai').$type<AISettings>().notNull(),
  commerce: jsonb('commerce').$type<CommerceSettings>().notNull(),
  booking: jsonb('booking').$type<BookingSettings>().notNull(),
  reporting: jsonb('reporting').$type<ReportSettings>().notNull(),
  orderSeq: integer('order_seq').notNull().default(1000),
  bookingSeq: integer('booking_seq').notNull().default(100),
  /** Bumped whenever settings, catalog or knowledge change; keys the AI prompt cache. */
  knowledgeVersion: integer('knowledge_version').notNull().default(1),
  lastDailyReportOn: text('last_daily_report_on'),
  lastWeeklyReportOn: text('last_weekly_report_on'),
  limitNotifiedMonth: text('limit_notified_month'),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

export const memberships = pgTable(
  'memberships',
  {
    id: id(),
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    role: text('role').$type<Role>().notNull().default('agent'),
    emailAlerts: boolean('email_alerts').notNull().default(true),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex('memberships_ws_user_idx').on(t.workspaceId, t.userId), index('memberships_user_idx').on(t.userId)],
);

export const invites = pgTable(
  'invites',
  {
    id: id(),
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    email: text('email').notNull(),
    role: text('role').$type<Role>().notNull().default('agent'),
    tokenHash: text('token_hash').notNull(),
    invitedBy: uuid('invited_by').references(() => users.id, { onDelete: 'set null' }),
    expiresAt: timestamp('expires_at', tz).notNull(),
    acceptedAt: timestamp('accepted_at', tz),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex('invites_token_idx').on(t.tokenHash), index('invites_ws_idx').on(t.workspaceId)],
);

// ---------------------------------------------------------------------------
// Channels, contacts, conversations, messages
// ---------------------------------------------------------------------------

export const channels = pgTable(
  'channels',
  {
    id: id(),
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    type: text('type').$type<ChannelType>().notNull(),
    name: text('name').notNull(),
    /** Page id, Instagram account id, WhatsApp phone_number_id, Telegram bot id, or widget public key. */
    externalId: text('external_id').notNull(),
    status: text('status').$type<'active' | 'error' | 'disconnected'>().notNull().default('active'),
    statusDetail: text('status_detail'),
    /** Encrypted JSON (ChannelCredentials). */
    credentials: text('credentials'),
    config: jsonb('config').$type<ChannelConfig>().notNull().default({}),
    aiEnabled: boolean('ai_enabled').notNull().default(true),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [uniqueIndex('channels_type_ext_idx').on(t.type, t.externalId), index('channels_ws_idx').on(t.workspaceId)],
);

export const contacts = pgTable(
  'contacts',
  {
    id: id(),
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    channelId: uuid('channel_id')
      .notNull()
      .references(() => channels.id, { onDelete: 'cascade' }),
    /** PSID, IGSID, WhatsApp wa_id, Telegram chat id or widget visitor id. */
    externalId: text('external_id').notNull(),
    name: text('name'),
    username: text('username'),
    phone: text('phone'),
    email: text('email'),
    address: text('address'),
    city: text('city'),
    avatarUrl: text('avatar_url'),
    language: text('language'),
    notes: text('notes'),
    tags: jsonb('tags').$type<string[]>().notNull().default([]),
    stage: text('stage').$type<LeadStage>().notNull().default('new'),
    score: integer('score').notNull().default(0),
    lead: jsonb('lead').$type<LeadInfo>().notNull().default({}),
    isTest: boolean('is_test').notNull().default(false),
    lastSeenAt: timestamp('last_seen_at', tz),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex('contacts_channel_ext_idx').on(t.channelId, t.externalId),
    index('contacts_ws_idx').on(t.workspaceId, t.updatedAt),
  ],
);

export const conversations = pgTable(
  'conversations',
  {
    id: id(),
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    channelId: uuid('channel_id')
      .notNull()
      .references(() => channels.id, { onDelete: 'cascade' }),
    contactId: uuid('contact_id')
      .notNull()
      .references(() => contacts.id, { onDelete: 'cascade' }),
    status: text('status').$type<'open' | 'closed'>().notNull().default('open'),
    aiPaused: boolean('ai_paused').notNull().default(false),
    /** When set, the pause ends automatically at this time. */
    aiPausedUntil: timestamp('ai_paused_until', tz),
    needsHuman: boolean('needs_human').notNull().default(false),
    handoffReason: text('handoff_reason'),
    assignedUserId: uuid('assigned_user_id').references(() => users.id, { onDelete: 'set null' }),
    unreadCount: integer('unread_count').notNull().default(0),
    lastMessageAt: timestamp('last_message_at', tz).notNull().defaultNow(),
    lastMessagePreview: text('last_message_preview'),
    lastInboundAt: timestamp('last_inbound_at', tz),
    lastOutboundAt: timestamp('last_outbound_at', tz),
    firstResponseMs: integer('first_response_ms'),
    /** Rolling summary of messages before summaryUptoAt, used to keep long chats within context. */
    summary: text('summary'),
    summaryUptoAt: timestamp('summary_upto_at', tz),
    followupStep: integer('followup_step').notNull().default(0),
    /** Per-conversation lock so only one AI reply is generated at a time. */
    lockedUntil: timestamp('locked_until', tz),
    isTest: boolean('is_test').notNull().default(false),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex('conversations_contact_idx').on(t.contactId),
    index('conversations_ws_last_idx').on(t.workspaceId, t.lastMessageAt),
  ],
);

export const messages = pgTable(
  'messages',
  {
    id: id(),
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    conversationId: uuid('conversation_id')
      .notNull()
      .references(() => conversations.id, { onDelete: 'cascade' }),
    direction: text('direction').$type<'in' | 'out'>().notNull(),
    sender: text('sender').$type<'customer' | 'ai' | 'human' | 'system'>().notNull(),
    senderUserId: uuid('sender_user_id').references(() => users.id, { onDelete: 'set null' }),
    text: text('text'),
    attachments: jsonb('attachments').$type<Attachment[]>().notNull().default([]),
    externalId: text('external_id'),
    status: text('status').$type<MessageStatus>().notNull().default('received'),
    error: text('error'),
    meta: jsonb('meta').$type<Record<string, unknown>>().notNull().default({}),
    createdAt: createdAt(),
  },
  (t) => [
    index('messages_conv_idx').on(t.conversationId, t.createdAt),
    uniqueIndex('messages_conv_ext_idx').on(t.conversationId, t.externalId),
    index('messages_ext_idx').on(t.externalId),
    index('messages_ws_created_idx').on(t.workspaceId, t.createdAt),
  ],
);

// ---------------------------------------------------------------------------
// Knowledge: catalog (products & services), FAQs, unanswered questions
// ---------------------------------------------------------------------------

export const catalogItems = pgTable(
  'catalog_items',
  {
    id: id(),
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    type: text('type').$type<'product' | 'service'>().notNull().default('product'),
    name: text('name').notNull(),
    description: text('description').notNull().default(''),
    category: text('category'),
    price: money('price'),
    salePrice: money('sale_price'),
    sku: text('sku'),
    /** null = stock not tracked. */
    stock: integer('stock'),
    variants: jsonb('variants').$type<Variant[]>().notNull().default([]),
    durationMinutes: integer('duration_minutes'),
    images: jsonb('images').$type<CatalogImage[]>().notNull().default([]),
    tags: jsonb('tags').$type<string[]>().notNull().default([]),
    attributes: jsonb('attributes').$type<Record<string, string>>().notNull().default({}),
    active: boolean('active').notNull().default(true),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index('catalog_ws_idx').on(t.workspaceId, t.type)],
);

export const knowledgeEntries = pgTable(
  'knowledge_entries',
  {
    id: id(),
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    question: text('question').notNull(),
    answer: text('answer').notNull(),
    active: boolean('active').notNull().default(true),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index('knowledge_ws_idx').on(t.workspaceId)],
);

export const knowledgeGaps = pgTable(
  'knowledge_gaps',
  {
    id: id(),
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    conversationId: uuid('conversation_id').references(() => conversations.id, { onDelete: 'set null' }),
    question: text('question').notNull(),
    status: text('status').$type<'open' | 'resolved' | 'ignored'>().notNull().default('open'),
    occurrences: integer('occurrences').notNull().default(1),
    answer: text('answer'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index('gaps_ws_idx').on(t.workspaceId, t.status)],
);

// ---------------------------------------------------------------------------
// Sales outcomes
// ---------------------------------------------------------------------------

export const orders = pgTable(
  'orders',
  {
    id: id(),
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    number: integer('number').notNull(),
    contactId: uuid('contact_id').references(() => contacts.id, { onDelete: 'set null' }),
    conversationId: uuid('conversation_id').references(() => conversations.id, { onDelete: 'set null' }),
    status: text('status').$type<OrderStatus>().notNull().default('new'),
    items: jsonb('items').$type<OrderItem[]>().notNull(),
    subtotal: money('subtotal').notNull(),
    deliveryFee: money('delivery_fee').notNull().default(0),
    discount: money('discount').notNull().default(0),
    total: money('total').notNull(),
    currency: text('currency').notNull(),
    customerName: text('customer_name').notNull(),
    phone: text('phone').notNull(),
    email: text('email'),
    address: text('address'),
    deliveryZone: text('delivery_zone'),
    paymentMethod: text('payment_method'),
    notes: text('notes'),
    extra: jsonb('extra').$type<Record<string, string>>().notNull().default({}),
    /** A change/cancellation the customer asked for in chat, waiting for the team. */
    changeRequest: text('change_request'),
    source: text('source').$type<'ai' | 'manual'>().notNull().default('ai'),
    isTest: boolean('is_test').notNull().default(false),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [uniqueIndex('orders_ws_number_idx').on(t.workspaceId, t.number), index('orders_ws_created_idx').on(t.workspaceId, t.createdAt)],
);

export const bookings = pgTable(
  'bookings',
  {
    id: id(),
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    number: integer('number').notNull(),
    contactId: uuid('contact_id').references(() => contacts.id, { onDelete: 'set null' }),
    conversationId: uuid('conversation_id').references(() => conversations.id, { onDelete: 'set null' }),
    serviceId: uuid('service_id').references(() => catalogItems.id, { onDelete: 'set null' }),
    serviceName: text('service_name').notNull(),
    startAt: timestamp('start_at', tz).notNull(),
    endAt: timestamp('end_at', tz).notNull(),
    status: text('status').$type<BookingStatus>().notNull().default('confirmed'),
    customerName: text('customer_name').notNull(),
    phone: text('phone').notNull(),
    notes: text('notes'),
    source: text('source').$type<'ai' | 'manual'>().notNull().default('ai'),
    isTest: boolean('is_test').notNull().default(false),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [uniqueIndex('bookings_ws_number_idx').on(t.workspaceId, t.number), index('bookings_ws_start_idx').on(t.workspaceId, t.startAt)],
);

// ---------------------------------------------------------------------------
// Activity, notifications, reports, usage
// ---------------------------------------------------------------------------

export const events = pgTable(
  'events',
  {
    id: id(),
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    type: text('type').notNull(),
    contactId: uuid('contact_id').references(() => contacts.id, { onDelete: 'set null' }),
    conversationId: uuid('conversation_id').references(() => conversations.id, { onDelete: 'set null' }),
    data: jsonb('data').$type<Record<string, unknown>>().notNull().default({}),
    createdAt: createdAt(),
  },
  (t) => [index('events_ws_created_idx').on(t.workspaceId, t.createdAt), index('events_ws_type_idx').on(t.workspaceId, t.type)],
);

export const notifications = pgTable(
  'notifications',
  {
    id: id(),
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    type: text('type').notNull(),
    title: text('title').notNull(),
    body: text('body'),
    link: text('link'),
    readAt: timestamp('read_at', tz),
    createdAt: createdAt(),
  },
  (t) => [index('notifications_ws_idx').on(t.workspaceId, t.createdAt)],
);

export const reports = pgTable(
  'reports',
  {
    id: id(),
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    period: text('period').$type<'daily' | 'weekly' | 'custom'>().notNull(),
    label: text('label').notNull(),
    periodStart: timestamp('period_start', tz).notNull(),
    periodEnd: timestamp('period_end', tz).notNull(),
    stats: jsonb('stats').$type<Record<string, unknown>>().notNull().default({}),
    summary: text('summary').notNull().default(''),
    emailedAt: timestamp('emailed_at', tz),
    createdAt: createdAt(),
  },
  (t) => [index('reports_ws_idx').on(t.workspaceId, t.createdAt)],
);

export const usage = pgTable(
  'usage',
  {
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    month: text('month').notNull(), // YYYY-MM (UTC)
    aiReplies: integer('ai_replies').notNull().default(0),
    aiRuns: integer('ai_runs').notNull().default(0),
    inputTokens: bigint('input_tokens', { mode: 'number' }).notNull().default(0),
    outputTokens: bigint('output_tokens', { mode: 'number' }).notNull().default(0),
    cacheReadTokens: bigint('cache_read_tokens', { mode: 'number' }).notNull().default(0),
    cacheWriteTokens: bigint('cache_write_tokens', { mode: 'number' }).notNull().default(0),
    costUsd: doublePrecision('cost_usd').notNull().default(0),
    transcribedSeconds: integer('transcribed_seconds').notNull().default(0),
  },
  (t) => [primaryKey({ columns: [t.workspaceId, t.month] })],
);

export const aiRuns = pgTable(
  'ai_runs',
  {
    id: id(),
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    conversationId: uuid('conversation_id').references(() => conversations.id, { onDelete: 'set null' }),
    kind: text('kind').notNull(),
    model: text('model').notNull(),
    inputTokens: integer('input_tokens').notNull().default(0),
    outputTokens: integer('output_tokens').notNull().default(0),
    cacheReadTokens: integer('cache_read_tokens').notNull().default(0),
    cacheWriteTokens: integer('cache_write_tokens').notNull().default(0),
    costUsd: doublePrecision('cost_usd').notNull().default(0),
    durationMs: integer('duration_ms').notNull().default(0),
    toolCalls: jsonb('tool_calls').$type<{ name: string; input: unknown; isError?: boolean }[]>().notNull().default([]),
    stopReason: text('stop_reason'),
    error: text('error'),
    createdAt: createdAt(),
  },
  (t) => [index('ai_runs_ws_idx').on(t.workspaceId, t.createdAt), index('ai_runs_conv_idx').on(t.conversationId)],
);

// ---------------------------------------------------------------------------
// Infrastructure
// ---------------------------------------------------------------------------

export const jobs = pgTable(
  'jobs',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    type: text('type').notNull(),
    payload: jsonb('payload').$type<Record<string, unknown>>().notNull().default({}),
    status: text('status').$type<'queued' | 'running' | 'done' | 'failed'>().notNull().default('queued'),
    runAt: timestamp('run_at', tz).notNull().defaultNow(),
    firstQueuedAt: timestamp('first_queued_at', tz).notNull().defaultNow(),
    attempts: integer('attempts').notNull().default(0),
    maxAttempts: integer('max_attempts').notNull().default(5),
    uniqueKey: text('unique_key'),
    lastError: text('last_error'),
    lockedAt: timestamp('locked_at', tz),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    index('jobs_status_run_idx').on(t.status, t.runAt),
    uniqueIndex('jobs_unique_queued_idx').on(t.uniqueKey).where(sql`status = 'queued'`),
  ],
);

export const webhookLogs = pgTable(
  'webhook_logs',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    source: text('source').notNull(),
    payload: jsonb('payload').$type<unknown>().notNull(),
    error: text('error'),
    createdAt: createdAt(),
  },
  (t) => [index('webhook_logs_created_idx').on(t.createdAt)],
);

/** Short-lived state between a Meta login popup and the user choosing which Pages to connect. */
export const oauthSessions = pgTable('oauth_sessions', {
  id: id(),
  workspaceId: uuid('workspace_id')
    .notNull()
    .references(() => workspaces.id, { onDelete: 'cascade' }),
  userId: uuid('user_id')
    .notNull()
    .references(() => users.id, { onDelete: 'cascade' }),
  kind: text('kind').notNull(),
  data: text('data').notNull(), // encrypted JSON
  expiresAt: timestamp('expires_at', tz).notNull(),
  createdAt: createdAt(),
});

export type User = typeof users.$inferSelect;
export type Workspace = typeof workspaces.$inferSelect;
export type Membership = typeof memberships.$inferSelect;
export type Channel = typeof channels.$inferSelect;
export type Contact = typeof contacts.$inferSelect;
export type Conversation = typeof conversations.$inferSelect;
export type Message = typeof messages.$inferSelect;
export type CatalogItem = typeof catalogItems.$inferSelect;
export type KnowledgeEntry = typeof knowledgeEntries.$inferSelect;
export type Order = typeof orders.$inferSelect;
export type Booking = typeof bookings.$inferSelect;
export type Job = typeof jobs.$inferSelect;
