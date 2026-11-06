import { useState, type FormEvent } from 'react';
import { Link, useNavigate } from 'react-router';
import { Button, Field, Input, Select } from '../../components/ui';
import { api, errorMessage } from '../../lib/api';
import { useAuth } from '../../lib/auth';
import { BUSINESS_TYPES, guessCurrency, guessTimezone } from '../../lib/format';
import type { BusinessType, WorkspaceSummary } from '../../lib/types';
import { AuthShell } from './AuthShell';

export default function Signup() {
  const { setSession } = useAuth();
  const navigate = useNavigate();
  const [form, setForm] = useState({ name: '', email: '', password: '', businessName: '', businessType: 'ecommerce' as BusinessType });
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const set = (k: keyof typeof form) => (e: { target: { value: string } }) => setForm({ ...form, [k]: e.target.value });

  async function submit(e: FormEvent) {
    e.preventDefault();
    setLoading(true);
    setError(null);
    try {
      const data = await api<{ workspaces: WorkspaceSummary[] }>('/api/auth/signup', {
        body: { ...form, timezone: guessTimezone(), currency: guessCurrency() },
      });
      setSession(data);
      navigate(`/w/${data.workspaces[0].id}/onboarding`, { replace: true });
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setLoading(false);
    }
  }

  return (
    <AuthShell
      title="Start your free trial"
      subtitle={
        <>
          Already have an account?{' '}
          <Link to="/login" className="font-medium text-brand-800 hover:underline">
            Sign in
          </Link>
        </>
      }
    >
      <form onSubmit={submit} className="space-y-4">
        <Field label="Your name">
          <Input required autoComplete="name" value={form.name} onChange={set('name')} />
        </Field>
        <Field label="Work email">
          <Input type="email" required autoComplete="email" value={form.email} onChange={set('email')} />
        </Field>
        <Field label="Password" hint="At least 8 characters">
          <Input type="password" required minLength={8} autoComplete="new-password" value={form.password} onChange={set('password')} />
        </Field>
        <Field label="Business name">
          <Input required value={form.businessName} onChange={set('businessName')} placeholder="e.g. Nova Fashion" />
        </Field>
        <Field label="What kind of business?">
          <Select value={form.businessType} onChange={set('businessType')}>
            {BUSINESS_TYPES.map((t) => (
              <option key={t.id} value={t.id}>
                {t.label}
              </option>
            ))}
          </Select>
        </Field>
        {error && <p className="text-sm text-red-600">{error}</p>}
        <Button type="submit" loading={loading} className="w-full">
          Create account
        </Button>
        <p className="text-center text-xs text-zinc-500">No credit card needed. You can connect your pages after signing up.</p>
      </form>
    </AuthShell>
  );
}
