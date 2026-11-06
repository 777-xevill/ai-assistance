import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Download, ImagePlus, Package, Plus, Search, Sparkles, Trash2, Upload, X } from 'lucide-react';
import { useRef, useState } from 'react';
import { PageContainer } from '../components/Layout';
import { Badge, Button, Checkbox, EmptyState, ErrorState, Field, IconButton, Input, Modal, PageHeader, PageLoader, Segmented, Textarea, Toggle } from '../components/ui';
import { errorMessage } from '../lib/api';
import { formatMoney, minutesLabel } from '../lib/format';
import { useToast } from '../lib/toast';
import type { CatalogItem, Variant } from '../lib/types';
import { useWid, useWorkspace, useWsApi } from '../lib/workspace';

type ItemDraft = Omit<CatalogItem, 'id' | 'createdAt'> & { id?: string };

const blank = (type: 'product' | 'service'): ItemDraft => ({
  type,
  name: '',
  description: '',
  category: '',
  price: null,
  salePrice: null,
  sku: '',
  stock: null,
  variants: [],
  durationMinutes: type === 'service' ? 60 : null,
  images: [],
  tags: [],
  attributes: {},
  active: true,
});

export default function Catalog() {
  const api = useWsApi();
  const wid = useWid();
  const qc = useQueryClient();
  const toast = useToast();
  const ws = useWorkspace().data?.workspace;
  const [type, setType] = useState<'product' | 'service'>(ws && ['services', 'agency', 'healthcare', 'education'].includes(ws.businessType) ? 'service' : 'product');
  const [q, setQ] = useState('');
  const [editing, setEditing] = useState<ItemDraft | null>(null);
  const csvRef = useRef<HTMLInputElement>(null);
  const { data, isLoading, error, refetch } = useQuery({
    queryKey: ['ws', wid, 'catalog', type, q],
    queryFn: () => api.get<{ items: CatalogItem[] }>(`/catalog?type=${type}${q ? `&q=${encodeURIComponent(q)}` : ''}`),
  });

  const importCsv = useMutation({
    mutationFn: (file: File) => {
      const fd = new FormData();
      fd.append('file', file);
      return api.upload<{ created: number; skipped: { row: number; reason: string }[] }>('/catalog/import-csv', fd);
    },
    onSuccess: (r) => {
      toast.success(`Imported ${r.created} item${r.created === 1 ? '' : 's'}${r.skipped.length ? `, skipped ${r.skipped.length}` : ''}. Photos from URLs download in the background.`);
      qc.invalidateQueries({ queryKey: ['ws', wid, 'catalog'] });
    },
    onError: (err) => toast.error(errorMessage(err)),
  });

  const cur = ws?.currency ?? 'USD';
  return (
    <PageContainer wide>
      <PageHeader
        title="Products & services"
        description="Everything your assistant can sell or book. Add clear photos: when a customer sends a picture, the assistant matches it against these."
        actions={
          <>
            <input ref={csvRef} type="file" accept=".csv,text/csv" hidden onChange={(e) => e.target.files?.[0] && importCsv.mutate(e.target.files[0])} />
            <Button variant="secondary" icon={<Upload className="size-4" />} onClick={() => csvRef.current?.click()} loading={importCsv.isPending}>
              Import CSV
            </Button>
            <a href={api.url('/catalog/export.csv')}>
              <Button variant="ghost" icon={<Download className="size-4" />}>
                Export
              </Button>
            </a>
            <Button icon={<Plus className="size-4" />} onClick={() => setEditing(blank(type))}>
              Add {type}
            </Button>
          </>
        }
      />
      <div className="mb-4 flex flex-wrap items-center gap-3">
        <Segmented
          value={type}
          onChange={setType}
          options={[
            { id: 'product', label: 'Products' },
            { id: 'service', label: 'Services' },
          ]}
        />
        <div className="relative w-full sm:w-72">
          <Search className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-zinc-400" />
          <Input className="pl-9" placeholder="Search name, category or SKU" value={q} onChange={(e) => setQ(e.target.value)} />
        </div>
      </div>
      {error ? (
        <ErrorState error={error} retry={() => refetch()} />
      ) : isLoading ? (
        <PageLoader />
      ) : (data?.items.length ?? 0) === 0 ? (
        <div className="rounded-xl border border-zinc-200 bg-white">
          <EmptyState
            icon={<Package className="size-6" />}
            title={`No ${type}s yet`}
            description="Add them one by one, upload a CSV (name, price, description, category, stock, image_urls…), or import from your website on the Knowledge page."
            action={
              <Button icon={<Plus className="size-4" />} onClick={() => setEditing(blank(type))}>
                Add {type}
              </Button>
            }
          />
        </div>
      ) : (
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
          {data!.items.map((it) => (
            <button key={it.id} onClick={() => setEditing(it)} className="group overflow-hidden rounded-xl border border-zinc-200 bg-white text-left shadow-xs transition-shadow hover:shadow-md">
              <div className="aspect-[4/3] bg-zinc-100">
                {it.images[0] ? (
                  <img src={it.images[0].url} alt="" className="size-full object-cover" loading="lazy" />
                ) : (
                  <div className="flex size-full items-center justify-center text-zinc-300">
                    <Package className="size-10" />
                  </div>
                )}
              </div>
              <div className="space-y-1 p-3">
                <div className="flex items-start justify-between gap-2">
                  <span className="line-clamp-2 font-medium text-zinc-900">{it.name}</span>
                  {!it.active && <Badge>Hidden</Badge>}
                </div>
                <div className="flex items-baseline gap-2">
                  {it.salePrice !== null ? (
                    <>
                      <span className="font-semibold text-zinc-900">{formatMoney(it.salePrice, cur)}</span>
                      <span className="text-xs text-zinc-400 line-through">{formatMoney(it.price, cur)}</span>
                    </>
                  ) : (
                    <span className="font-semibold text-zinc-900">{it.price === null ? 'Price on request' : formatMoney(it.price, cur)}</span>
                  )}
                </div>
                <div className="flex flex-wrap gap-1 text-xs text-zinc-500">
                  {it.category && <span>{it.category}</span>}
                  {it.type === 'product' && it.stock !== null && (
                    <span className={it.stock <= 0 ? 'font-medium text-red-600' : it.stock <= 5 ? 'text-amber-700' : ''}>· {it.stock <= 0 ? 'Out of stock' : `${it.stock} in stock`}</span>
                  )}
                  {it.type === 'service' && it.durationMinutes && <span>· {minutesLabel(it.durationMinutes)}</span>}
                </div>
              </div>
            </button>
          ))}
        </div>
      )}
      {editing && <ItemEditor key={editing.id ?? 'new'} initial={editing} currency={cur} onClose={() => setEditing(null)} />}
    </PageContainer>
  );
}

