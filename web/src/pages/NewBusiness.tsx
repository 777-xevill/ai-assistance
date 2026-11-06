import { useState, type FormEvent } from 'react';
import { Link, useNavigate } from 'react-router';
import { Button, Field, Input, Select } from '../components/ui';
import { api, errorMessage } from '../lib/api';
import { useAuth } from '../lib/auth';
import { BUSINESS_TYPES, CURRENCIES, guessCurrency, guessTimezone } from '../lib/format';
import type { BusinessType } from '../lib/types';

export default function NewBusiness() {
  const { workspaces, refresh } = useAuth();
  const navigate = useNavigate();
  const [name, setName] = useState('');
  const [type, setType] = useState<BusinessType>('ecommerce');
  const [currency, setCurrency] = useState(guessCurrency());
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setLoading(true);
    setError(null);
    try {
      const res = await api<{ id: string }>('/api/auth/workspaces', { body: { name, businessType: type, currency, timezone: guessTimezone() } });
      await refresh();
      navigate(`/w/${res.id}/onboarding`);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="flex min-h-full items-center justify-center p-6">
      <form onSubmit={submit} className="w-full max-w-md space-y-4 rounded-2xl border border-zinc-200 bg-white p-6 shadow-sm">
        <div>
          <h1 className="text-xl font-semibold">Add a business</h1>
          <p className="mt-1 text-sm text-zinc-500">Each business gets its own assistant, channels, catalog and reports.</p>
        </div>
        <Field label="Business name">
          <Input required value={name} onChange={(e) => setName(e.target.value)} />
        </Field>
        <Field label="Type of business">
          <Select value={type} onChange={(e) => setType(e.target.value as BusinessType)}>
            {BUSINESS_TYPES.map((t) => (
              <option key={t.id} value={t.id}>
                {t.label}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Currency">
          <Select value={currency} onChange={(e) => setCurrency(e.target.value)}>
            {CURRENCIES.map((c) => (
              <option key={c}>{c}</option>
            ))}
          </Select>
        </Field>
        {error && <p className="text-sm text-red-600">{error}</p>}
        <div className="flex items-center justify-between gap-2">
          {workspaces.length > 0 ? (
            <Link to="/" className="text-sm text-zinc-500 hover:text-zinc-800">
              Cancel
            </Link>
          ) : (
            <span />
          )}
          <Button type="submit" loading={loading}>
            Create business
          </Button>
        </div>
      </form>
    </div>
  );
}
