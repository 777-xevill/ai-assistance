import { db } from '../db/index.ts';
import { events } from '../db/schema.ts';
import { logger } from '../lib/logger.ts';

export type EventType =
  | 'conversation_started'
  | 'lead_stage_changed'
  | 'order_created'
  | 'order_change_requested'
  | 'booking_created'
  | 'booking_changed'
  | 'handoff'
  | 'knowledge_gap'
  | 'followup_sent'
  | 'item_viewed'
  | 'ai_paused';

/** Activity log entry. Powers analytics, the activity feed and reports. Never throws. */
export async function logEvent(
  workspaceId: string,
  type: EventType,
  opts: { contactId?: string | null; conversationId?: string | null; data?: Record<string, unknown> } = {},
): Promise<void> {
  try {
    await db.insert(events).values({
      workspaceId,
      type,
      contactId: opts.contactId ?? null,
      conversationId: opts.conversationId ?? null,
      data: opts.data ?? {},
    });
  } catch (err) {
    logger.warn('Could not log event', { type, err });
  }
}
