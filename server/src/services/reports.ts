import { and, desc, eq, gte, inArray, lt, sql } from 'drizzle-orm';
import { aiConfigured, complete } from '../ai/client.ts';
import { config } from '../config.ts';
import { db } from '../db/index.ts';
import { contacts, conversations, knowledgeGaps, messages, reports, type Workspace } from '../db/schema.ts';
import { logger } from '../lib/logger.ts';
import { emailLayout, sendMail } from '../lib/mailer.ts';
import { escapeHtml, markdownToHtml, truncate } from '../lib/text.ts';
import { formatLocal } from '../lib/time.ts';
import { computeStats, topItems, type Stats } from './analytics.ts';
import { formatMoney } from './catalog.ts';
import { recordAiRun } from './usage.ts';
import { alertRecipients } from './workspace.ts';

async function conversationDigests(ws: Workspace, from: Date, to: Date, limit = 40) {
  const convs = await db
    .select({ conversation: conversations, contact: contacts })
    .from(conversations)
    .innerJoin(contacts, eq(contacts.id, conversations.contactId))
    .where(
      and(
        eq(conversations.workspaceId, ws.id),
        eq(conversations.isTest, false),
        gte(conversations.lastMessageAt, from),
        lt(conversations.lastMessageAt, to),
      ),
    )
    .orderBy(desc(conversations.lastMessageAt))
    .limit(limit);
  if (convs.length === 0) return [];
  const ids = convs.map((c) => c.conversation.id);
  const msgs = await db
    .select()
    .from(messages)
    .where(and(inArray(messages.conversationId, ids), gte(messages.createdAt, from), lt(messages.createdAt, to)))
    .orderBy(messages.createdAt);
  return convs.map(({ conversation, contact }) => {
    const lines = msgs
      .filter((m) => m.conversationId === conversation.id)
      .slice(-12)
      .map((m) => {
        const who = m.direction === 'in' ? 'C' : m.sender === 'human' ? 'Team' : 'AI';
        const extra = m.attachments.map((a) => (a.transcript ? `[voice] ${a.transcript}` : `[${a.kind}${a.description ? `: ${a.description}` : ''}]`)).join(' ');
        return `${who}: ${truncate([extra, m.text].filter(Boolean).join(' '), 220)}`;
      });
    return {
      customer: contact.name ?? 'Unknown',
      phone: contact.phone ?? undefined,
      stage: contact.stage,
      score: contact.score,
      wants: contact.lead.intent,
      needsHuman: conversation.needsHuman,
      handoffReason: conversation.handoffReason ?? undefined,
      transcript: lines,
    };
  });
}

function statsTable(ws: Workspace, s: Stats): string {
  const rows: [string, string][] = [
    ['Conversations (new / active)', `${s.newConversations} / ${s.activeConversations}`],
    ['Customer messages', String(s.inboundMessages)],
    ['AI replies / team replies', `${s.aiReplies} / ${s.humanReplies}`],
    ['New leads / qualified', `${s.newLeads} / ${s.qualifiedLeads}`],
    ['Orders / revenue', `${s.orders} / ${formatMoney(s.revenue, ws.currency)}`],
    ['Bookings', String(s.bookings)],
    ['Conversion rate', `${s.conversionRate}%`],
    ['Handled fully by AI', `${s.aiHandledRate}%`],
    ['Handoffs to team', String(s.handoffs)],
    ['Unanswered questions', String(s.knowledgeGaps)],
    ['Avg. first response', s.avgFirstResponseSec === null ? '—' : `${s.avgFirstResponseSec}s`],
  ];
  return `<table style="width:100%;border-collapse:collapse;font-size:14px;margin:8px 0 16px">${rows
    .map(
      ([k, v]) =>
        `<tr><td style="padding:6px 0;border-bottom:1px solid #f0f0f0;color:#52525b">${escapeHtml(k)}</td><td style="padding:6px 0;border-bottom:1px solid #f0f0f0;text-align:right;font-weight:600">${escapeHtml(v)}</td></tr>`,
    )
    .join('')}</table>`;
}

