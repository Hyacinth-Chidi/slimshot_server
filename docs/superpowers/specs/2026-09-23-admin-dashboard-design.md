# SlimShot Admin Dashboard — Design (Project B)

**Date:** 2026-09-23
**Status:** Approved for planning
**Repo:** `slimshot-dashboard` (new, separate from `slimshot_server`)
**Depends on:** `2026-09-23-admin-api-completion-design.md` (Project A) being built first

## 1. Purpose

A web dashboard for operating the SlimShot content platform: uploading and publishing
audio, managing categories, monitoring processing, and configuring the system.

The brief was "premium, unified and uniform, and genuinely mobile responsive." Unified
means it must look like the same product as the Flutter app, not a separate admin tool
bolted on. Mobile responsive means usable on a phone by design, not a desktop table that
shrinks.

## 2. Goals

- Visual continuity with the mobile app: same palette, typeface, icon set.
- A phone-first asset list that is a different component from the desktop table, not the
  same table compressed.
- Every screen backed by a real endpoint on day one.
- Credential handling that never persists a password and never caches a revealed secret.

## 3. Non-goals

- No public-facing pages. This is an internal tool.
- No light theme. The app is dark; a light dashboard would break the unity requirement.
- No user management UI beyond what the API exposes (owner-only admin CRUD is a later phase).
- No analytics beyond the stats the API provides.

## 4. Design system

Taken from `slimshotai/lib/core/theme/app_colors.dart` so the two products match exactly.

```
--bg        #09090B   page background        (Zinc 950)
--surface   #18181B   cards, sidebar         (Zinc 900)
--elevated  #27272A   inputs, hover, active  (Zinc 800)
--border    #3F3F46                          (Zinc 700)

--text      #FAFAFA   primary                (Zinc 50)
--muted     #A1A1AA   secondary              (Zinc 400)
--subtle    #71717A   tertiary               (Zinc 500)

--brand     linear-gradient(135deg, #9333EA 0%, #6B21A8 100%)
--success   #22C55E     --error #EF4444     --warning #EAB308
```

