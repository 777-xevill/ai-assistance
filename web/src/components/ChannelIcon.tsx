import { FlaskConical, Globe, MessagesSquare } from 'lucide-react';
import { CHANNEL_META } from '../lib/format';
import type { ChannelType } from '../lib/types';

// Simplified brand marks (white glyph on the brand color).
function Glyph({ type }: { type: ChannelType }) {
  switch (type) {
    case 'messenger':
      return (
        <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
          <path d="M12 2.5C6.8 2.5 2.75 6.3 2.75 11.3c0 2.6 1.1 4.9 2.9 6.5v3.7l3.3-1.8c.95.27 1.97.4 3.05.4 5.2 0 9.25-3.8 9.25-8.8S17.2 2.5 12 2.5Z" opacity=".25" />
          <path d="M12 2.5C6.8 2.5 2.75 6.3 2.75 11.3c0 2.6 1.1 4.9 2.9 6.5v3.7l3.3-1.8c.95.27 1.97.4 3.05.4 5.2 0 9.25-3.8 9.25-8.8S17.2 2.5 12 2.5Zm.95 11.9-2.36-2.5-4.6 2.5 5.06-5.37 2.42 2.5 4.54-2.5-5.06 5.37Z" />
        </svg>
      );
    case 'instagram':
      return (
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
          <rect x="3.5" y="3.5" width="17" height="17" rx="5" />
          <circle cx="12" cy="12" r="4" />
          <circle cx="17.3" cy="6.7" r="1" fill="currentColor" stroke="none" />
        </svg>
      );
    case 'whatsapp':
      return (
        <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
          <path d="M12 2.6a9.4 9.4 0 0 0-8.1 14.2L2.6 21.4l4.7-1.2A9.4 9.4 0 1 0 12 2.6Zm0 1.8a7.6 7.6 0 1 1-3.9 14.1l-.3-.2-2.8.7.8-2.7-.2-.3A7.6 7.6 0 0 1 12 4.4Z" />
          <path d="M8.9 7.6c.2-.2.5-.2.7 0l1 1.7c.1.3.1.6-.1.8l-.6.7c.6 1.3 1.7 2.3 3 3l.6-.6c.2-.2.6-.3.8-.1l1.7 1c.3.2.3.6.1.8l-.7.8c-.5.5-1.3.7-2 .4a9.2 9.2 0 0 1-4.9-4.9c-.3-.7-.1-1.5.4-2Z" />
        </svg>
      );
    case 'telegram':
      return (
        <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
          <path d="M20.7 4.3 3.2 11.1c-1.2.5-1.2 1.2-.2 1.5l4.5 1.4 1.7 5.3c.2.6.4.8.8.8.3 0 .5-.1.8-.4l2.2-2.1 4.6 3.4c.8.5 1.4.2 1.6-.8l3-14.1c.3-1.2-.5-1.8-1.5-1.3Zm-3.3 3.8-7.7 7-.3 3.2-1.5-4.6 9.2-5.8c.4-.3.8 0 .3.2Z" />
        </svg>
      );
    case 'manychat':
      return <MessagesSquare className="size-full" strokeWidth={2} />;
    case 'webchat':
      return <Globe className="size-full" strokeWidth={2} />;
    default:
      return <FlaskConical className="size-full" strokeWidth={2} />;
  }
}

export function ChannelIcon({ type, size = 20, className }: { type: ChannelType; size?: number; className?: string }) {
  return (
    <span
      className={`inline-flex shrink-0 items-center justify-center rounded-full text-white ${className ?? ''}`}
      style={{ width: size, height: size, background: CHANNEL_META[type]?.color ?? '#71717a', padding: Math.round(size * 0.2) }}
      title={CHANNEL_META[type]?.label}
    >
      <Glyph type={type} />
    </span>
  );
}
