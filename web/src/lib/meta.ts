// Facebook JS SDK helpers. Businesses connect through Facebook's own login window:
// they never share a password with us, and they choose exactly which Pages / numbers we may use.

interface FBLoginResponse {
  authResponse?: { code?: string; accessToken?: string } | null;
  status?: string;
}

interface FBSdk {
  init(opts: Record<string, unknown>): void;
  login(cb: (r: FBLoginResponse) => void, opts: Record<string, unknown>): void;
}

declare global {
  interface Window {
    FB?: FBSdk;
    fbAsyncInit?: () => void;
  }
}

let loading: Promise<FBSdk> | null = null;

export function loadFacebookSdk(appId: string, version: string): Promise<FBSdk> {
  if (window.FB) return Promise.resolve(window.FB);
  if (loading) return loading;
  loading = new Promise<FBSdk>((resolve, reject) => {
    window.fbAsyncInit = () => {
      window.FB!.init({ appId, autoLogAppEvents: true, xfbml: false, version });
      resolve(window.FB!);
    };
    const script = document.createElement('script');
    script.src = 'https://connect.facebook.net/en_US/sdk.js';
    script.async = true;
    script.defer = true;
    script.crossOrigin = 'anonymous';
    script.onerror = () => {
      loading = null;
      reject(new Error('Could not load Facebook. Check your connection or disable ad blockers for this site.'));
    };
    document.body.appendChild(script);
  });
  return loading;
}

/** Permissions requested when no Facebook Login for Business configuration is set. */
export const PAGE_SCOPES = [
  'pages_show_list',
  'pages_messaging',
  'pages_manage_metadata',
  'pages_read_engagement',
  'instagram_basic',
  'instagram_manage_messages',
  'business_management',
].join(',');

/** Facebook Login for Pages (Messenger + Instagram). */
export function loginForPages(fb: FBSdk, configId: string | null): Promise<{ code?: string; accessToken?: string }> {
  return new Promise((resolve, reject) => {
    // The SDK requires a plain (non-async) callback.
    fb.login(
      function (response) {
        if (response.authResponse?.code || response.authResponse?.accessToken) {
          resolve({ code: response.authResponse.code ?? undefined, accessToken: response.authResponse.accessToken ?? undefined });
        } else {
          reject(new Error('Facebook login was cancelled.'));
        }
      },
      configId
        ? { config_id: configId, response_type: 'code', override_default_response_type: true }
        : { scope: PAGE_SCOPES, return_scopes: true, auth_type: 'rerequest' },
    );
  });
}

/**
 * WhatsApp Embedded Signup (v4). The popup reports the WhatsApp Business Account and phone
 * number the business selected via postMessage; the login callback returns a short-lived code.
 */
export function whatsappEmbeddedSignup(fb: FBSdk, configId: string): Promise<{ code: string; wabaId: string; phoneNumberId: string }> {
  return new Promise((resolve, reject) => {
    let settled = false;
    let code: string | undefined;
    let session: { wabaId?: string; phoneNumberId?: string } = {};
    let timer: ReturnType<typeof setTimeout> | undefined;

    const done = (err?: Error) => {
      if (settled) return;
      if (!err && !(code && session.wabaId && session.phoneNumberId)) return;
      settled = true;
      window.removeEventListener('message', onMessage);
      if (timer) clearTimeout(timer);
      if (err) reject(err);
      else resolve({ code: code!, wabaId: session.wabaId!, phoneNumberId: session.phoneNumberId! });
    };

    function onMessage(event: MessageEvent) {
      if (!event.origin.endsWith('facebook.com')) return;
      let data: any = event.data;
      try {
        if (typeof data === 'string') data = JSON.parse(data);
      } catch {
        return;
      }
      if (data?.type !== 'WA_EMBEDDED_SIGNUP') return;
      const evt = String(data.event ?? '');
      if (evt === 'FINISH_ONLY_WABA') {
        done(new Error('Your WhatsApp account was created without a phone number. Add a number in WhatsApp Manager, then connect again.'));
      } else if (evt.startsWith('FINISH')) {
        session = { wabaId: data.data?.waba_id, phoneNumberId: data.data?.phone_number_id };
        done();
      } else if (evt === 'CANCEL' || evt === 'ERROR') {
        done(new Error(data.data?.error_message || 'WhatsApp setup was cancelled.'));
      }
    }

    window.addEventListener('message', onMessage);
    fb.login(
      function (response) {
        if (response.authResponse?.code) {
          code = response.authResponse.code;
          done();
          // The account details can arrive just after the callback.
          timer = setTimeout(() => done(new Error('Did not receive your WhatsApp account details. Please try again.')), 15_000);
        } else {
          done(new Error('WhatsApp setup was cancelled.'));
        }
      },
      { config_id: configId, response_type: 'code', override_default_response_type: true, extras: { setup: {} } },
    );
  });
}
