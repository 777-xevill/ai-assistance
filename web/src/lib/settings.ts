import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { errorMessage } from './api';
import { useToast } from './toast';
import type { AISettings, BookingSettings, BusinessProfile, BusinessType, CommerceSettings, ReportSettings, Workspace } from './types';
import { useWid, useWsApi } from './workspace';

export interface SettingsPatch {
  name?: string;
  businessType?: BusinessType;
  timezone?: string;
  currency?: string;
  profile?: BusinessProfile;
  ai?: AISettings;
  commerce?: CommerceSettings;
  booking?: BookingSettings;
  reporting?: ReportSettings;
}

/** Saves workspace settings and refreshes the cached workspace. */
export function useSaveSettings(successMessage = 'Saved') {
  const api = useWsApi();
  const wid = useWid();
  const qc = useQueryClient();
  const toast = useToast();
  return useMutation({
    mutationFn: (patch: SettingsPatch) => api.patch<{ workspace: Workspace }>('/settings', patch),
    onSuccess: async () => {
      await qc.invalidateQueries({ queryKey: ['ws', wid], exact: true });
      toast.success(successMessage);
    },
    onError: (err) => toast.error(errorMessage(err)),
  });
}

/**
 * Local editable copy of a server value. Resets when the server value changes
 * (after a save or a refetch) and reports whether there are unsaved edits.
 */
export function useDraft<T>(source: T) {
  const serialized = JSON.stringify(source);
  const [draft, setDraft] = useState<T>(source);
  useEffect(() => setDraft(JSON.parse(serialized) as T), [serialized]);
  const dirty = JSON.stringify(draft) !== serialized;
  const reset = () => setDraft(JSON.parse(serialized) as T);
  return [draft, setDraft, dirty, reset] as const;
}
