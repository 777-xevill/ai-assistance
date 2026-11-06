import { Check, Copy, Download, ExternalLink, Share2 } from 'lucide-react';
import QRCode from 'qrcode';
import { useEffect, useState } from 'react';
import { Button, Card } from './ui';

const WHERE_TO_PUT_IT = [
  ['Facebook Page', 'Add it as the Page button ("Contact us" / "Learn more") and pin a post with the link.'],
  ['Instagram', 'Put it in your bio link and your story link sticker.'],
  ['WhatsApp', 'Add it to your business profile website field and share it in your status.'],
  ['Google Business Profile', 'Use it as the "Chat" or website link.'],
  ['Print and in-store', 'Print the QR code on posters, menus, packaging and receipts.'],
];

/**
 * The simplest way to go live: a public chat link and QR code that work immediately.
 * Customers open it in any browser. No login, nothing to install, nothing to connect.
 */
export function ChatLinkCard({ url, businessName, onCustomize }: { url: string; businessName: string; onCustomize?: () => void }) {
  const [qr, setQr] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    let cancelled = false;
    QRCode.toDataURL(url, { width: 640, margin: 2, errorCorrectionLevel: 'M', color: { dark: '#0f172a', light: '#ffffff' } })
      .then((data) => !cancelled && setQr(data))
      .catch(() => !cancelled && setQr(null));
    return () => {
      cancelled = true;
    };
  }, [url]);

  function copy() {
    navigator.clipboard
      .writeText(url)
      .then(() => {
        setCopied(true);
        setTimeout(() => setCopied(false), 1800);
      })
      .catch(() => {});
  }

  const shareText = encodeURIComponent(`Chat with ${businessName}: ${url}`);

  return (
    <Card
      title="Your chat link"
      description="Ready to use right now. Share it anywhere and customers can chat with your assistant in their browser: no app, no login, nothing for you to connect."
      className="mb-6 border-brand-200"
    >
      <div className="grid gap-6 md:grid-cols-[minmax(0,1fr)_11rem]">
        <div className="min-w-0 space-y-4">
          <div className="flex items-center gap-2 rounded-lg border border-zinc-300 bg-zinc-50 px-3 py-2">
            <span className="min-w-0 flex-1 truncate text-sm text-zinc-800" title={url}>
              {url}
            </span>
            <Button size="sm" variant="secondary" onClick={copy} icon={copied ? <Check className="size-4 text-emerald-600" /> : <Copy className="size-4" />}>
              {copied ? 'Copied' : 'Copy'}
            </Button>
          </div>
          <div className="flex flex-wrap gap-2">
            <a href={url} target="_blank" rel="noreferrer">
              <Button size="sm" variant="secondary" icon={<ExternalLink className="size-4" />}>
                Open it
              </Button>
            </a>
            <a href={`https://wa.me/?text=${shareText}`} target="_blank" rel="noreferrer">
              <Button size="sm" variant="secondary" icon={<Share2 className="size-4" />}>
                Share on WhatsApp
              </Button>
            </a>
            {onCustomize && (
              <Button size="sm" variant="ghost" onClick={onCustomize}>
                Change colour and greeting
              </Button>
            )}
          </div>
          <div>
            <h3 className="mb-2 text-sm font-semibold text-zinc-800">Where to put it</h3>
            <ul className="space-y-1.5 text-sm text-zinc-600">
              {WHERE_TO_PUT_IT.map(([where, how]) => (
                <li key={where}>
                  <span className="font-medium text-zinc-800">{where}:</span> {how}
                </li>
              ))}
            </ul>
          </div>
        </div>
        <div className="flex flex-col items-center gap-2">
          {qr ? (
            <>
              <img src={qr} alt={`QR code for ${url}`} className="size-44 rounded-lg border border-zinc-200" />
              <a href={qr} download={`${businessName.replace(/[^\w-]+/g, '-').toLowerCase() || 'chat'}-qr.png`}>
                <Button size="sm" variant="secondary" icon={<Download className="size-4" />}>
                  Download QR
                </Button>
              </a>
            </>
          ) : (
            <div className="size-44 rounded-lg bg-zinc-100" />
          )}
        </div>
      </div>
    </Card>
  );
}
