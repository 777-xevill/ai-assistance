import { and, desc, eq, isNotNull, lt, or, sql } from 'drizzle-orm';
import { describeImage } from '../ai/vision.ts';
import { processManychatMessage, processMetaWebhook, processTelegramUpdate } from '../channels/webhooks.ts';
import { db } from '../db/index.ts';
import {
  catalogItems,
  channels,
  jobs,
  messages,
  oauthSessions,
  passwordResets,
  sessions,
  webhookLogs,
  workspaces,
} from '../db/schema.ts';
import { logger } from '../lib/logger.ts';
import { sendMail, type MailInput } from '../lib/mailer.ts';
import { safeFetch } from '../lib/safe-fetch.ts';
import { saveMedia } from '../lib/storage.ts';
import { localDateStr, zonedParts } from '../lib/time.ts';
import { enqueue, registerJob } from '../queue/index.ts';
import { updateMessage } from '../services/conversations.ts';
import { processMessageMedia } from '../services/media.ts';
import { generateReport } from '../services/reports.ts';
import { bumpKnowledge, getWorkspace } from '../services/workspace.ts';
import { handleFollowupJob, handleReplyJob, maybeSummarize } from './reply.ts';

export function registerJobs(): void {
  registerJob('webhook.meta', async ({ body }: { body: unknown }) => {
    await processMetaWebhook(body);
  });

  registerJob('webhook.telegram', async ({ channelId, update }: { channelId: string; update: any }) => {
    const [channel] = await db.select().from(channels).where(eq(channels.id, channelId)).limit(1);
    if (channel && channel.status === 'active') await processTelegramUpdate(channel, update);
  });

  registerJob('webhook.manychat', async ({ channelId, payload }: { channelId: string; payload: any }) => {
    const [channel] = await db.select().from(channels).where(eq(channels.id, channelId)).limit(1);
    if (channel && channel.status === 'active') await processManychatMessage(channel, payload);
  });

  registerJob('conversation.reply', handleReplyJob);
  registerJob('conversation.followup', handleFollowupJob);

  registerJob('message.media', async ({ messageId }: { messageId: string }) => {
    await processMessageMedia(messageId);
  });

  registerJob('conversation.summarize', async ({ conversationId }: { conversationId: string }) => {
    await maybeSummarize(conversationId);
  });

  // Short descriptions of customer photos keep older images in the AI's context cheaply.
  registerJob('conversation.describe_images', async ({ conversationId }: { conversationId: string }) => {
    const rows = await db
      .select()
      .from(messages)
      .where(and(eq(messages.conversationId, conversationId), eq(messages.direction, 'in')))
      .orderBy(desc(messages.createdAt))
      .limit(10);
    for (const m of rows) {
      if (!m.attachments.some((a) => a.kind === 'image' && a.status === 'ready' && a.url && !a.description)) continue;
      const next = [];
      for (const a of m.attachments) {
        if (a.kind === 'image' && a.status === 'ready' && a.url && !a.description) {
          const description = await describeImage(m.workspaceId, a.url, 'customer', { conversationId });
          next.push(description ? { ...a, description } : a);
        } else next.push(a);
      }
      await updateMessage(m.id, { attachments: next });
    }
  });

  // Catalog photos get visual descriptions so customer photos can be matched by search.
  registerJob('catalog.describe', async ({ itemId }: { itemId: string }) => {
    const [item] = await db.select().from(catalogItems).where(eq(catalogItems.id, itemId)).limit(1);
    if (!item) return;
    let changed = false;
    const images = [];
    for (const img of item.images) {
      if (!img.description) {
        const description = await describeImage(item.workspaceId, img.url, 'product', { productName: item.name });
        if (description) changed = true;
        images.push(description ? { ...img, description } : img);
      } else images.push(img);
    }
    if (changed) {
      await db.update(catalogItems).set({ images }).where(eq(catalogItems.id, itemId));
      await bumpKnowledge(item.workspaceId);
    }
  });

  // CSV imports reference image URLs; download them in the background.
  registerJob('catalog.fetch_images', async ({ itemId, urls }: { itemId: string; urls: string[] }) => {
    const [item] = await db.select().from(catalogItems).where(eq(catalogItems.id, itemId)).limit(1);
    if (!item) return;
    const images = [...item.images];
    for (const url of urls.slice(0, 6)) {
      try {
        const file = await safeFetch(url, { maxBytes: 15 * 1024 * 1024, timeoutMs: 20_000 });
        const saved = await saveMedia(item.workspaceId, file.data, file.mime, { optimizeImage: true });
        images.push({ url: saved.url });
      } catch (err) {
        logger.warn('Could not import catalog image', { url, err });
      }
    }
    await db.update(catalogItems).set({ images }).where(eq(catalogItems.id, itemId));
    await bumpKnowledge(item.workspaceId);
    await enqueue('catalog.describe', { itemId }, { maxAttempts: 2 });
  });

  registerJob('report.generate', async ({ workspaceId, period }: { workspaceId: string; period: 'daily' | 'weekly' }) => {
    const ws = await getWorkspace(workspaceId);
    if (ws) await generateReport(ws, period, { email: true });
  });

  registerJob('mail.send', async (input: MailInput) => {
    await sendMail(input);
  });

  registerJob('scheduler.tick', async () => {
    try {
      await scheduleReports();
      await maybeCleanup();
    } finally {
      await enqueue('scheduler.tick', {}, { delayMs: 60_000, uniqueKey: 'scheduler.tick' });
    }
  });
}

