# Apple Developer — follow-up (after you enroll)

Use this checklist once you have an **Apple Developer Program** membership. Update this file as you complete each step.

## Server environment (both hosts during migration)

Set these on the process that runs `jam-server` (or in `.env`):

| Variable | When to fill | Notes |
|----------|----------------|-------|
| `APPLE_APP_STORE_ID` | App is on App Store | Numeric ID from App Store Connect (app → App Information → Apple ID). Powers Smart App Banner + iOS store fallback on `/join`. |
| `APPLE_TEAM_ID` | You have Team ID | 10-character Team ID (Membership details in [Apple Developer](https://developer.apple.com/account)). Required for `/.well-known/apple-app-site-association` (Universal Links). |
| `APPLE_BUNDLE_ID` | If not `com.valaki.soundroom` | Optional; defaults to `com.valaki.soundroom`. Must match the iOS app’s bundle ID in AASA `appID`: `{TEAM_ID}.{BUNDLE_ID}`. |

After setting `APPLE_TEAM_ID`, verify on **each** public jam host:

- `https://jam.valaki.in/.well-known/apple-app-site-association` returns **200** and **JSON** (no HTML error page).
- `https://jam.soundroom.in/.well-known/apple-app-site-association` — same.
- Each URL is served over **HTTPS** with **no redirect** to a different host (Apple fetches it for Universal Links).

## iOS app (Sound Room)

- [ ] **Associated Domains**: keep `applinks:jam.valaki.in` (current default); add `applinks:jam.soundroom.in` before cutover.
- [ ] **Universal Links handling**: app should open jam sessions from `https://jam.valaki.in/join?...` today; add soundroom host before making it the default share URL.
- [ ] Confirm custom scheme still works: `soundroom://jam?id=…` (used by `/join` as fallback when Safari opens).

## Cutover (~3–4 days)

- [ ] Ship app update with default jam URL → `https://jam.soundroom.in`.
- [ ] New share links use `jam.soundroom.in`.
- [ ] Remove `applinks:jam.valaki.in` and disable nginx vhost for `jam.valaki.in`.

## Optional verification

- [ ] Apple’s [app search validation tool](https://search.developer.apple.com/appsearch-validation-tool/) (or equivalent) for the association file, once live.
- [ ] Open a shared `https://jam.valaki.in/join?id=ROOM_ID` link on a device with the app installed — should open the app when Universal Links are configured.

---

**Status:** Waiting on Apple Developer account — _update this line when enrolled._

**Notes (your updates):**

<!-- Add App Store ID, Team ID, or any deployment quirks below when ready. -->
