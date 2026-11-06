import { Plus, Trash2 } from 'lucide-react';
import type { DeliveryZone, OrderField, PaymentMethod, Weekday, WeeklyHours } from '../lib/types';
import { Button, Checkbox, IconButton, Input } from './ui';

export function slug(s: string, sep = '-'): string {
  return (
    s
      .toLowerCase()
      .normalize('NFKD')
      .replace(/[^\w\s-]/g, '')
      .trim()
      .replace(/[\s_-]+/g, sep)
      .slice(0, 40) || `item${sep}${Math.random().toString(36).slice(2, 6)}`
  );
}

const DAYS: { id: Weekday; label: string }[] = [
  { id: 'mon', label: 'Monday' },
  { id: 'tue', label: 'Tuesday' },
  { id: 'wed', label: 'Wednesday' },
  { id: 'thu', label: 'Thursday' },
  { id: 'fri', label: 'Friday' },
  { id: 'sat', label: 'Saturday' },
  { id: 'sun', label: 'Sunday' },
];

export function HoursEditor({ value, onChange }: { value: WeeklyHours; onChange: (v: WeeklyHours) => void }) {
  const setDay = (day: Weekday, ranges: WeeklyHours[Weekday]) => onChange({ ...value, [day]: ranges });
  return (
    <div className="divide-y divide-zinc-100 rounded-lg border border-zinc-200">
      {DAYS.map(({ id, label }) => {
        const range = value[id]?.[0];
        const open = Boolean(range);
        return (
          <div key={id} className="flex flex-wrap items-center gap-3 px-3 py-2">
            <div className="w-28">
              <Checkbox checked={open} onChange={(v) => setDay(id, v ? [{ open: '09:00', close: '18:00' }] : [])} label={label} />
            </div>
            {open ? (
              <div className="flex items-center gap-2 text-sm">
                <Input type="time" className="h-9 w-32" value={range!.open} onChange={(e) => setDay(id, [{ ...range!, open: e.target.value }, ...value[id].slice(1)])} />
                <span className="text-zinc-400">to</span>
                <Input type="time" className="h-9 w-32" value={range!.close} onChange={(e) => setDay(id, [{ ...range!, close: e.target.value }, ...value[id].slice(1)])} />
              </div>
            ) : (
              <span className="text-sm text-zinc-400">Closed</span>
            )}
          </div>
        );
      })}
    </div>
  );
}

export function ZonesEditor({ value, onChange, currency }: { value: DeliveryZone[]; onChange: (v: DeliveryZone[]) => void; currency: string }) {
  const update = (i: number, patch: Partial<DeliveryZone>) => onChange(value.map((z, idx) => (idx === i ? { ...z, ...patch } : z)));
  return (
    <div className="space-y-2">
      {value.map((z, i) => (
        <div key={i} className="grid grid-cols-[1fr_7rem_1fr_auto] items-center gap-2">
          <Input placeholder="Area, e.g. Inside Dhaka" value={z.name} onChange={(e) => update(i, { name: e.target.value, id: z.id || slug(e.target.value) })} />
          <Input type="number" min={0} step="any" placeholder={`Fee (${currency})`} value={Number.isFinite(z.fee) ? z.fee : ''} onChange={(e) => update(i, { fee: Number(e.target.value) })} />
          <Input placeholder="Delivery time, e.g. 1-2 days" value={z.eta ?? ''} onChange={(e) => update(i, { eta: e.target.value })} />
          <IconButton label="Remove area" onClick={() => onChange(value.filter((_, idx) => idx !== i))}>
            <Trash2 className="size-4" />
          </IconButton>
        </div>
      ))}
      <Button variant="ghost" size="sm" icon={<Plus className="size-4" />} onClick={() => onChange([...value, { id: '', name: '', fee: 0, eta: '' }])}>
        Add delivery area
      </Button>
    </div>
  );
}