**Typeface:** Plus Jakarta Sans (already the app's UI font), self-hosted.
**Icons:** Lucide — the app bundles `lucide.ttf`, so the icon language matches.

### 4.1 Three rules that carry the "premium" requirement

**Gradient restraint.** The brand gradient appears in exactly four places: the primary
button, the active navigation indicator, focus rings, and the logo mark. Not on cards, not
on headers, not on backgrounds. A gradient used everywhere reads as cheap; used once per
screen it reads as deliberate.

**Elevation discipline.** Three surfaces, strictly assigned: `--bg` for the page,
`--surface` for cards and sidebar, `--elevated` for inputs, hover and active rows. No
in-between shades. Separation comes from borders, not shadows.

**Motion with meaning.** Transitions only on state the user caused — a row publishing, a
sheet opening, upload progress. 150–200ms, ease-out. Nothing decorative, nothing that
delays interaction.

## 5. Stack

- **Next.js (App Router) + TypeScript** — route handlers are needed for the httpOnly
  refresh cookie (see §8).
- **Tailwind** — the palette is already Tailwind-native Zinc.
- **TanStack Query** — server state, cache invalidation, the 401-refresh interceptor.
- **shadcn/ui** — unstyled accessible primitives (dialog, sheet, dropdown, toast),
  restyled to the tokens above. Used for correctness, not for its default look.

Separate repo: independent deploys, its own CI, and no mixing of a Node API and a React
app in one `package.json`.

## 6. Screens

### 6.1 Overview

Four stat tiles (total, published, processing, failed), an uploads sparkline over 30 days,
recent activity from the audit log, and a queue-health strip.

The health strip **only renders when something is wrong** — failures present, or delayed
jobs above zero. A panel that shows "all healthy" every day trains the reader to ignore it.

### 6.2 Assets

The primary surface, and the one that earns the responsive claim.

- **Desktop (`md` and up):** dense sortable table, inline status pills, bulk selection,
  hover actions.
- **Mobile (below `md`):** a **card list — a different component, not a squeezed table**.
  Each card carries artwork, title, duration, status and an overflow menu. Filters move
  into a bottom sheet. Upload becomes a floating action button.

Cursor pagination, infinite scroll on mobile, explicit pager on desktop.

### 6.3 Upload

Drag-and-drop queue with per-file progress. Each file runs its own
ticket → direct-upload → finalize sequence, so one failure does not fail the batch. Title,
author and category are editable inline before finalize.

Failed files stay in the queue with a retry action and the server's error message.

### 6.4 Categories

Tree view, kind-scoped, drag to reorder, inline rename. Creating a child under a parent of
a different kind is not offered.

Deleting a category in use surfaces the API's 409 with its asset count —
*"12 assets use this category"* — rather than a generic failure.

### 6.5 Settings (owner only)

Grouped by the API's `group` field. Non-secret settings edit inline.

Secrets show masked (`sk_••••4f2a`) with a **Reveal** action that opens a password prompt.
On success the true value is shown once and re-masks on navigate.

**Hard requirements, specified because getting these wrong is how credentials leak:**

- The password lives in local component state only. Never in TanStack Query's cache, never
  in a form library's persisted state, never in `localStorage` or `sessionStorage`.
- The revealed value is never written to the query cache — it is returned to the component
  and held in local state for the life of that view.
- No password or revealed value appears in any URL, including as a query parameter.
- The reveal request is not retried automatically on failure; a wrong password must be a
  deliberate second attempt, because failures feed the account lockout.

### 6.6 Audit

Filterable, read-only log: actor, action, entity, timestamp. No delete affordance, because
the API offers none.

## 7. Responsive strategy

Single breakpoint at `md` (768px).

| | Below `md` | `md` and up |
|---|---|---|
| Navigation | Bottom tab bar, 4 peers | Left sidebar |
| Asset list | Card list | Table |
| Filters | Bottom sheet | Inline toolbar |
| Modals | Sheet from bottom | Centred dialog |
| Tap targets | 44px minimum | Hover states |

Four navigation peers — Overview, Assets, Categories, Settings — matching the stated
"all three roughly evenly" usage. Audit is reachable from Overview rather than occupying a
fifth tab.

Building two presentations of the asset list is a real cost. It is also the only honest way
to meet the brief: the alternative is a horizontally scrolling table, which is what
"responsive" usually means in admin panels and is what this explicitly rejects.

## 8. Authentication

- **Access token in memory.** Never in `localStorage` — an XSS then cannot read it.
- **Refresh token in an httpOnly cookie**, set by a Next.js route handler that proxies
  `/auth/login`. The browser cannot read it from JavaScript.
- A TanStack Query interceptor refreshes on 401 and retries the original request once.
- The server already implements refresh rotation with reuse detection: a stolen refresh
  token revokes the whole family, and the user re-authenticates.
- On logout, the route handler clears the cookie and calls the API's logout.

Route protection is client-side plus server enforcement — the API rejects unauthorised
requests regardless, so the UI guard is a convenience, not the security boundary.

## 9. Error handling

The API returns `{ success: false, error: { code, message, details?, traceId } }`. The
dashboard surfaces `message` in a toast and logs `traceId` to the console so a report can
be tied to a server-side log line.

Three cases get bespoke handling rather than a generic toast:

- **409 on category delete** — show the asset count and offer to filter the asset list by
  that category.
- **422 validation** — map `details` onto the offending form fields.
- **401 after a failed refresh** — redirect to login rather than showing an error.

## 10. Testing

- Component tests (Vitest + Testing Library) for the asset card, the status pill, and the
  upload queue's per-file state machine.
- A test asserting the mobile asset list renders cards and the desktop one renders a table,
  since that split is the core of the responsive claim.
- A test asserting the reveal flow never writes the password or the revealed value into the
  query cache.
- No end-to-end suite in the first version; the API has its own.

## 11. Open decisions deferred to implementation

- Artwork: assets have no thumbnail until a processor generates one. Until then the card
  and table use a generated gradient placeholder keyed on the asset id, so the layout is
  correct now and real artwork drops in later.
- Sparkline library versus hand-rolled SVG — decide when building Overview; a 30-point
  line does not justify a charting dependency.
