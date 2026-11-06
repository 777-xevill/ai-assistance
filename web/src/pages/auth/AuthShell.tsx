import { CheckCircle2 } from 'lucide-react';
import type { ReactNode } from 'react';
import { useAuth } from '../../lib/auth';

const POINTS = [
  'Replies to customers 24/7 from one chat link or QR code you can share anywhere',
  'Understands product photos, voice messages and any language your customers use',
  'Takes orders, books appointments and qualifies leads, then hands over to your team',
  'Daily reports on sales, hot leads and questions it could not answer',
];

export function AuthShell({ title, subtitle, children }: { title: string; subtitle?: ReactNode; children: ReactNode }) {
  const { app } = useAuth();
  return (
    <div className="flex min-h-full">
      <div className="hidden w-[44%] flex-col justify-between bg-brand-800 p-10 text-white lg:flex">
        <div className="flex items-center gap-2">
          <img src="/favicon.svg" alt="" className="size-8 rounded-lg ring-1 ring-white/30" />
          <span className="text-lg font-semibold">{app?.appName ?? 'AI Assistance'}</span>
        </div>
        <div>
          <h2 className="max-w-md text-3xl leading-tight font-semibold">Never lose a customer to a slow reply again.</h2>
          <ul className="mt-8 space-y-4">
            {POINTS.map((p) => (
              <li key={p} className="flex gap-3 text-brand-50">
                <CheckCircle2 className="mt-0.5 size-5 shrink-0 text-brand-300" />
                <span>{p}</span>
              </li>
            ))}
          </ul>
        </div>
        <p className="text-sm text-brand-200">Nothing to install or connect. We never ask for your passwords.</p>
      </div>
      <div className="flex flex-1 items-center justify-center p-6">
        <div className="w-full max-w-sm">
          <div className="mb-8 flex items-center gap-2 lg:hidden">
            <img src="/favicon.svg" alt="" className="size-8" />
            <span className="text-lg font-semibold">{app?.appName ?? 'AI Assistance'}</span>
          </div>
          <h1 className="text-2xl font-semibold tracking-tight text-zinc-900">{title}</h1>
          {subtitle && <p className="mt-1 text-sm text-zinc-500">{subtitle}</p>}
          <div className="mt-6">{children}</div>
        </div>
      </div>
    </div>
  );
}
