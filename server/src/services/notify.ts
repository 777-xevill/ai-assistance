import { config } from '../config.ts';
import { db } from '../db/index.ts';
import { notifications, type Workspace } from '../db/schema.ts';
import { logger } from '../lib/logger.ts';
import { emailLayout } from '../lib/mailer.ts';
import { escapeHtml } from '../lib/text.ts';
import { enqueue } from '../queue/index.ts';
import type { ReportSettings } from '../types.ts';
import { alertRecipients } from './workspace.ts';

export interface NotifyInput {
  type: 'order' | 'booking' | 'handoff' | 'hot_lead' | 'limit' | 'channel' | 'report' | 'system';
  title: string;
  body?: string;
  /** Dashboard path, e.g. /inbox?c=<id> */
  link?: string;
  /** Which alert toggle controls the email. Without it, `email` decides. */
  alert?: keyof ReportSettings['alerts'];
  email?: boolean;
}

/** Creates an in-app notification and, when enabled, emails the team. Never throws. */
export async function notify(ws: Workspace, input: NotifyInput): Promise<void> {
  try {
    await db.insert(notifications).values({
      workspaceId: ws.id,
      type: input.type,
      title: input.title,
      body: input.body ?? null,
      link: input.link ?? null,
    });
    const wantsEmail = input.alert ? ws.reporting.alerts?.[input.alert] !== false : Boolean(input.email);
    if (!wantsEmail) return;
    const to = await alertRecipients(ws);
    if (to.length === 0) return;
    const bodyHtml = (input.body ?? '')
      .split('\n')
      .map((l) => `<p style="margin:4px 0">${escapeHtml(l)}</p>`)
      .join('');
    await enqueue('mail.send', {
      to,
      subject: `${input.title} · ${ws.name}`,
      html: emailLayout(
        input.title,
        bodyHtml,
        input.link ? { label: 'Open in dashboard', url: `${config.webUrl}/w/${ws.id}${input.link}` } : undefined,
      ),
      text: `${input.title}\n\n${input.body ?? ''}`,
    });
  } catch (err) {
    logger.warn('Notification failed', { err, title: input.title });
  }
}
