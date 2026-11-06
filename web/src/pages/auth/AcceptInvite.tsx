import { useQuery } from '@tanstack/react-query';
import { useState, type FormEvent } from 'react';
import { Link, useNavigate, useParams } from 'react-router';
import { Button, ErrorState, Field, Input, PageLoader } from '../../components/ui';
import { api, errorMessage } from '../../lib/api';
import { useAuth } from '../../lib/auth';
import { AuthShell } from './AuthShell';
import type { User, WorkspaceSummary } from '../../lib/types';

interface InviteInfo {
  email: string;
  role: string;
  workspaceName: string;
  userExists: boolean;
}

export default function AcceptInvite() {
  const { token = '' } = useParams();
  const { user, setSession, logout } = useAuth();
  const navigate = useNavigate();
  const info = useQuery({ queryKey: ['invite', token], queryFn: () => api<InviteInfo>(`/api/auth/invite/${token}`), retry: false });
  const [name, setName] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  if (info.isLoading) return <PageLoader />;
  if (info.error || !info.data) {
    return (
      <AuthShell title="Invitation">
        <ErrorState error={info.error} />
        <Link to="/login" className="mt-4 inline-block text-sm text-brand-800 underline">
          Go to sign in
        </Link>
      </AuthShell>
    );
  }
  const invite = info.data;
  const wrongAccount = user && user.email !== invite.email;

  async function accept(e?: FormEvent) {
    e?.preventDefault();
    setLoading(true);
    setError(null);
    try {
      const data = await api<{ user: User; workspaces: WorkspaceSummary[]; workspaceId: string }>(`/api/auth/invite/${token}/accept`, { body: user ? {} : { name, password } });
      setSession({ user: data.user, workspaces: data.workspaces });
      navigate(`/w/${data.workspaceId}/dashboard`, { replace: true });
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setLoading(false);
    }
  }

  return (
    <AuthShell title={`Join ${invite.workspaceName}`} subtitle={`You were invited as ${invite.role} (${invite.email}).`}>
      {wrongAccount ? (
        <div className="space-y-3 text-sm">
          <p>You are signed in as {user.email}. Sign out to accept this invitation with {invite.email}.</p>
          <Button variant="secondary" onClick={() => logout()}>
            Sign out
          </Button>
        </div>
      ) : user ? (
        <Button onClick={() => accept()} loading={loading} className="w-full">
          Accept invitation
        </Button>
      ) : (
        <form onSubmit={accept} className="space-y-4">
          {!invite.userExists && (
            <Field label="Your name">
              <Input required value={name} onChange={(e) => setName(e.target.value)} />
            </Field>
          )}
          <Field label={invite.userExists ? 'Your password' : 'Choose a password'} hint={invite.userExists ? undefined : 'At least 8 characters'}>
            <Input type="password" required minLength={invite.userExists ? 1 : 8} value={password} onChange={(e) => setPassword(e.target.value)} />
          </Field>
          {error && <p className="text-sm text-red-600">{error}</p>}
          <Button type="submit" loading={loading} className="w-full">
            {invite.userExists ? 'Sign in and join' : 'Create account and join'}
          </Button>
        </form>
      )}
      {error && user && <p className="mt-3 text-sm text-red-600">{error}</p>}
    </AuthShell>
  );
}
