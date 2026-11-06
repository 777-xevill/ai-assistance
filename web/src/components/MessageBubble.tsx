import { AlertTriangle, Bot, FileText, MapPin, Mic, Video } from 'lucide-react';
import { formatTime } from '../lib/format';
import type { Attachment, Message } from '../lib/types';
import { cx } from './ui';

function AttachmentView({ a, mine }: { a: Attachment; mine: boolean }) {
  if (a.kind === 'image' || a.kind === 'sticker') {
    if (!a.url) return <span className="text-sm italic opacity-80">{a.status === 'pending' ? 'Loading photo…' : 'Photo unavailable'}</span>;
    return (
      <a href={a.url} target="_blank" rel="noreferrer" className="block">
        <img src={a.url} alt={a.description ?? ''} className={cx('rounded-lg object-cover', a.kind === 'sticker' ? 'max-h-28' : 'max-h-64 max-w-full')} loading="lazy" />
        {a.description && <span className={cx('mt-1 block text-xs', mine ? 'text-white/80' : 'text-zinc-500')}>AI saw: {a.description}</span>}
      </a>
    );
  }
  if (a.kind === 'audio') {
    return (
      <div className="space-y-1">
        <div className="flex items-center gap-1.5 text-xs font-medium opacity-80">
          <Mic className="size-3.5" /> Voice message
        </div>
        {a.url && <audio controls src={a.url} className="h-9 max-w-[240px]" preload="none" />}
        {a.transcript ? (
          <p className="text-sm italic">“{a.transcript}”</p>
        ) : a.status === 'pending' ? (
          <p className="text-xs italic opacity-70">Transcribing…</p>
        ) : null}
      </div>
    );
  }
  if (a.kind === 'location' && a.location) {
    return (
      <a href={`https://maps.google.com/?q=${a.location.lat},${a.location.lng}`} target="_blank" rel="noreferrer" className="flex items-center gap-1.5 text-sm underline">
        <MapPin className="size-4" /> {a.location.name || a.location.address || 'Shared location'}
      </a>
    );
  }
  if (a.kind === 'video') {
    return (
      <span className="flex items-center gap-1.5 text-sm">
        <Video className="size-4" /> Video {a.url ? '' : '(open it in the messaging app)'}
      </span>
    );
  }
  return (
    <a href={a.url} target="_blank" rel="noreferrer" className="flex items-center gap-1.5 text-sm underline">
      <FileText className="size-4" /> {a.name || 'File'}
    </a>
  );
}

function richText(text: string) {
  // **bold** and links, rendered safely as React nodes.
  const parts = text.split(/(\*\*[^*]+\*\*|https?:\/\/\S+)/g);
  return parts.map((p, i) => {
    if (/^\*\*[^*]+\*\*$/.test(p)) return <strong key={i}>{p.slice(2, -2)}</strong>;
    if (/^https?:\/\//.test(p)) {
      return (
        <a key={i} href={p} target="_blank" rel="noreferrer" className="underline break-all">
          {p}
        </a>
      );
    }
    return <span key={i}>{p}</span>;
  });
}

export function MessageBubble({ message, senderName }: { message: Message; senderName?: string }) {
  const mine = message.direction === 'out';
  const ai = message.sender === 'ai';
  return (
    <div className={cx('flex flex-col', mine ? 'items-end' : 'items-start')}>
      <div
        className={cx(
          'max-w-[85%] space-y-2 rounded-2xl px-3.5 py-2 text-[15px] leading-relaxed whitespace-pre-wrap shadow-xs sm:max-w-[70%]',
          mine ? (ai ? 'rounded-br-md bg-brand-700 text-white' : 'rounded-br-md bg-zinc-800 text-white') : 'rounded-bl-md border border-zinc-200 bg-white text-zinc-900',
        )}
      >
        {message.attachments.map((a, i) => (
          <AttachmentView key={i} a={a} mine={mine} />
        ))}
        {message.text && <div className="break-words">{richText(message.text)}</div>}
      </div>
      <div className="mt-1 flex items-center gap-1.5 px-1 text-[11px] text-zinc-400">
        {mine && ai && (
          <span className="flex items-center gap-0.5 font-medium text-brand-700">
            <Bot className="size-3" /> AI
          </span>
        )}
        {mine && !ai && <span className="font-medium text-zinc-600">{senderName ?? 'Team'}</span>}
        <span>{formatTime(message.createdAt)}</span>
        {message.status === 'failed' && (
          <span className="flex items-center gap-0.5 text-red-600" title={message.error ?? ''}>
            <AlertTriangle className="size-3" /> Not delivered{message.error ? `: ${message.error.slice(0, 80)}` : ''}
          </span>
        )}
        {mine && message.status === 'read' && <span>· Seen</span>}
      </div>
    </div>
  );
}