export function PaymentsEditor({ value, onChange }: { value: PaymentMethod[]; onChange: (v: PaymentMethod[]) => void }) {
  const update = (i: number, patch: Partial<PaymentMethod>) => onChange(value.map((m, idx) => (idx === i ? { ...m, ...patch } : m)));
  return (
    <div className="space-y-2">
      {value.map((m, i) => (
        <div key={i} className="grid grid-cols-[12rem_1fr_auto] items-center gap-2">
          <Input placeholder="e.g. bKash" value={m.name} onChange={(e) => update(i, { name: e.target.value, id: m.id || slug(e.target.value) })} />
          <Input placeholder="Instructions for the customer (optional)" value={m.instructions ?? ''} onChange={(e) => update(i, { instructions: e.target.value })} />
          <IconButton label="Remove payment method" onClick={() => onChange(value.filter((_, idx) => idx !== i))}>
            <Trash2 className="size-4" />
          </IconButton>
        </div>
      ))}
      <Button variant="ghost" size="sm" icon={<Plus className="size-4" />} onClick={() => onChange([...value, { id: '', name: '', instructions: '' }])}>
        Add payment method
      </Button>
    </div>
  );
}

const CORE_FIELDS = ['name', 'phone', 'address'];

export function OrderFieldsEditor({ value, onChange }: { value: OrderField[]; onChange: (v: OrderField[]) => void }) {
  const update = (i: number, patch: Partial<OrderField>) => onChange(value.map((f, idx) => (idx === i ? { ...f, ...patch } : f)));
  return (
    <div className="space-y-2">
      {value.map((f, i) => (
        <div key={i} className="grid grid-cols-[1fr_auto_auto] items-center gap-3">
          <Input
            value={f.label}
            onChange={(e) => update(i, { label: e.target.value, key: CORE_FIELDS.includes(f.key) ? f.key : slug(e.target.value, '_') })}
            placeholder="e.g. Preferred delivery time"
          />
          <Checkbox checked={f.required} onChange={(v) => update(i, { required: v })} label="Required" />
          <IconButton label="Remove field" disabled={f.key === 'name' || f.key === 'phone'} onClick={() => onChange(value.filter((_, idx) => idx !== i))}>
            <Trash2 className="size-4" />
          </IconButton>
        </div>
      ))}
      <Button variant="ghost" size="sm" icon={<Plus className="size-4" />} onClick={() => onChange([...value, { key: `field_${value.length + 1}`, label: '', required: false }])}>
        Add field
      </Button>
    </div>
  );
}

export function StringListEditor({ value, onChange, placeholder, addLabel }: { value: string[]; onChange: (v: string[]) => void; placeholder?: string; addLabel: string }) {
  return (
    <div className="space-y-2">
      {value.map((q, i) => (
        <div key={i} className="flex items-center gap-2">
          <Input value={q} placeholder={placeholder} onChange={(e) => onChange(value.map((x, idx) => (idx === i ? e.target.value : x)))} />
          <IconButton label="Remove" onClick={() => onChange(value.filter((_, idx) => idx !== i))}>
            <Trash2 className="size-4" />
          </IconButton>
        </div>
      ))}
      <Button variant="ghost" size="sm" icon={<Plus className="size-4" />} onClick={() => onChange([...value, ''])}>
        {addLabel}
      </Button>
    </div>
  );
}

/** Removes empty rows and fills missing ids before saving. */
export function cleanZones(z: DeliveryZone[]): DeliveryZone[] {
  const seen = new Set<string>();
  return z
    .filter((x) => x.name.trim())
    .map((x) => {
      let id = x.id || slug(x.name);
      while (seen.has(id)) id = `${id}-2`;
      seen.add(id);
      return { ...x, id, name: x.name.trim(), fee: Number(x.fee) || 0, eta: x.eta?.trim() || undefined };
    });
}

export function cleanPayments(p: PaymentMethod[]): PaymentMethod[] {
  const seen = new Set<string>();
  return p
    .filter((x) => x.name.trim())
    .map((x) => {
      let id = x.id || slug(x.name);
      while (seen.has(id)) id = `${id}-2`;
      seen.add(id);
      return { ...x, id, name: x.name.trim(), instructions: x.instructions?.trim() || undefined };
    });
}

export function cleanFields(f: OrderField[]): OrderField[] {
  const seen = new Set<string>();
  return f
    .filter((x) => x.label.trim())
    .map((x) => {
      let key = x.key || slug(x.label, '_');
      while (seen.has(key)) key = `${key}_2`;
      seen.add(key);
      return { ...x, key, label: x.label.trim() };
    });
}