function ItemEditor({ initial, currency, onClose }: { initial: ItemDraft; currency: string; onClose: () => void }) {
  const api = useWsApi();
  const wid = useWid();
  const qc = useQueryClient();
  const toast = useToast();
  const [item, setItem] = useState<ItemDraft>(initial);
  const [pending, setPending] = useState<File[]>([]);
  const [trackStock, setTrackStock] = useState(initial.stock !== null);
  const fileRef = useRef<HTMLInputElement>(null);
  const set = (patch: Partial<ItemDraft>) => setItem({ ...item, ...patch });
  const isService = item.type === 'service';

  const save = useMutation({
    mutationFn: async () => {
      const body = {
        type: item.type,
        name: item.name.trim(),
        description: item.description,
        category: item.category?.trim() || null,
        price: item.price,
        salePrice: item.salePrice,
        sku: item.sku?.trim() || null,
        stock: trackStock ? (item.stock ?? 0) : null,
        variants: item.variants.filter((v) => v.name.trim() && v.options.length),
        durationMinutes: isService ? item.durationMinutes : null,
        tags: item.tags,
        active: item.active,
        images: item.images,
      };
      const saved = item.id ? await api.patch<{ item: CatalogItem }>(`/catalog/${item.id}`, body) : await api.post<{ item: CatalogItem }>('/catalog', body);
      if (pending.length) {
        const fd = new FormData();
        pending.forEach((f) => fd.append('files', f));
        await api.upload(`/catalog/${saved.item.id}/images`, fd);
      }
      return saved;
    },
    onSuccess: () => {
      toast.success('Saved');
      qc.invalidateQueries({ queryKey: ['ws', wid, 'catalog'] });
      qc.invalidateQueries({ queryKey: ['ws', wid], exact: true });
      onClose();
    },
    onError: (err) => toast.error(errorMessage(err)),
  });

  const remove = useMutation({
    mutationFn: () => api.del(`/catalog/${item.id}`),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['ws', wid, 'catalog'] });
      onClose();
    },
    onError: (err) => toast.error(errorMessage(err)),
  });

  const setVariant = (i: number, v: Partial<Variant>) => set({ variants: item.variants.map((x, idx) => (idx === i ? { ...x, ...v } : x)) });

  return (
    <Modal
      open
      onClose={onClose}
      size="lg"
      title={item.id ? `Edit ${item.type}` : `New ${item.type}`}
      footer={
        <>
          {item.id && (
            <Button
              variant="ghost"
              className="mr-auto text-red-600 hover:bg-red-50"
              icon={<Trash2 className="size-4" />}
              onClick={() => confirm(`Delete "${item.name}"?`) && remove.mutate()}
              loading={remove.isPending}
            >
              Delete
            </Button>
          )}
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button onClick={() => save.mutate()} loading={save.isPending} disabled={!item.name.trim()}>
            Save
          </Button>
        </>
      }
    >
      <div className="grid gap-5 md:grid-cols-[1fr_15rem]">
        <div className="space-y-4">
          <Field label="Name">
            <Input value={item.name} onChange={(e) => set({ name: e.target.value })} autoFocus />
          </Field>
          <Field label="Description" hint="What it is, materials, sizes, what's included. The assistant uses this to answer questions.">
            <Textarea rows={4} value={item.description} onChange={(e) => set({ description: e.target.value })} />
          </Field>
          <div className="grid gap-4 sm:grid-cols-3">
            <Field label={`Price (${currency})`}>
              <Input type="number" min={0} step="any" value={item.price ?? ''} onChange={(e) => set({ price: e.target.value === '' ? null : Number(e.target.value) })} />
            </Field>
            <Field label="Sale price" hint="Optional">
              <Input type="number" min={0} step="any" value={item.salePrice ?? ''} onChange={(e) => set({ salePrice: e.target.value === '' ? null : Number(e.target.value) })} />
            </Field>
            <Field label="Category">
              <Input value={item.category ?? ''} onChange={(e) => set({ category: e.target.value })} />
            </Field>
          </div>
          {isService ? (
            <Field label="Duration (minutes)" hint="Used to find free appointment slots">
              <Input type="number" min={5} step={5} value={item.durationMinutes ?? ''} onChange={(e) => set({ durationMinutes: e.target.value === '' ? null : Number(e.target.value) })} />
            </Field>
          ) : (
            <div className="grid items-end gap-4 sm:grid-cols-2">
              <div className="space-y-2">
                <Toggle checked={trackStock} onChange={setTrackStock} label="Track stock" description="Orders reduce stock; the assistant won't sell what's out." />
                {trackStock && <Input type="number" min={0} value={item.stock ?? 0} onChange={(e) => set({ stock: Number(e.target.value) })} />}
              </div>
              <Field label="SKU / code">
                <Input value={item.sku ?? ''} onChange={(e) => set({ sku: e.target.value })} />
              </Field>
            </div>
          )}
          {!isService && (
            <div>
              <div className="mb-2 text-sm font-medium">Options (sizes, colors…)</div>
              <div className="space-y-2">
                {item.variants.map((v, i) => (
                  <div key={i} className="grid grid-cols-[8rem_1fr_auto] items-center gap-2">
                    <Input placeholder="Size" value={v.name} onChange={(e) => setVariant(i, { name: e.target.value })} />
                    <Input
                      placeholder="S, M, L, XL"
                      defaultValue={v.options.join(', ')}
                      onBlur={(e) => setVariant(i, { options: e.target.value.split(',').map((o) => o.trim()).filter(Boolean) })}
                    />
                    <IconButton label="Remove option" onClick={() => set({ variants: item.variants.filter((_, idx) => idx !== i) })}>
                      <Trash2 className="size-4" />
                    </IconButton>
                  </div>
                ))}
                <Button variant="ghost" size="sm" icon={<Plus className="size-4" />} onClick={() => set({ variants: [...item.variants, { name: '', options: [] }] })}>
                  Add option
                </Button>
              </div>
            </div>
          )}
          <Field label="Tags" hint="Comma separated; extra words customers might use (e.g. party wear, eid, cotton)">
            <Input defaultValue={item.tags.join(', ')} onBlur={(e) => set({ tags: e.target.value.split(',').map((t) => t.trim()).filter(Boolean) })} />
          </Field>
          <Checkbox checked={item.active} onChange={(v) => set({ active: v })} label="Available to customers (uncheck to hide it from the assistant)" />
        </div>

        <div className="space-y-3">
          <div className="text-sm font-medium">Photos</div>
          <div className="grid grid-cols-2 gap-2">
            {item.images.map((img) => (
              <div key={img.url} className="group relative aspect-square overflow-hidden rounded-lg bg-zinc-100" title={img.description ?? ''}>
                <img src={img.url} alt="" className="size-full object-cover" />
                <button
                  aria-label="Remove photo"
                  className="absolute top-1 right-1 hidden rounded-full bg-white/90 p-1 text-zinc-700 shadow group-hover:block"
                  onClick={() => set({ images: item.images.filter((i) => i.url !== img.url) })}
                >
                  <X className="size-3.5" />
                </button>
                {img.description && (
                  <span className="absolute bottom-1 left-1 rounded bg-white/90 p-0.5 text-brand-700" title={`AI description: ${img.description}`}>
                    <Sparkles className="size-3" />
                  </span>
                )}
              </div>
            ))}
            {pending.map((f, i) => (
              <div key={i} className="relative aspect-square overflow-hidden rounded-lg bg-zinc-100">
                <img src={URL.createObjectURL(f)} alt="" className="size-full object-cover opacity-80" />
                <button aria-label="Remove photo" className="absolute top-1 right-1 rounded-full bg-white/90 p-1 text-zinc-700 shadow" onClick={() => setPending(pending.filter((_, idx) => idx !== i))}>
                  <X className="size-3.5" />
                </button>
              </div>
            ))}
            <button onClick={() => fileRef.current?.click()} className="flex aspect-square flex-col items-center justify-center gap-1 rounded-lg border-2 border-dashed border-zinc-300 text-xs text-zinc-500 hover:border-brand-400 hover:text-brand-700">
              <ImagePlus className="size-5" /> Add photos
            </button>
          </div>
          <input
            ref={fileRef}
            type="file"
            accept="image/*"
            multiple
            hidden
            onChange={(e) => {
              setPending([...pending, ...Array.from(e.target.files ?? [])]);
              e.target.value = '';
            }}
          />
          <p className="text-xs text-zinc-500">
            <Sparkles className="mr-1 inline size-3 text-brand-700" />
            The AI writes a short visual description of each photo so it can recognise this item in customer pictures.
          </p>
        </div>
      </div>
    </Modal>
  );
}