async function scheduleReports(): Promise<void> {
  const list = await db.select().from(workspaces).where(eq(workspaces.status, 'active'));
  const now = new Date();
  for (const ws of list) {
    const r = ws.reporting;
    if (!r?.dailyEnabled && !r?.weeklyEnabled) continue;
    const parts = zonedParts(now, ws.timezone);
    if (parts.hour < (r.dailyHour ?? 21)) continue;
    const today = localDateStr(now, ws.timezone);
    if (r.dailyEnabled && ws.lastDailyReportOn !== today) {
      await db.update(workspaces).set({ lastDailyReportOn: today }).where(eq(workspaces.id, ws.id));
      await enqueue('report.generate', { workspaceId: ws.id, period: 'daily' }, { uniqueKey: `report:daily:${ws.id}:${today}`, maxAttempts: 3 });
    }
    if (r.weeklyEnabled && parts.weekday === 'mon' && ws.lastWeeklyReportOn !== today) {
      await db.update(workspaces).set({ lastWeeklyReportOn: today }).where(eq(workspaces.id, ws.id));
      await enqueue('report.generate', { workspaceId: ws.id, period: 'weekly' }, { uniqueKey: `report:weekly:${ws.id}:${today}`, maxAttempts: 3 });
    }
  }
}

let lastCleanup = 0;
async function maybeCleanup(): Promise<void> {
  if (Date.now() - lastCleanup < 60 * 60_000) return;
  lastCleanup = Date.now();
  const now = new Date();
  await db
    .delete(jobs)
    .where(
      or(
        and(eq(jobs.status, 'done'), lt(jobs.updatedAt, new Date(Date.now() - 2 * 86_400_000))),
        and(eq(jobs.status, 'failed'), lt(jobs.updatedAt, new Date(Date.now() - 14 * 86_400_000))),
      ),
    );
  await db.delete(webhookLogs).where(lt(webhookLogs.createdAt, new Date(Date.now() - 3 * 86_400_000)));
  await db.delete(sessions).where(lt(sessions.expiresAt, now));
  await db.delete(oauthSessions).where(lt(oauthSessions.expiresAt, now));
  await db.delete(passwordResets).where(or(lt(passwordResets.expiresAt, now), isNotNull(passwordResets.usedAt)));
  // Unpause conversations whose timed pause is over (purely cosmetic for the inbox).
  await db.execute(sql`UPDATE conversations SET ai_paused = false, ai_paused_until = NULL WHERE ai_paused = true AND ai_paused_until IS NOT NULL AND ai_paused_until < now()`);
}