function fallbackSummary(ws: Workspace, s: Stats): string {
  return [
    '## Summary',
    `- ${s.activeConversations} customers messaged you; ${s.newConversations} were new conversations.`,
    `- ${s.orders} orders (${formatMoney(s.revenue, ws.currency)}) and ${s.bookings} bookings came in.`,
    `- ${s.handoffs} conversations needed a team member; ${s.knowledgeGaps} questions could not be answered.`,
    '',
    'AI-written insights appear here once an AI provider key is configured.',
  ].join('\n');
}

export async function generateReport(
  ws: Workspace,
  period: 'daily' | 'weekly',
  opts: { email?: boolean } = {},
): Promise<typeof reports.$inferSelect> {
  const to = new Date();
  const from = new Date(to.getTime() - (period === 'daily' ? 1 : 7) * 86_400_000);
  const [stats, items, digests, gaps] = await Promise.all([
    computeStats(ws, from, to),
    topItems(ws, from, to),
    conversationDigests(ws, from, to),
    db
      .select()
      .from(knowledgeGaps)
      .where(and(eq(knowledgeGaps.workspaceId, ws.id), eq(knowledgeGaps.status, 'open')))
      .orderBy(desc(knowledgeGaps.occurrences))
      .limit(10),
  ]);
  const label = `${period === 'daily' ? 'Daily' : 'Weekly'} report · ${formatLocal(to, ws.timezone, { hour: undefined, minute: undefined })}`;

  let summary = fallbackSummary(ws, stats);
  if (aiConfigured() && !config.ai.mock && (stats.activeConversations > 0 || stats.orders > 0 || stats.bookings > 0)) {
    try {
      const started = Date.now();
      const data = {
        business: { name: ws.name, type: ws.businessType, currency: ws.currency },
        period: `${period === 'daily' ? 'last 24 hours' : 'last 7 days'} (until ${formatLocal(to, ws.timezone)})`,
        stats,
        most_asked_about: items.mostAskedAbout,
        best_sellers: items.bestSellers,
        unanswered_questions: gaps.map((g) => ({ question: g.question, times_asked: g.occurrences })),
        conversations: digests,
      };
      const { text, usage } = await complete({
        system:
          'You are a sharp, practical business analyst writing a short report for a busy small-business owner about the customer conversations their AI sales assistant handled. Be specific: use customer names, products and numbers from the data. Never invent facts. Write in simple English with Markdown headings (##) and bullet points. Keep it under 400 words.',
        messages: [
          {
            role: 'user',
            content: `Here is the data:\n\n${JSON.stringify(data)}\n\nWrite the report with these sections:\n## Highlights (2-4 bullets: what went well, key numbers)\n## Hot leads to follow up (name, what they want, why they're hot, suggested next action; skip if none)\n## Needs your attention (complaints, handoffs waiting, failed or risky conversations; skip if none)\n## Questions customers asked that need an answer (with a suggested answer to add to the knowledge base when you can infer it; skip if none)\n## Suggestions (1-3 concrete ideas to sell more or improve service, based on patterns in the data)`,
          },
        ],
        maxTokens: 16000,
        effort: 'medium',
        model: config.ai.model,
      });
      if (text) summary = text;
      await recordAiRun(ws.id, { kind: 'report', usage, durationMs: Date.now() - started });
    } catch (err) {
      logger.warn('AI report summary failed; using fallback', { err, workspaceId: ws.id });
    }
  }

  const [report] = await db
    .insert(reports)
    .values({ workspaceId: ws.id, period, label, periodStart: from, periodEnd: to, stats: { ...stats, ...items }, summary })
    .returning();

  if (opts.email) {
    const to_ = await alertRecipients(ws);
    if (to_.length) {
      const html = emailLayout(
        `${ws.name} — ${label}`,
        `${statsTable(ws, stats)}${markdownToHtml(summary)}`,
        { label: 'Open full report', url: `${config.webUrl}/w/${ws.id}/reports?id=${report.id}` },
      );
      await sendMail({ to: to_, subject: `${label} — ${ws.name}`, html, text: summary });
      await db.update(reports).set({ emailedAt: new Date() }).where(eq(reports.id, report.id));
    }
  }
  return report;
}

/** Used by the scheduler: number of reports generated this month (for admin stats). */
export async function reportCount(workspaceId: string): Promise<number> {
  const [row] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(reports)
    .where(eq(reports.workspaceId, workspaceId));
  return Number(row?.n ?? 0);
}
