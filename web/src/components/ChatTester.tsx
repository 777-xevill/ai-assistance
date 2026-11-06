import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ImagePlus, Mic, RotateCcw, SendHorizontal, Square } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { errorMessage } from '../lib/api';
import type { Message, ToolCall } from '../lib/types';
import { useToast } from '../lib/toast';
import { useWid, useWsApi } from '../lib/workspace';
import { MessageBubble } from './MessageBubble';
import { Button, cx, IconButton } from './ui';

export interface TestDebug {
  toolCalls: ToolCall[];
  usage: { model: string; inputTokens: number; outputTokens: number; cacheReadTokens: number; cacheWriteTokens: number };
  costUsd: number;
  durationMs: number;
  stopReason: string | null;
  handoff: boolean;
  noReply: boolean;
}

/** A customer's-eye chat with the business's assistant (dashboard playground). */
export function ChatTester({ onDebug, className, suggestions }: { onDebug?: (d: TestDebug | null) => void; className?: string; suggestions?: string[] }) {
  const api = useWsApi();
  const wid = useWid();
  const qc = useQueryClient();
  const toast = useToast();
  const [text, setText] = useState('');
  const [blocker, setBlocker] = useState<string | null>(null);
  const [recorder, setRecorder] = useState<MediaRecorder | null>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const key = ['ws', wid, 'playground'];
  const { data } = useQuery({ queryKey: key, queryFn: () => api.get<{ messages: Message[] }>('/playground') });

  const send = useMutation({
    mutationFn: async ({ text, file }: { text?: string; file?: File }) => {
      const form = new FormData();
      if (text) form.append('text', text);
      if (file) form.append('file', file, file.name);
      return api.upload<{ messages: Message[]; debug?: TestDebug; blocker?: string }>('/playground/message', form);
    },
    onMutate: ({ text, file }) => {
      // Show the customer's message immediately.
      const optimistic: Message = {
        id: `tmp-${Date.now()}`,
        conversationId: '',
        direction: 'in',
        sender: 'customer',
        senderUserId: null,
        text: text ?? null,
        attachments: file ? [{ kind: file.type.startsWith('image/') ? 'image' : 'audio', url: URL.createObjectURL(file), status: 'pending' }] : [],
        status: 'received',
        error: null,
        createdAt: new Date().toISOString(),
      };
      qc.setQueryData<{ messages: Message[] }>(key, (old) => ({ messages: [...(old?.messages ?? []), optimistic] }));
    },
    onSuccess: (res) => {
      qc.setQueryData(key, { messages: res.messages });
      setBlocker(res.blocker ?? null);
      onDebug?.(res.debug ?? null);
      qc.invalidateQueries({ queryKey: ['ws', wid], exact: true });
    },
    onError: (err) => {
      toast.error(errorMessage(err));
      qc.invalidateQueries({ queryKey: key });
    },
  });

  const reset = useMutation({
    mutationFn: () => api.post('/playground/reset'),
    onSuccess: () => {
      qc.setQueryData(key, { messages: [] });
      setBlocker(null);
      onDebug?.(null);
    },
  });

  useEffect(() => {
    listRef.current?.scrollTo({ top: listRef.current.scrollHeight, behavior: 'smooth' });
  }, [data?.messages.length, send.isPending]);

  function submit(value = text) {
    const v = value.trim();
    if (!v || send.isPending) return;
    setText('');
    send.mutate({ text: v });
  }

  async function toggleRecording() {
    if (recorder) {
      recorder.stop();
      return;
    }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const rec = new MediaRecorder(stream);
      const chunks: Blob[] = [];
      rec.ondataavailable = (e) => e.data.size && chunks.push(e.data);
      rec.onstop = () => {
        stream.getTracks().forEach((t) => t.stop());
        setRecorder(null);
        const type = (rec.mimeType || 'audio/webm').split(';')[0];
        const blob = new Blob(chunks, { type });
        if (blob.size > 1000) send.mutate({ file: new File([blob], `voice.${type.includes('mp4') ? 'm4a' : type.includes('ogg') ? 'ogg' : 'webm'}`, { type }) });
      };
      rec.start();
      setRecorder(rec);
    } catch {
      toast.error('Microphone access was blocked.');
    }
  }

  const messages = data?.messages ?? [];
  return (
    <div className={cx('flex min-h-0 flex-col overflow-hidden rounded-2xl border border-zinc-200 bg-white shadow-sm', className)}>
      <div className="flex items-center justify-between border-b border-zinc-100 px-4 py-2.5">
        <div className="text-sm font-medium text-zinc-700">You are the customer</div>
        <IconButton label="Start over" onClick={() => reset.mutate()} disabled={reset.isPending}>
          <RotateCcw className="size-4" />
        </IconButton>
      </div>
      <div ref={listRef} className="scroll-thin min-h-0 flex-1 space-y-3 overflow-y-auto bg-zinc-50 p-4">
        {messages.length === 0 && !send.isPending && (
          <div className="py-8 text-center">
            <p className="text-sm text-zinc-500">Send a message the way a customer would. Try a photo or a voice note too.</p>
            {suggestions && (
              <div className="mt-4 flex flex-wrap justify-center gap-2">
                {suggestions.map((s) => (
                  <button key={s} onClick={() => submit(s)} className="rounded-full border border-zinc-200 bg-white px-3 py-1.5 text-sm text-zinc-700 hover:border-brand-300 hover:bg-brand-50">
                    {s}
                  </button>
                ))}
              </div>
            )}
          </div>
        )}
        {messages.map((m) => (
          <MessageBubble key={m.id} message={m} />
        ))}
        {send.isPending && (
          <div className="flex items-center gap-1 rounded-2xl rounded-bl-md border border-zinc-200 bg-white px-4 py-3 shadow-xs" style={{ width: 64 }}>
            {[0, 1, 2].map((i) => (
              <span key={i} className="size-1.5 animate-bounce rounded-full bg-zinc-400" style={{ animationDelay: `${i * 0.15}s` }} />
            ))}
          </div>
        )}
        {blocker && <p className="rounded-lg bg-amber-50 p-3 text-sm text-amber-900">The assistant did not reply: {blocker}</p>}
      </div>
      <div className="flex items-end gap-2 border-t border-zinc-100 p-3">
        <input
          ref={fileRef}
          type="file"
          accept="image/*,audio/*"
          hidden
          onChange={(e) => {
            const f = e.target.files?.[0];
            e.target.value = '';
            if (f) send.mutate({ file: f, text: text.trim() || undefined });
            setText('');
          }}
        />
        <IconButton label="Send a photo or audio file" onClick={() => fileRef.current?.click()}>
          <ImagePlus className="size-5" />
        </IconButton>
        <IconButton label={recorder ? 'Stop and send' : 'Record a voice message'} onClick={toggleRecording} className={recorder ? 'bg-red-50 text-red-600' : ''}>
          {recorder ? <Square className="size-4" /> : <Mic className="size-5" />}
        </IconButton>
        <textarea
          rows={1}
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault();
              submit();
            }
          }}
          placeholder={recorder ? 'Recording… tap ■ to send' : 'Type a message…'}
          className="max-h-32 min-h-10 flex-1 resize-none rounded-xl border border-zinc-300 px-3 py-2 text-sm focus:border-brand-600 focus:ring-2 focus:ring-brand-600/20 focus:outline-none"
        />
        <Button onClick={() => submit()} disabled={!text.trim()} loading={send.isPending} icon={<SendHorizontal className="size-4" />}>
          <span className="sr-only">Send</span>
        </Button>
      </div>
    </div>
  );
}
