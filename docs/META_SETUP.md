# Connecting Messenger, Instagram and WhatsApp (Meta setup)

You do this **once, as the platform owner**. After that, every business that signs up connects its own
Facebook Page, Instagram account or WhatsApp number by clicking **Connect** in *Channels* and approving
access in Facebook's own login window. Businesses never give you a password. They choose exactly which
Pages or numbers you can use, and they can remove access at any time from their Facebook settings.

## 1. Create the Meta app

1. Go to <https://developers.facebook.com/apps> and click **Create app**. Choose the **Business** type
   (shown as "Other → Business" in some flows) and link it to your own Meta Business portfolio.
2. Add these products: **Messenger**, **Instagram** (the "API setup with Facebook login" option),
   **WhatsApp** and **Facebook Login for Business**.
3. Under *App settings → Basic*, copy the **App ID** and **App Secret** into `.env`:

   ```env
   META_APP_ID=1234567890
   META_APP_SECRET=abc123...
   META_VERIFY_TOKEN=any-long-random-string-you-choose
   ```

   Fill in a Privacy Policy URL, Terms URL, app icon and category too. App Review requires them.

## 2. Make the server reachable over HTTPS

Meta only sends webhooks to public HTTPS URLs. In production, `APP_URL` is your domain. In development, use a tunnel:

```bash
ngrok http 3000          # or: cloudflared tunnel --url http://localhost:3000
```

Set `APP_URL` to the tunnel URL (for example `https://abcd-12-34.ngrok-free.app`) and restart the server.
To use the dashboard through the tunnel as well, run `npm run build` and `npm start`, and leave
`WEB_URL` empty. Facebook Login only works from domains you have allowed (see step 4).

## 3. Webhooks

The callback URL for all three products is the same:

```
https://YOUR_APP_URL/webhooks/meta
```

Use the value of `META_VERIFY_TOKEN` as the verify token. The server checks every delivery against
the `X-Hub-Signature-256` header, signed with your App Secret.

| Product (webhook object) | Where to set it | Fields to subscribe |
|---|---|---|
| **Page** (Messenger) | Messenger → Settings → Webhooks | `messages`, `messaging_postbacks`, `message_echoes`, `message_reactions` |
| **Instagram** | Instagram → API setup with Facebook login → Webhooks | `messages`, `messaging_postbacks`, `message_reactions` |
| **WhatsApp Business Account** | WhatsApp → Configuration → Webhook | `messages` |

You don't need to subscribe each business's Page or WhatsApp account by hand. When a business
connects, the server calls `/{page-id}/subscribed_apps` or `/{waba-id}/subscribed_apps` for it.

## 4. Facebook Login for Business

1. *Facebook Login for Business → Settings*:
   - Turn on **Login with the JavaScript SDK**.
   - Add your dashboard domain (for example `app.yourdomain.com`, or the ngrok host) to
     **Allowed Domains for the JavaScript SDK**.
   - Add `https://YOUR_DASHBOARD/` to **Valid OAuth Redirect URIs**.
2. *Facebook Login for Business → Configurations*: create two configurations.

   **a. Messenger and Instagram.** Choose the *User access token* login variation. Assets: **Pages**
   and **Instagram accounts**. Permissions:
   `pages_show_list`, `pages_messaging`, `pages_manage_metadata`, `pages_read_engagement`,
   `instagram_basic`, `instagram_manage_messages`, `business_management`.
   Copy the configuration ID to `META_LOGIN_CONFIG_ID`. This is optional: without it the dashboard
   asks for the same permissions with classic Facebook Login.

   **b. WhatsApp Embedded Signup.** Choose the *WhatsApp Embedded Signup* login variation.
   Permissions: `whatsapp_business_management`, `whatsapp_business_messaging`.
   Copy the configuration ID to `META_WA_CONFIG_ID`. This one is required for the WhatsApp **Connect** button.

## 5. WhatsApp: become a Tech Provider

To let other businesses connect their own WhatsApp numbers through Embedded Signup, your app must be a
**Tech Provider**. In the App Dashboard go to *WhatsApp → Quickstart*, follow the Tech Provider onboarding,
and complete **Business Verification** for your Meta Business portfolio.

During Embedded Signup, the business creates or chooses its WhatsApp Business Account and verifies its
phone number by SMS or voice call. The server then:

- exchanges the returned code for a token,
- subscribes your app to their WhatsApp Business Account,
- registers the number for the Cloud API.

A number that is still active in the WhatsApp Business **app** cannot be registered on the Cloud API
unless the business uses Meta's coexistence onboarding. Otherwise the number must first be deleted from the app.

## 6. App Review and going live

While the app is in **Development** mode, only people with a role on the app (admins, developers, testers)
can connect, and only their own Pages or numbers can message the assistant. Before real businesses can
connect, you need to:

1. Request **Advanced Access** for every permission listed in step 4 (*App Review → Permissions and Features*).
   For each one, record a screencast of the real flow:
   - clicking Connect in your dashboard,
   - choosing a Page,
   - a customer message arriving in the inbox,
   - the AI reply.
2. Complete **Business Verification**.
3. Switch the app to **Live** mode.

Typical review time is a few days to a couple of weeks.

## 7. Messaging rules the assistant respects

- **24-hour window.** Messenger, Instagram and WhatsApp only allow free-form replies within 24 hours of the
  customer's last message. Follow-ups are capped at 23 hours (1380 minutes) for this reason.
- **WhatsApp outside 24 hours** needs approved message templates. They are not used by the assistant yet.
- **Human handover.** When someone on the business's team replies from the Facebook Page inbox, Meta
  Business Suite or the WhatsApp app, the server sees the echo and pauses the AI for that conversation, so
  it doesn't talk over a person.

## 8. Troubleshooting

| Symptom | Check |
|---|---|
| Webhook verification fails | `APP_URL` is public HTTPS, and `META_VERIFY_TOKEN` matches exactly |
| "Could not load Facebook" in the dashboard | Ad blocker, or the domain is missing from *Allowed Domains for the JavaScript SDK* |
| Messages arrive but no reply | `ANTHROPIC_API_KEY` set? Is the assistant switched on, and the plan's monthly reply limit not reached? See *Admin console → Background jobs* |
| Instagram messages don't arrive | The Instagram account must be a professional (business or creator) account linked to the Page, with *Allow access to messages* turned on in the Instagram app's privacy settings |
| WhatsApp "number already registered" | The number is still on the WhatsApp Business app. Use coexistence onboarding, or remove it from the app |

## References (Meta developer docs)

- Webhooks: <https://developers.facebook.com/docs/graph-api/webhooks/getting-started>
- Messenger Platform: <https://developers.facebook.com/docs/messenger-platform>
- Instagram messaging: <https://developers.facebook.com/docs/instagram-platform>
- Facebook Login for Business: <https://developers.facebook.com/docs/facebook-login/facebook-login-for-business>
- WhatsApp Embedded Signup: <https://developers.facebook.com/docs/whatsapp/embedded-signup>
- WhatsApp Tech Providers: <https://developers.facebook.com/docs/whatsapp/solution-providers/get-started-for-tech-providers>
- App Review: <https://developers.facebook.com/docs/app-review>
