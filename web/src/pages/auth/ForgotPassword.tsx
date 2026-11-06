import { useState, type FormEvent } from 'react';
import { Link } from 'react-router';
import { Button, Field, Input } from '../../components/ui';
import { api, errorMessage } from '../../lib/api';
import { AuthShell } from './AuthShell';

export default function ForgotPassword() {
  const [email, setEmail] = useState('');
  const [sent, setSent] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setLoading(true);
    setError(null);
    try {
      await api('/api/auth/forgot', { body: { email } });
      setSent(true);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setLoading(false);
    }
  }

  return (
    <AuthShell title="Reset your password" subtitle="We'll email you a link to choose a new one.">
      {sent ? (
        <div className="space-y-4">
          <p className="rounded-lg bg-brand-50 p-4 text-sm text-brand-900">If an account exists for {email}, a reset link is on its way. Check your inbox.</p>
          <Link to="/login" className="text-sm font-medium text-brand-800 hover:underline">
            Back to sign in
          </Link>
        </div>
      ) : (
        <form onSubmit={submit} className="space-y-4">
          <Field label="Email">
            <Input type="email" required value={email} onChange={(e) => setEmail(e.target.value)} />
          </Field>
          {error && <p className="text-sm text-red-600">{error}</p>}
          <Button type="submit" loading={loading} className="w-full">
            Send reset link
          </Button>
          <p className="text-center text-sm">
            <Link to="/login" className="text-zinc-500 hover:text-zinc-800">
              Back to sign in
            </Link>
          </p>
        </form>
      )}
    </AuthShell>
  );
}
