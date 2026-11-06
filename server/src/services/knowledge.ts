import { and, asc, eq, sql } from 'drizzle-orm';
import { db } from '../db/index.ts';
import { knowledgeEntries, knowledgeGaps, type KnowledgeEntry, type Workspace } from '../db/schema.ts';
import { tokenize } from './catalog.ts';
import { logEvent } from './events.ts';

export async function listActiveKnowledge(workspaceId: string): Promise<KnowledgeEntry[]> {
  return db
    .select()
    .from(knowledgeEntries)
    .where(and(eq(knowledgeEntries.workspaceId, workspaceId), eq(knowledgeEntries.active, true)))
    .orderBy(asc(knowledgeEntries.createdAt));
}

/** Keyword search over FAQ entries; used when the knowledge base is too large for the prompt. */
export async function searchKnowledge(ws: Workspace, query: string, limit = 5): Promise<KnowledgeEntry[]> {
  const entries = await listActiveKnowledge(ws.id);
  const q = new Set(tokenize(query));
  return entries
    .map((e) => {
      const terms = tokenize(`${e.question} ${e.question} ${e.answer}`);
      let score = 0;
      for (const t of terms) if (q.has(t)) score++;
      return { e, score };
    })
    .filter((s) => s.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map((s) => s.e);
}

/** Records a question the assistant could not answer, merging repeats of the same question. */
export async function logKnowledgeGap(ws: Workspace, question: string, conversationId?: string | null): Promise<void> {
  const normalized = question.trim().slice(0, 500);
  if (!normalized) return;
  const [existing] = await db
    .select()
    .from(knowledgeGaps)
    .where(
      and(
        eq(knowledgeGaps.workspaceId, ws.id),
        eq(knowledgeGaps.status, 'open'),
        sql`lower(${knowledgeGaps.question}) = lower(${normalized})`,
      ),
    )
    .limit(1);
  if (existing) {
    await db
      .update(knowledgeGaps)
      .set({ occurrences: existing.occurrences + 1 })
      .where(eq(knowledgeGaps.id, existing.id));
  } else {
    await db.insert(knowledgeGaps).values({ workspaceId: ws.id, question: normalized, conversationId: conversationId ?? null });
  }
  await logEvent(ws.id, 'knowledge_gap', { conversationId, data: { question: normalized } });
}
