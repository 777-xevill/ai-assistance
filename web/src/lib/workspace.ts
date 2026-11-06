import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useParams } from 'react-router';
import { ws } from './api';
import type { WorkspaceDetail } from './types';

export function useWid(): string {
  const { wid } = useParams();
  if (!wid) throw new Error('No workspace in the URL');
  return wid;
}

export function useWsApi() {
  return ws(useWid());
}

export function useWorkspace() {
  const wid = useWid();
  return useQuery({ queryKey: ['ws', wid], queryFn: () => ws(wid).get<WorkspaceDetail>('') });
}

/** Refreshes everything cached for the current workspace. */
export function useInvalidateWorkspace() {
  const qc = useQueryClient();
  const wid = useWid();
  return (key?: string) => qc.invalidateQueries({ queryKey: key ? ['ws', wid, key] : ['ws', wid] });
}

export function rememberWorkspace(wid: string) {
  try {
    localStorage.setItem('lastWorkspace', wid);
  } catch {
    // ignore
  }
}

export function lastWorkspace(): string | null {
  try {
    return localStorage.getItem('lastWorkspace');
  } catch {
    return null;
  }
}
