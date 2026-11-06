import { z } from 'zod';
import { BUSINESS_TYPES } from '../lib/defaults.ts';
import type { BusinessType } from '../types.ts';

// Validation for the JSONB settings objects on a workspace.

const hhmm = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'Use HH:MM (24-hour)');
const timeRange = z.object({ open: hhmm, close: hhmm }).refine((r) => r.open < r.close, 'Closing time must be after opening time');
const day = z.array(timeRange).max(4);
export const weeklyHoursSchema = z.object({ mon: day, tue: day, wed: day, thu: day, fri: day, sat: day, sun: day });

const optText = (max: number) => z.string().trim().max(max).optional();

export const profileSchema = z.object({
  description: z.string().trim().max(5000).default(''),
  website: optText(300),
  phone: optText(60),
  email: optText(200),
  address: optText(500),
  hours: weeklyHoursSchema,
  policies: z.object({
    shipping: optText(5000),
    returns: optText(5000),
    payment: optText(5000),
    other: optText(5000),
  }),
  extraInfo: optText(20000),
});

export const aiSchema = z.object({
  enabled: z.boolean(),
  assistantName: z.string().trim().min(1).max(40),
  tone: z.enum(['friendly', 'professional', 'casual', 'luxury', 'playful']),
  language: z.string().trim().min(1).max(40),
  emoji: z.enum(['none', 'light', 'lots']),
  replyDelaySeconds: z.number().min(0).max(120),
  goal: z.string().trim().max(2000),
  customInstructions: z.string().max(10000),
  handoffRules: z.string().max(2000),
  leadQuestions: z.array(z.string().trim().min(1).max(300)).max(15),
  followUp: z.object({
    enabled: z.boolean(),
    firstAfterMinutes: z.number().int().min(0).max(1380),
    secondAfterMinutes: z.number().int().min(0).max(1380),
  }),
  pauseAfterHumanMinutes: z.number().int().min(0).max(10080),
  pauseAfterHandoffMinutes: z.number().int().min(0).max(10080),
});

const id = z.string().trim().min(1).max(40).regex(/^[a-z0-9_-]+$/i, 'Use letters, numbers, - or _');

export const commerceSchema = z.object({
  ordersEnabled: z.boolean(),
  orderFields: z
    .array(z.object({ key: z.string().trim().regex(/^[a-z0-9_]{1,40}$/, 'Keys use lowercase letters, numbers and _'), label: z.string().trim().min(1).max(80), required: z.boolean() }))
    .max(15),
  deliveryZones: z.array(z.object({ id, name: z.string().trim().min(1).max(80), fee: z.number().min(0), eta: optText(80) })).max(30),
  paymentMethods: z.array(z.object({ id, name: z.string().trim().min(1).max(80), instructions: optText(1000) })).max(15),
  freeDeliveryMinimum: z.number().min(0).nullable().optional(),
  afterOrderMessage: optText(1000),
});

export const bookingSchema = z.object({
  enabled: z.boolean(),
  slotMinutes: z.number().int().min(5).max(240),
  defaultDurationMinutes: z.number().int().min(5).max(600),
  capacityPerSlot: z.number().int().min(1).max(100),
  minNoticeMinutes: z.number().int().min(0).max(10080),
  maxDaysAhead: z.number().int().min(1).max(365),
  hours: weeklyHoursSchema.nullable().optional(),
  afterBookingMessage: optText(1000),
});

export const reportingSchema = z.object({
  dailyEnabled: z.boolean(),
  dailyHour: z.number().int().min(0).max(23),
  weeklyEnabled: z.boolean(),
  extraRecipients: z.array(z.string().trim().toLowerCase().email()).max(10),
  alerts: z.object({ newOrder: z.boolean(), newBooking: z.boolean(), hotLead: z.boolean(), handoff: z.boolean() }),
});

export const businessTypeSchema = z.enum(BUSINESS_TYPES.map((t) => t.id) as [BusinessType, ...BusinessType[]]);
