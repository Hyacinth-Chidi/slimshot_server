# SlimShot Admin Dashboard Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the SlimShot admin dashboard — six screens over the shipped admin API — matching the Flutter app's design system, genuinely responsive, with a credential-reveal flow that never leaks a password or a revealed secret.

**Architecture:** Next.js App Router. Access token in memory, refresh token in an httpOnly cookie written by a route handler that proxies the API. TanStack Query owns server state and the 401-refresh interceptor. A single `md` (768px) breakpoint splits navigation and the asset list into two genuinely different components rather than one compressed layout.

**Tech Stack:** Next.js 16.3.6 (App Router), React 19.2.8, TypeScript 5, Tailwind v4, TanStack Query v5, shadcn/ui primitives, Vitest + Testing Library.

**Spec:** `docs/superpowers/specs/2026-09-23-admin-dashboard-design.md` (in the `slimshot_server` repo)

**Repo:** `C:\Users\HP\Desktop\Slimshot workspace\slimshot-admin` — NOT `slimshot_server`. The spec calls this repo `slimshot-dashboard`; the actual scaffold is `slimshot-admin`. Use the real name.

**API:** `slimshot_server`, all routes under `/api/admin/v1/`. Already shipped and reviewed; do not modify it.

---

## Global Constraints

- **Next.js 16 is not the Next.js in your training data.** `AGENTS.md` at the repo root says to read `node_modules/next/dist/docs/` before writing code. Two differences already confirmed and load-bearing for this plan:
  - **`middleware.ts` is DEPRECATED and renamed to `proxy.ts`**, exporting `proxy()` rather than `middleware()`. Do not create `middleware.ts`.
  - **`cookies()` is async** and must be awaited: `const store = await cookies()`.
  Verify anything else framework-level against those docs rather than from memory.
- **Dark theme only.** No light mode, no `dark:` variants, no theme toggle. A light dashboard breaks the unity requirement (spec §3).
- **The brand gradient appears in exactly four places:** primary button, active nav indicator, focus rings, logo mark. Never on cards, headers or backgrounds (spec §4.1).
- **Three surfaces, strictly assigned:** `--bg` page, `--surface` cards/sidebar, `--elevated` inputs/hover/active. No in-between shades. Separation via borders, never shadows.
- **Transitions only on user-caused state change**, 150–200ms ease-out. Nothing decorative.
- **44px minimum tap targets below `md`.**
- TypeScript strict. No `any` — the server repo treats it as an error and this one should match.
- TDD: write the failing test, run it, confirm it fails for the right reason, then implement.
- Never `git stash`. Never `git commit --no-verify`.
- Every commit message ends with exactly ONE trailer line: `Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>`
- **Never run any command against the `slimshot_server` database.** This plan touches only the dashboard repo.

## API Facts (verified in source — do not re-derive)

- Base path for every endpoint: `/api/admin/v1/`
- Controllers: `auth`, `assets`, `kinds`, `categories`, `stats`, `audit-logs`, `jobs`, `settings`
- Success envelope: `{ success: true, data: ... }`
- Error envelope: `{ success: false, error: { code, message, details?, traceId } }`
- Assets: `GET /assets`, `GET /assets/:id`, `POST /assets/upload-ticket`, `POST /assets/finalize`, `PATCH /assets/:id`, `POST /assets/:id/publish`, `POST /assets/:id/unpublish`, `DELETE /assets/:id`
- **`GET /settings` returns `configured: boolean` per setting.** An unconfigured secret renders as an empty field, never as a masked value.
- **`GET /stats/uploads` returns only days that have data.** Zero-fill client-side, or gaps read as zero instead of missing.
- **The grant TTL is 120 seconds server-side; the UI idle lock is 2 minutes.** These are independent timers that drift. The UI must treat an expired grant as an ordinary re-prompt and must never assume its own timer is authoritative.
- **`processorsEnabled` is `false` on the server**, so `POST /assets/finalize` returns status `ready`, never `processing`. Build the status pill to handle `processing` (the enum has it) but do not build a polling flow waiting for a transition that currently never happens.
- **These endpoints do NOT exist.** Do not call them, do not stub UI that implies them: `GET /jobs/failed`, `POST /jobs/:id/retry`, storage-provider CRUD, any user-management endpoint.

## Review Focus

Five things the spec implies but no screen's own tests naturally exercise, most likely to bite first:

1. **A revealed secret surviving a re-lock.** Clearing React state is not enough if the value is also in a ref, a closure, a pending timer, or the query cache. Task 12 tests the cache; the closure/ref path needs its own assertion.
2. **The idle timer not resetting on keystroke**, locking the field mid-type. The spec calls this the trigger that matters most; a timer that resets on render instead of on input looks identical until someone types slowly.
3. **A 401 during the refresh request itself**, causing an infinite refresh loop rather than a redirect to login.
4. **An empty `uploadsOverTime` array** (a brand-new install with no assets) rendering as `NaN` or a crashed sparkline rather than an empty state.
5. **A cursor-paginated endpoint whose `meta` sits beside `data`.** `apiFetch` unwraps `data` and discards `meta`, so `nextCursor` reads as `undefined` and pagination stops after page one with no error. Task 13 adds `apiFetchEnvelope` for this; any future paginated endpoint must use it rather than `apiFetch`.

---

## Task 1: Toolchain and design tokens

**Files:**
- Modify: `package.json`
- Create: `vitest.config.ts`, `vitest.setup.ts`
- Modify: `app/globals.css`
- Create: `lib/cn.ts`, `lib/cn.test.ts`

**Interfaces:**
- Consumes: nothing
- Produces: `cn(...classes)` class merger; CSS custom properties `--bg`, `--surface`, `--elevated`, `--border`, `--text`, `--muted`, `--subtle`, `--brand`, `--success`, `--error`, `--warning`; `npm test` running Vitest

- [ ] **Step 1: Install dependencies**

```bash
npm install @tanstack/react-query lucide-react clsx tailwind-merge
npm install -D vitest @vitejs/plugin-react @testing-library/react @testing-library/jest-dom @testing-library/user-event jsdom
```

- [ ] **Step 2: Add the test script**

In `package.json` `scripts`, add:

```json
"test": "vitest run",
"test:watch": "vitest"
```

- [ ] **Step 3: Write `vitest.config.ts`**

```ts
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vitest/config';
import { resolve } from 'node:path';

export default defineConfig({
  plugins: [react()],
  test: {
    environment: 'jsdom',
    setupFiles: ['./vitest.setup.ts'],
    globals: true,
  },
  resolve: {
    alias: { '@': resolve(__dirname, '.') },
  },
});
```

- [ ] **Step 4: Write `vitest.setup.ts`**

```ts
import '@testing-library/jest-dom/vitest';
```

- [ ] **Step 5: Write the failing test `lib/cn.test.ts`**

```ts
import { describe, expect, it } from 'vitest';
import { cn } from './cn';

describe('cn', () => {
  it('joins class names', () => {
    expect(cn('a', 'b')).toBe('a b');
  });

  it('drops falsy values', () => {
    expect(cn('a', false && 'b', undefined, 'c')).toBe('a c');
  });

  it('lets a later tailwind class win over an earlier conflicting one', () => {
    // Without tailwind-merge this returns "p-2 p-4" and both are emitted,
    // which is how a conditional override silently fails to apply.
    expect(cn('p-2', 'p-4')).toBe('p-4');
  });
});
```

- [ ] **Step 6: Run it and watch it fail**

Run: `npx vitest run lib/cn.test.ts`
Expected: FAIL — `Failed to resolve import "./cn"`.

- [ ] **Step 7: Write `lib/cn.ts`**

```ts
import { type ClassValue, clsx } from 'clsx';
import { twMerge } from 'tailwind-merge';

export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs));
}
```

- [ ] **Step 8: Run it and watch it pass**

Run: `npx vitest run lib/cn.test.ts`
Expected: PASS, 3 tests.

- [ ] **Step 9: Replace `app/globals.css` with the token definitions**

```css
@import "tailwindcss";

:root {
  --bg: #09090B;
  --surface: #18181B;
  --elevated: #27272A;
  --border: #3F3F46;

  --text: #FAFAFA;
  --muted: #A1A1AA;
  --subtle: #71717A;

  --brand-from: #9333EA;
  --brand-to: #6B21A8;
  --brand: linear-gradient(135deg, var(--brand-from) 0%, var(--brand-to) 100%);

  --success: #22C55E;
  --error: #EF4444;
  --warning: #EAB308;
}

@theme inline {
  --color-bg: var(--bg);
  --color-surface: var(--surface);
  --color-elevated: var(--elevated);
  --color-border: var(--border);
  --color-text: var(--text);
  --color-muted: var(--muted);
  --color-subtle: var(--subtle);
  --color-success: var(--success);
  --color-error: var(--error);
  --color-warning: var(--warning);
}

/* The app is dark-only by design (spec section 3). No prefers-color-scheme
   block and no light variables: a light dashboard breaks the requirement that
   this look like the same product as the Flutter app. */
body {
  background: var(--bg);
  color: var(--text);
  font-family: var(--font-jakarta), system-ui, sans-serif;
}
```

- [ ] **Step 10: Commit**

```bash
git add package.json package-lock.json vitest.config.ts vitest.setup.ts app/globals.css lib/cn.ts lib/cn.test.ts
git commit -m "chore: add vitest, query client deps, and the design tokens

Tokens are taken from the Flutter app's app_colors.dart so the two products
match exactly. Dark-only by design: no light variables, because a light
dashboard would break the visual unity the brief asks for.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

## Task 2: Typeface and root layout

**Files:**
- Modify: `app/layout.tsx`
- Create: `app/providers.tsx`

**Interfaces:**
- Consumes: `app/globals.css` from Task 1
- Produces: `<Providers>` wrapping the app in a `QueryClientProvider`; Plus Jakarta Sans loaded as `--font-jakarta`

- [ ] **Step 1: Write `app/providers.tsx`**

```tsx
'use client';

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { useState, type ReactNode } from 'react';

export function Providers({ children }: { children: ReactNode }) {
  // Created in state, not at module scope: a module-level client is shared
  // across requests on the server and would leak one user's cached data into
  // another's response.
  const [client] = useState(
    () =>
      new QueryClient({
        defaultOptions: {
          queries: {
            staleTime: 30_000,
            retry: 1,
            refetchOnWindowFocus: false,
          },
        },
      }),
  );

  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}
```

- [ ] **Step 2: Rewrite `app/layout.tsx`**

```tsx
import type { Metadata } from 'next';
import { Plus_Jakarta_Sans } from 'next/font/google';

import { Providers } from './providers';
import './globals.css';

const jakarta = Plus_Jakarta_Sans({
  subsets: ['latin'],
  variable: '--font-jakarta',
  display: 'swap',
});

export const metadata: Metadata = {
  title: 'SlimShot Admin',
  description: 'Content platform administration',
};

export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en" className={jakarta.variable}>
      <body className="bg-bg text-text antialiased">
        <Providers>{children}</Providers>
      </body>
    </html>
  );
}
```

- [ ] **Step 3: Verify it builds**

Run: `npm run build`
Expected: success. If the font import fails offline, self-host per spec §4 and note the deviation.

- [ ] **Step 4: Commit**

```bash
git add app/layout.tsx app/providers.tsx
git commit -m "feat: add the root layout, Plus Jakarta Sans, and the query provider

The QueryClient is created in component state rather than at module scope,
because a module-level client is shared across server requests and would leak
one user's cached data into another's response.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

## Task 3: API client and error envelope

**Files:**
- Create: `lib/api/types.ts`, `lib/api/client.ts`, `lib/api/client.test.ts`

**Interfaces:**
- Consumes: nothing
- Produces:
  - `ApiError` class with `code`, `message`, `details`, `traceId`, `status`
  - `apiFetch<T>(path, init?): Promise<T>` — unwraps `{ success, data }`, throws `ApiError` on `{ success: false }`
  - `setAccessToken(token: string | null)` / `getAccessToken(): string | null` — module-scoped, memory only

- [ ] **Step 1: Write `lib/api/types.ts`**

```ts
export interface ApiErrorBody {
  code: string;
  message: string;
  details?: Record<string, string[]>;
  traceId: string;
}

export type ApiEnvelope<T> =
  | { success: true; data: T }
  | { success: false; error: ApiErrorBody };
```

- [ ] **Step 2: Write the failing test `lib/api/client.test.ts`**

```ts
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiError, apiFetch, getAccessToken, setAccessToken } from './client';

function mockFetch(body: unknown, status = 200) {
  return vi.fn(async () =>
    new Response(JSON.stringify(body), {
      status,
      headers: { 'content-type': 'application/json' },
    }),
  );
}

afterEach(() => {
  setAccessToken(null);
  vi.unstubAllGlobals();
});

describe('apiFetch', () => {
  it('unwraps the data envelope', async () => {
    vi.stubGlobal('fetch', mockFetch({ success: true, data: { id: 'a1' } }));
    await expect(apiFetch('/assets')).resolves.toEqual({ id: 'a1' });
  });

  it('throws ApiError carrying code, message and traceId', async () => {
    vi.stubGlobal(
      'fetch',
      mockFetch(
        {
          success: false,
          error: { code: 'NOT_FOUND', message: 'Unknown setting: x', traceId: 't-1' },
        },
        404,
      ),
    );

    await expect(apiFetch('/settings/x')).rejects.toMatchObject({
      code: 'NOT_FOUND',
      message: 'Unknown setting: x',
      traceId: 't-1',
      status: 404,
    });
  });

  it('attaches the access token when one is set', async () => {
    const fetchMock = mockFetch({ success: true, data: null });
    vi.stubGlobal('fetch', fetchMock);
    setAccessToken('tok-123');

    await apiFetch('/assets');

    const init = fetchMock.mock.calls[0][1] as RequestInit;
    expect(new Headers(init.headers).get('authorization')).toBe('Bearer tok-123');
  });

  it('sends no authorization header when no token is set', async () => {
    const fetchMock = mockFetch({ success: true, data: null });
    vi.stubGlobal('fetch', fetchMock);

    await apiFetch('/assets');

    const init = fetchMock.mock.calls[0][1] as RequestInit;
    expect(new Headers(init.headers).has('authorization')).toBe(false);
  });

  it('throws a usable ApiError when the body is not JSON at all', async () => {
    // A 502 from a proxy returns HTML, not the API envelope. Blindly calling
    // .json() throws a SyntaxError that tells the user nothing.
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('<html>Bad Gateway</html>', { status: 502 })),
    );

    await expect(apiFetch('/assets')).rejects.toBeInstanceOf(ApiError);
  });

  it('never stores the token anywhere but memory', () => {
    setAccessToken('tok-abc');
    expect(getAccessToken()).toBe('tok-abc');
    // An XSS that can read localStorage must not find a token there.
    expect(JSON.stringify(localStorage)).not.toContain('tok-abc');
    expect(JSON.stringify(sessionStorage)).not.toContain('tok-abc');
  });
});
```

- [ ] **Step 3: Run it and watch it fail**

Run: `npx vitest run lib/api/client.test.ts`
Expected: FAIL — cannot resolve `./client`.

- [ ] **Step 4: Write `lib/api/client.ts`**

```ts
import type { ApiEnvelope, ApiErrorBody } from './types';

export class ApiError extends Error {
  readonly code: string;
  readonly details?: Record<string, string[]>;
  readonly traceId: string;
  readonly status: number;

  constructor(body: ApiErrorBody, status: number) {
    super(body.message);
    this.name = 'ApiError';
    this.code = body.code;
    this.details = body.details;
    this.traceId = body.traceId;
    this.status = status;
  }
}

// Memory only. Never localStorage: an XSS can read localStorage, and the
// whole point of keeping the refresh token in an httpOnly cookie is undone if
// the access token sits somewhere script can reach.
let accessToken: string | null = null;

export function setAccessToken(token: string | null): void {
  accessToken = token;
}

export function getAccessToken(): string | null {
  return accessToken;
}

export const API_BASE =
  process.env.NEXT_PUBLIC_API_BASE ?? 'http://localhost:3000/api/admin/v1';

export async function apiFetch<T>(path: string, init?: RequestInit): Promise<T> {
  const headers = new Headers(init?.headers);
  if (!headers.has('content-type') && init?.body) {
    headers.set('content-type', 'application/json');
  }
  if (accessToken) headers.set('authorization', `Bearer ${accessToken}`);

  const res = await fetch(`${API_BASE}${path}`, { ...init, headers });

  let body: ApiEnvelope<T>;
  try {
    body = (await res.json()) as ApiEnvelope<T>;
  } catch {
    // A proxy 502 returns HTML. Surface something actionable rather than a
    // SyntaxError from deep inside the fetch layer.
    throw new ApiError(
      {
        code: 'NETWORK',
        message: `The server returned an unreadable response (${res.status}).`,
        traceId: 'none',
      },
      res.status,
    );
  }

  if (!body.success) throw new ApiError(body.error, res.status);
  return body.data;
}
```

- [ ] **Step 5: Run it and watch it pass**

Run: `npx vitest run lib/api/client.test.ts`
Expected: PASS, 6 tests.

- [ ] **Step 6: Commit**

```bash
git add lib/api/
git commit -m "feat: add the API client and typed error envelope

The access token lives in a module variable and nowhere else. A token in
localStorage is readable by any XSS, which would defeat keeping the refresh
token in an httpOnly cookie.

A non-JSON body is converted into an ApiError rather than throwing a
SyntaxError, because a proxy 502 returns HTML and the user needs a message.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

## Task 4: Auth route handlers and the refresh interceptor

**Files:**
- Create: `app/api/auth/login/route.ts`, `app/api/auth/refresh/route.ts`, `app/api/auth/logout/route.ts`
- Create: `lib/auth/session.ts`, `lib/auth/session.test.ts`
- Create: `proxy.ts`

**Interfaces:**
- Consumes: `apiFetch`, `setAccessToken` from Task 3
- Produces:
  - `login(email, password): Promise<AdminProfile>`
  - `logout(): Promise<void>`
  - `refreshAccessToken(): Promise<string | null>`
  - `withRefresh<T>(fn): Promise<T>` — runs `fn`, and on a 401 refreshes once and retries exactly once

**IMPORTANT — Next.js 16:** the route-protection file is `proxy.ts` exporting `proxy()`. `middleware.ts` is deprecated. `cookies()` is async and must be awaited.

- [ ] **Step 1: Write `app/api/auth/login/route.ts`**

```ts
import { cookies } from 'next/headers';
import { NextResponse } from 'next/server';

import { API_BASE } from '@/lib/api/client';

const REFRESH_COOKIE = 'slimshot_refresh';

export async function POST(request: Request) {
  const body = (await request.json()) as { email: string; password: string };

  const res = await fetch(`${API_BASE}/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });

  const payload = (await res.json()) as {
    success: boolean;
    data?: { accessToken: string; refreshToken: string; expiresIn: number };
    error?: unknown;
  };

  if (!res.ok || !payload.success || !payload.data) {
    return NextResponse.json(payload, { status: res.status });
  }

  // The refresh token goes into an httpOnly cookie and is never returned to
  // the browser's JavaScript. Only the access token crosses back, and it is
  // held in memory.
  const store = await cookies();
  store.set(REFRESH_COOKIE, payload.data.refreshToken, {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    path: '/',
    maxAge: 60 * 60 * 24 * 30,
  });

  return NextResponse.json(
    { success: true, data: { accessToken: payload.data.accessToken, expiresIn: payload.data.expiresIn } },
    { headers: { 'Cache-Control': 'no-store' } },
  );
}
```

- [ ] **Step 2: Write `app/api/auth/refresh/route.ts`**

```ts
import { cookies } from 'next/headers';
import { NextResponse } from 'next/server';

import { API_BASE } from '@/lib/api/client';

const REFRESH_COOKIE = 'slimshot_refresh';

export async function POST() {
  const store = await cookies();
  const token = store.get(REFRESH_COOKIE)?.value;
  if (!token) {
    return NextResponse.json(
      { success: false, error: { code: 'NO_SESSION', message: 'No session.', traceId: 'none' } },
      { status: 401 },
    );
  }

  const res = await fetch(`${API_BASE}/auth/refresh`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ refreshToken: token }),
  });

  const payload = (await res.json()) as {
    success: boolean;
    data?: { accessToken: string; refreshToken: string; expiresIn: number };
  };

  if (!res.ok || !payload.success || !payload.data) {
    // The server revokes the whole family on reuse detection. Drop the cookie
    // so the next request does not retry a token that is already burned.
    store.delete(REFRESH_COOKIE);
    return NextResponse.json(payload, { status: 401 });
  }

  store.set(REFRESH_COOKIE, payload.data.refreshToken, {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    path: '/',
    maxAge: 60 * 60 * 24 * 30,
  });

  return NextResponse.json(
    { success: true, data: { accessToken: payload.data.accessToken, expiresIn: payload.data.expiresIn } },
    { headers: { 'Cache-Control': 'no-store' } },
  );
}
```

- [ ] **Step 3: Write `app/api/auth/logout/route.ts`**

```ts
import { cookies } from 'next/headers';
import { NextResponse } from 'next/server';

import { API_BASE } from '@/lib/api/client';

const REFRESH_COOKIE = 'slimshot_refresh';

export async function POST() {
  const store = await cookies();
  const token = store.get(REFRESH_COOKIE)?.value;

  if (token) {
    // Best effort: the cookie is cleared regardless, so a failing API call
    // cannot strand the browser in a logged-in-looking state.
    await fetch(`${API_BASE}/auth/logout`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ refreshToken: token }),
    }).catch(() => undefined);
  }

  store.delete(REFRESH_COOKIE);
  return NextResponse.json({ success: true, data: null });
}
```

- [ ] **Step 4: Write the failing test `lib/auth/session.test.ts`**

```ts
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiError, setAccessToken } from '@/lib/api/client';
import { withRefresh } from './session';

afterEach(() => {
  setAccessToken(null);
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function unauthorized() {
  return new ApiError(
    { code: 'UNAUTHORIZED', message: 'Unauthorized', traceId: 't' },
    401,
  );
}

describe('withRefresh', () => {
  it('returns the result when the call succeeds', async () => {
    await expect(withRefresh(async () => 'ok')).resolves.toBe('ok');
  });

  it('refreshes once and retries when the call 401s', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        new Response(JSON.stringify({ success: true, data: { accessToken: 'new-tok' } }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
      ),
    );

    let calls = 0;
    const result = await withRefresh(async () => {
      calls += 1;
      if (calls === 1) throw unauthorized();
      return 'recovered';
    });

    expect(result).toBe('recovered');
    expect(calls).toBe(2);
  });

  it('does NOT retry more than once, so a persistent 401 cannot loop forever', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        new Response(JSON.stringify({ success: true, data: { accessToken: 'new-tok' } }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
      ),
    );

    let calls = 0;
    await expect(
      withRefresh(async () => {
        calls += 1;
        throw unauthorized();
      }),
    ).rejects.toBeInstanceOf(ApiError);

    // One original attempt plus exactly one retry. An unbounded loop here
    // would hammer the API and hang the UI.
    expect(calls).toBe(2);
  });

  it('gives up without retrying when the refresh itself 401s', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        new Response(JSON.stringify({ success: false }), {
          status: 401,
          headers: { 'content-type': 'application/json' },
        }),
      ),
    );

    let calls = 0;
    await expect(
      withRefresh(async () => {
        calls += 1;
        throw unauthorized();
      }),
    ).rejects.toBeInstanceOf(ApiError);

    expect(calls).toBe(1);
  });

  it('does not refresh on a non-401 error', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    await expect(
      withRefresh(async () => {
        throw new ApiError({ code: 'CONFLICT', message: 'nope', traceId: 't' }, 409);
      }),
    ).rejects.toMatchObject({ status: 409 });

    expect(fetchMock).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 5: Run it and watch it fail**

Run: `npx vitest run lib/auth/session.test.ts`
Expected: FAIL — cannot resolve `./session`.

- [ ] **Step 6: Write `lib/auth/session.ts`**

```ts
import { ApiError, apiFetch, setAccessToken } from '@/lib/api/client';

export interface AdminProfile {
  id: string;
  email: string;
  name: string;
  role: 'owner' | 'admin' | 'editor' | 'viewer';
}

export async function login(email: string, password: string): Promise<AdminProfile> {
  const res = await fetch('/api/auth/login', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email, password }),
  });
  const body = (await res.json()) as
    | { success: true; data: { accessToken: string } }
    | { success: false; error: { code: string; message: string; traceId: string } };

  if (!body.success) throw new ApiError(body.error, res.status);

  setAccessToken(body.data.accessToken);
  return apiFetch<AdminProfile>('/auth/me');
}

export async function logout(): Promise<void> {
  setAccessToken(null);
  await fetch('/api/auth/logout', { method: 'POST' });
}

export async function refreshAccessToken(): Promise<string | null> {
  const res = await fetch('/api/auth/refresh', { method: 'POST' });
  if (!res.ok) return null;

  const body = (await res.json()) as
    | { success: true; data: { accessToken: string } }
    | { success: false };

  if (!body.success) return null;
  setAccessToken(body.data.accessToken);
  return body.data.accessToken;
}

/**
 * Runs `fn`, and on a 401 refreshes the access token and retries EXACTLY once.
 *
 * The retry is capped deliberately. An unbounded refresh-on-401 loop is the
 * classic form of this bug: the token is genuinely invalid, every retry 401s,
 * and the UI hangs while the API is hammered.
 */
export async function withRefresh<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    if (!(err instanceof ApiError) || err.status !== 401) throw err;

    const token = await refreshAccessToken();
    if (!token) throw err;

    return fn();
  }
}
```

- [ ] **Step 7: Run it and watch it pass**

Run: `npx vitest run lib/auth/session.test.ts`
Expected: PASS, 5 tests.

- [ ] **Step 8: Write `proxy.ts` (NOT `middleware.ts`)**

```ts
import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';

const REFRESH_COOKIE = 'slimshot_refresh';

/**
 * Next.js 16 renamed `middleware` to `proxy`. This is a convenience guard
 * only: the API rejects unauthorised requests regardless, so this exists to
 * avoid rendering a shell the user cannot populate, not to enforce security.
 */
export function proxy(request: NextRequest) {
  const hasSession = request.cookies.has(REFRESH_COOKIE);
  const isLogin = request.nextUrl.pathname.startsWith('/login');

  if (!hasSession && !isLogin) {
    return NextResponse.redirect(new URL('/login', request.url));
  }
  if (hasSession && isLogin) {
    return NextResponse.redirect(new URL('/', request.url));
  }
  return NextResponse.next();
}

export const config = {
  matcher: ['/((?!api|_next/static|_next/image|favicon.ico).*)'],
};
```

- [ ] **Step 9: Commit**

```bash
git add app/api/auth lib/auth proxy.ts
git commit -m "feat: add auth route handlers, refresh interceptor, and route guard

The refresh token is set as an httpOnly cookie by a route handler and never
reaches browser JavaScript; only the access token crosses back, into memory.

withRefresh retries exactly once. An unbounded refresh-on-401 loop hammers the
API and hangs the UI when the token is genuinely invalid.

Uses proxy.ts, not middleware.ts: Next.js 16 deprecated the middleware file
convention in favour of proxy.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

## Task 5: Primitives — Button, Input, StatusPill, Toast

**Files:**
- Create: `components/ui/button.tsx`, `components/ui/input.tsx`, `components/ui/status-pill.tsx`, `components/ui/status-pill.test.tsx`
- Create: `components/ui/toast.tsx`, `lib/use-toast.ts`

**Interfaces:**
- Consumes: `cn` from Task 1
- Produces:
  - `<Button variant="primary" | "secondary" | "ghost" | "danger" size="sm" | "md">`
  - `<Input>` — `--elevated` background, gradient focus ring
  - `<StatusPill status={AssetStatus} />`
  - `useToast()` returning `{ toast(message, variant?) }`

- [ ] **Step 1: Write the failing test `components/ui/status-pill.test.tsx`**

```tsx
import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { StatusPill } from './status-pill';

describe('StatusPill', () => {
  it.each([
    ['draft', 'Draft'],
    ['processing', 'Processing'],
    ['ready', 'Ready'],
    ['published', 'Published'],
    ['archived', 'Archived'],
    ['failed', 'Failed'],
  ] as const)('renders %s as %s', (status, label) => {
    render(<StatusPill status={status} />);
    expect(screen.getByText(label)).toBeInTheDocument();
  });

  it('gives failed and published visually distinct classes', () => {
    const { container: failed } = render(<StatusPill status="failed" />);
    const { container: published } = render(<StatusPill status="published" />);
    expect(failed.firstChild).not.toHaveClass(
      ...Array.from((published.firstChild as HTMLElement).classList),
    );
  });

  it('renders an unknown status without crashing', () => {
    // The API's enum can gain a value before the dashboard knows about it. A
    // lookup that returns undefined and then reads .label would crash the row.
    render(<StatusPill status={'invented' as never} />);
    expect(screen.getByText('invented')).toBeInTheDocument();
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `npx vitest run components/ui/status-pill.test.tsx`
Expected: FAIL — cannot resolve `./status-pill`.

- [ ] **Step 3: Write `components/ui/status-pill.tsx`**

```tsx
import { cn } from '@/lib/cn';

export type AssetStatus =
  | 'draft'
  | 'processing'
  | 'ready'
  | 'published'
  | 'archived'
  | 'failed';

const STYLES: Record<AssetStatus, { label: string; className: string }> = {
  draft: { label: 'Draft', className: 'bg-elevated text-muted border-border' },
  processing: { label: 'Processing', className: 'bg-warning/10 text-warning border-warning/30' },
  ready: { label: 'Ready', className: 'bg-elevated text-text border-border' },
  published: { label: 'Published', className: 'bg-success/10 text-success border-success/30' },
  archived: { label: 'Archived', className: 'bg-elevated text-subtle border-border' },
  failed: { label: 'Failed', className: 'bg-error/10 text-error border-error/30' },
};

export function StatusPill({ status }: { status: AssetStatus }) {
  // Falls back to the raw value rather than crashing: the API's enum may gain
  // a status this build has never heard of.
  const style = STYLES[status] ?? {
    label: String(status),
    className: 'bg-elevated text-muted border-border',
  };

  return (
    <span
      className={cn(
        'inline-flex items-center rounded-full border px-2 py-0.5 text-xs font-medium',
        style.className,
      )}
    >
      {style.label}
    </span>
  );
}
```

- [ ] **Step 4: Run it and watch it pass**

Run: `npx vitest run components/ui/status-pill.test.tsx`
Expected: PASS, 8 tests.

- [ ] **Step 5: Write `components/ui/button.tsx`**

```tsx
'use client';

import { forwardRef, type ButtonHTMLAttributes } from 'react';
import { cn } from '@/lib/cn';

type Variant = 'primary' | 'secondary' | 'ghost' | 'danger';
type Size = 'sm' | 'md';

interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: Variant;
  size?: Size;
}

// The brand gradient appears in exactly four places across the app; the
// primary button is one of them. Do not add it to another variant.
const VARIANTS: Record<Variant, string> = {
  primary:
    'bg-[linear-gradient(135deg,var(--brand-from)_0%,var(--brand-to)_100%)] text-white hover:opacity-90',
  secondary: 'bg-elevated text-text border border-border hover:bg-border',
  ghost: 'text-muted hover:bg-elevated hover:text-text',
  danger: 'bg-error/10 text-error border border-error/30 hover:bg-error/20',
};

const SIZES: Record<Size, string> = {
  // 44px minimum height below md, per the responsive strategy.
  sm: 'h-9 px-3 text-sm md:h-8',
  md: 'h-11 px-4 text-sm md:h-10',
};

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(
  ({ className, variant = 'secondary', size = 'md', ...props }, ref) => (
    <button
      ref={ref}
      className={cn(
        'inline-flex items-center justify-center gap-2 rounded-lg font-medium',
        'transition-opacity duration-150 ease-out',
        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--brand-from)]',
        'disabled:pointer-events-none disabled:opacity-50',
        VARIANTS[variant],
        SIZES[size],
        className,
      )}
      {...props}
    />
  ),
);
Button.displayName = 'Button';
```

- [ ] **Step 6: Write `components/ui/input.tsx`**

```tsx
'use client';

import { forwardRef, type InputHTMLAttributes } from 'react';
import { cn } from '@/lib/cn';

export const Input = forwardRef<HTMLInputElement, InputHTMLAttributes<HTMLInputElement>>(
  ({ className, ...props }, ref) => (
    <input
      ref={ref}
      className={cn(
        'h-11 w-full rounded-lg border border-border bg-elevated px-3 text-sm text-text md:h-10',
        'placeholder:text-subtle',
        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--brand-from)]',
        'disabled:opacity-60',
        className,
      )}
      {...props}
    />
  ),
);
Input.displayName = 'Input';
```

- [ ] **Step 7: Write `lib/use-toast.ts` and `components/ui/toast.tsx`**

```ts
// lib/use-toast.ts
'use client';

import { useSyncExternalStore } from 'react';

export interface Toast {
  id: number;
  message: string;
  variant: 'default' | 'error' | 'success';
}

let toasts: Toast[] = [];
const listeners = new Set<() => void>();
let nextId = 1;

function emit() {
  listeners.forEach((l) => l());
}

export function toast(message: string, variant: Toast['variant'] = 'default'): void {
  const item: Toast = { id: nextId++, message, variant };
  toasts = [...toasts, item];
  emit();
  setTimeout(() => {
    toasts = toasts.filter((t) => t.id !== item.id);
    emit();
  }, 5000);
}

export function useToasts(): Toast[] {
  return useSyncExternalStore(
    (cb) => {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
    () => toasts,
    () => toasts,
  );
}
```

```tsx
// components/ui/toast.tsx
'use client';

import { cn } from '@/lib/cn';
import { useToasts } from '@/lib/use-toast';

export function Toaster() {
  const toasts = useToasts();

  return (
    <div className="pointer-events-none fixed bottom-20 right-4 z-50 flex flex-col gap-2 md:bottom-4">
      {toasts.map((t) => (
        <div
          key={t.id}
          role="status"
          className={cn(
            'pointer-events-auto rounded-lg border px-4 py-3 text-sm shadow-lg',
            'bg-surface text-text',
            t.variant === 'error' && 'border-error/40',
            t.variant === 'success' && 'border-success/40',
            t.variant === 'default' && 'border-border',
          )}
        >
          {t.message}
        </div>
      ))}
    </div>
  );
}
```

- [ ] **Step 8: Add `<Toaster />` to `app/layout.tsx`**

Inside `<Providers>`, after `{children}`.

- [ ] **Step 9: Run the suite and commit**

```bash
npx vitest run
git add components/ui lib/use-toast.ts app/layout.tsx
git commit -m "feat: add button, input, status pill, and toast primitives

StatusPill falls back to the raw value for an unknown status rather than
crashing the row, because the API's enum can gain a value before this build
knows about it.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

## Task 6: App shell — sidebar and bottom tab bar

**Files:**
- Create: `components/shell/nav-items.ts`, `components/shell/sidebar.tsx`, `components/shell/bottom-nav.tsx`, `components/shell/app-shell.tsx`, `components/shell/app-shell.test.tsx`
- Create: `app/(dashboard)/layout.tsx`
- Create: `app/login/page.tsx`

**Interfaces:**
- Consumes: `cn`, `Button`, session helpers
- Produces: `<AppShell>` rendering sidebar at `md`+ and bottom nav below; `NAV_ITEMS` of exactly four peers

- [ ] **Step 1: Write `components/shell/nav-items.ts`**

```ts
import { LayoutDashboard, Music, FolderTree, Settings, type LucideIcon } from 'lucide-react';

export interface NavItem {
  href: string;
  label: string;
  icon: LucideIcon;
}

// Exactly four peers. Audit is reachable from Overview rather than taking a
// fifth slot — five tabs on a phone makes every target smaller.
export const NAV_ITEMS: NavItem[] = [
  { href: '/', label: 'Overview', icon: LayoutDashboard },
  { href: '/assets', label: 'Assets', icon: Music },
  { href: '/categories', label: 'Categories', icon: FolderTree },
  { href: '/settings', label: 'Settings', icon: Settings },
];
```

- [ ] **Step 2: Write the failing test `components/shell/app-shell.test.tsx`**

```tsx
import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { NAV_ITEMS } from './nav-items';
import { AppShell } from './app-shell';

vi.mock('next/navigation', () => ({ usePathname: () => '/assets' }));

describe('AppShell', () => {
  it('renders exactly four navigation peers', () => {
    expect(NAV_ITEMS).toHaveLength(4);
  });

  it('renders both the sidebar and the bottom nav, each responsibility-scoped', () => {
    render(<AppShell><p>content</p></AppShell>);
    expect(screen.getByTestId('sidebar')).toBeInTheDocument();
    expect(screen.getByTestId('bottom-nav')).toBeInTheDocument();
  });

  it('hides the sidebar below md and the bottom nav at md and up', () => {
    render(<AppShell><p>content</p></AppShell>);
    // Both are always mounted; CSS decides which is visible. Asserting the
    // classes is what pins the breakpoint contract.
    expect(screen.getByTestId('sidebar')).toHaveClass('hidden', 'md:flex');
    expect(screen.getByTestId('bottom-nav')).toHaveClass('md:hidden');
  });

  it('marks the active route exactly once', () => {
    render(<AppShell><p>content</p></AppShell>);
    expect(screen.getAllByTestId('nav-active')).toHaveLength(2); // one per nav
  });

  it('renders its children', () => {
    render(<AppShell><p>content</p></AppShell>);
    expect(screen.getByText('content')).toBeInTheDocument();
  });
});
```

- [ ] **Step 3: Run it and watch it fail**

Run: `npx vitest run components/shell/app-shell.test.tsx`
Expected: FAIL — cannot resolve `./app-shell`.

- [ ] **Step 4: Write `components/shell/sidebar.tsx`**

```tsx
'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { cn } from '@/lib/cn';
import { NAV_ITEMS } from './nav-items';

export function Sidebar() {
  const pathname = usePathname();

  return (
    <aside
      data-testid="sidebar"
      className="hidden md:flex w-60 shrink-0 flex-col border-r border-border bg-surface p-4"
    >
      <div className="mb-8 flex items-center gap-2 px-2">
        <div className="h-8 w-8 rounded-lg bg-[linear-gradient(135deg,var(--brand-from)_0%,var(--brand-to)_100%)]" />
        <span className="font-semibold">SlimShot</span>
      </div>

      <nav className="flex flex-col gap-1">
        {NAV_ITEMS.map((item) => {
          const active = pathname === item.href;
          return (
            <Link
              key={item.href}
              href={item.href}
              data-testid={active ? 'nav-active' : undefined}
              className={cn(
                'relative flex items-center gap-3 rounded-lg px-3 py-2 text-sm transition-colors duration-150 ease-out',
                active ? 'bg-elevated text-text' : 'text-muted hover:bg-elevated hover:text-text',
              )}
            >
              {active && (
                <span className="absolute left-0 top-1/2 h-5 w-0.5 -translate-y-1/2 rounded-full bg-[linear-gradient(135deg,var(--brand-from)_0%,var(--brand-to)_100%)]" />
              )}
              <item.icon size={18} />
              {item.label}
            </Link>
          );
        })}
      </nav>
    </aside>
  );
}
```

- [ ] **Step 5: Write `components/shell/bottom-nav.tsx`**

```tsx
'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { cn } from '@/lib/cn';
import { NAV_ITEMS } from './nav-items';

export function BottomNav() {
  const pathname = usePathname();

  return (
    <nav
      data-testid="bottom-nav"
      className="fixed bottom-0 left-0 right-0 z-40 flex border-t border-border bg-surface md:hidden"
    >
      {NAV_ITEMS.map((item) => {
        const active = pathname === item.href;
        return (
          <Link
            key={item.href}
            href={item.href}
            data-testid={active ? 'nav-active' : undefined}
            // 44px minimum target: min-h-14 is 56px, comfortably above it.
            className={cn(
              'relative flex min-h-14 flex-1 flex-col items-center justify-center gap-1 text-xs',
              active ? 'text-text' : 'text-subtle',
            )}
          >
            {active && (
              <span className="absolute top-0 h-0.5 w-10 rounded-full bg-[linear-gradient(135deg,var(--brand-from)_0%,var(--brand-to)_100%)]" />
            )}
            <item.icon size={20} />
            {item.label}
          </Link>
        );
      })}
    </nav>
  );
}
```

- [ ] **Step 6: Write `components/shell/app-shell.tsx`**

```tsx
import type { ReactNode } from 'react';
import { BottomNav } from './bottom-nav';
import { Sidebar } from './sidebar';

export function AppShell({ children }: { children: ReactNode }) {
  return (
    <div className="flex min-h-screen">
      <Sidebar />
      {/* pb-20 clears the fixed bottom nav on phones; md:pb-8 drops it. */}
      <main className="flex-1 px-4 pb-20 pt-6 md:px-8 md:pb-8">{children}</main>
      <BottomNav />
    </div>
  );
}
```

- [ ] **Step 7: Write `app/(dashboard)/layout.tsx`**

```tsx
import { AppShell } from '@/components/shell/app-shell';

export default function DashboardLayout({ children }: { children: React.ReactNode }) {
  return <AppShell>{children}</AppShell>;
}
```

- [ ] **Step 8: Write `app/login/page.tsx`**

A centred card: email input, password input, primary button, error message area. Calls `login()` from Task 4 and routes to `/` on success. Keep it under 80 lines.

- [ ] **Step 9: Run the test and commit**

```bash
npx vitest run components/shell/app-shell.test.tsx
git add components/shell app/\(dashboard\) app/login
git commit -m "feat: add the app shell with sidebar and bottom tab bar

Two navigation components rather than one that restyles: a bottom tab bar and
a sidebar have different affordances, and the tests pin which is visible at
which breakpoint.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

## Task 7: Overview screen

**Files:**
- Create: `lib/api/stats.ts`
- Create: `components/overview/stat-tile.tsx`, `components/overview/sparkline.tsx`, `components/overview/sparkline.test.tsx`, `components/overview/health-strip.tsx`, `components/overview/health-strip.test.tsx`
- Create: `app/(dashboard)/page.tsx`

**Interfaces:**
- Consumes: `apiFetch`, `withRefresh`, `StatusPill`
- Produces: `useStatsSummary()`, `useUploadsOverTime(days)`, `<Sparkline points={number[]} />`

- [ ] **Step 1: Write `lib/api/stats.ts`**

```ts
import { apiFetch } from './client';
import { withRefresh } from '@/lib/auth/session';

export interface StatsSummary {
  totalAssets: number;
  publishedCount: number;
  processingCount: number;
  failedCount: number;
  totalBytes: number;
  byStatus: Record<string, number>;
  byKind: Record<string, number>;
}

export interface UploadPoint {
  date: string;
  count: number;
}

export function fetchSummary(): Promise<StatsSummary> {
  return withRefresh(() => apiFetch<StatsSummary>('/stats/summary'));
}

export function fetchUploads(days: number): Promise<UploadPoint[]> {
  return withRefresh(() => apiFetch<UploadPoint[]>(`/stats/uploads?days=${days}`));
}

/**
 * The API returns ONLY days that have data, so a 30-day window can come back
 * with three entries. Zero-filling here keeps the x-axis honest; plotting the
 * raw array would space three points evenly across a month and imply uploads
 * on days that had none.
 */
export function zeroFill(points: UploadPoint[], days: number, today = new Date()): UploadPoint[] {
  const byDate = new Map(points.map((p) => [p.date, p.count]));
  const out: UploadPoint[] = [];

  for (let i = days - 1; i >= 0; i -= 1) {
    const d = new Date(today);
    d.setUTCDate(d.getUTCDate() - i);
    const key = d.toISOString().slice(0, 10);
    out.push({ date: key, count: byDate.get(key) ?? 0 });
  }
  return out;
}
```

- [ ] **Step 2: Write the failing test `components/overview/sparkline.test.tsx`**

```tsx
import { render } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { zeroFill } from '@/lib/api/stats';
import { Sparkline } from './sparkline';

describe('zeroFill', () => {
  it('pads missing days with zero', () => {
    const today = new Date('2026-09-23T00:00:00Z');
    const filled = zeroFill([{ date: '2026-09-23', count: 5 }], 3, today);
    expect(filled).toEqual([
      { date: '2026-09-21', count: 0 },
      { date: '2026-09-22', count: 0 },
      { date: '2026-09-23', count: 5 },
    ]);
  });

  it('returns all zeroes for an empty series', () => {
    const filled = zeroFill([], 7, new Date('2026-09-23T00:00:00Z'));
    expect(filled).toHaveLength(7);
    expect(filled.every((p) => p.count === 0)).toBe(true);
  });
});

describe('Sparkline', () => {
  it('renders an empty state rather than NaN for no data', () => {
    // A brand-new install has zero assets. Dividing by a zero range produces
    // NaN in the path's d attribute and the chart disappears silently.
    const { container } = render(<Sparkline points={[]} />);
    expect(container.querySelector('path')).toBeNull();
    expect(container.textContent).toContain('No uploads yet');
  });

  it('renders a flat line without NaN when every value is identical', () => {
    const { container } = render(<Sparkline points={[3, 3, 3]} />);
    const d = container.querySelector('path')?.getAttribute('d') ?? '';
    expect(d).not.toContain('NaN');
  });

  it('draws one point per value', () => {
    const { container } = render(<Sparkline points={[1, 5, 2]} />);
    const d = container.querySelector('path')?.getAttribute('d') ?? '';
    expect(d.split('L').length).toBe(3);
  });
});
```

- [ ] **Step 3: Run it and watch it fail**

Run: `npx vitest run components/overview/sparkline.test.tsx`
Expected: FAIL — cannot resolve `./sparkline`.

- [ ] **Step 4: Write `components/overview/sparkline.tsx`**

Hand-rolled SVG, per spec §11 — a 30-point line does not justify a charting dependency.

```tsx
export function Sparkline({ points, className }: { points: number[]; className?: string }) {
  if (points.length === 0) {
    return (
      <div className={className}>
        <p className="py-8 text-center text-sm text-subtle">No uploads yet</p>
      </div>
    );
  }

  const W = 100;
  const H = 30;
  const max = Math.max(...points);
  const min = Math.min(...points);
  // A flat series has range 0. Dividing by it yields NaN and the path vanishes.
  const range = max - min || 1;
  const step = points.length > 1 ? W / (points.length - 1) : 0;

  const d = points
    .map((v, i) => `${i === 0 ? 'M' : 'L'}${(i * step).toFixed(2)},${(H - ((v - min) / range) * H).toFixed(2)}`)
    .join(' ');

  return (
    <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" className={className}>
      <path d={d} fill="none" stroke="var(--brand-from)" strokeWidth={1.5} vectorEffect="non-scaling-stroke" />
    </svg>
  );
}
```

- [ ] **Step 5: Run it and watch it pass**

Run: `npx vitest run components/overview/sparkline.test.tsx`
Expected: PASS, 5 tests.

- [ ] **Step 6: Write the failing test `components/overview/health-strip.test.tsx`**

```tsx
import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { HealthStrip } from './health-strip';

describe('HealthStrip', () => {
  it('renders nothing when the queue is healthy', () => {
    // A panel that says "all healthy" every day trains the reader to ignore
    // it, so the strip only appears when something is actually wrong.
    const { container } = render(<HealthStrip failed={0} delayed={0} />);
    expect(container.firstChild).toBeNull();
  });

  it('renders when there are failures', () => {
    render(<HealthStrip failed={3} delayed={0} />);
    expect(screen.getByText(/3 failed/i)).toBeInTheDocument();
  });

  it('renders when there are delayed jobs', () => {
    render(<HealthStrip failed={0} delayed={7} />);
    expect(screen.getByText(/7 delayed/i)).toBeInTheDocument();
  });
});
```

- [ ] **Step 7: Write `components/overview/health-strip.tsx`**

```tsx
export function HealthStrip({ failed, delayed }: { failed: number; delayed: number }) {
  if (failed === 0 && delayed === 0) return null;

  const parts: string[] = [];
  if (failed > 0) parts.push(`${failed} failed`);
  if (delayed > 0) parts.push(`${delayed} delayed`);

  return (
    <div className="rounded-lg border border-warning/30 bg-warning/10 px-4 py-3 text-sm text-warning">
      Queue needs attention: {parts.join(', ')}.
    </div>
  );
}
```

- [ ] **Step 8: Write `components/overview/stat-tile.tsx` and `app/(dashboard)/page.tsx`**

Four tiles (total, published, processing, failed), the sparkline over 30 days fed through `zeroFill`, recent audit entries, and the health strip. Tiles are `--surface` with a `--border`, no gradient.

- [ ] **Step 9: Run the suite and commit**

```bash
npx vitest run
git add lib/api/stats.ts components/overview app/\(dashboard\)/page.tsx
git commit -m "feat: add the overview screen with stats, sparkline, and health strip

The API returns only days that have data, so the series is zero-filled client
side; plotting the raw array would imply uploads on days that had none.

The sparkline guards a zero range, which is what a flat or empty series
produces, and which otherwise emits NaN into the path and renders nothing.

The health strip renders only when something is wrong, because a panel that
always says healthy trains the reader to ignore it.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

## Task 8: Asset list — the responsive split

**Files:**
- Create: `lib/api/assets.ts`
- Create: `components/assets/asset-table.tsx`, `components/assets/asset-card.tsx`, `components/assets/asset-list.tsx`, `components/assets/asset-list.test.tsx`, `components/assets/artwork.tsx`
- Create: `app/(dashboard)/assets/page.tsx`

**Interfaces:**
- Consumes: `apiFetch`, `withRefresh`, `StatusPill`, `Button`
- Produces: `useAssets(filters)`, `<AssetList assets={...} />` choosing table or cards

- [ ] **Step 1: Write `lib/api/assets.ts`**

```ts
import { apiFetch } from './client';
import { withRefresh } from '@/lib/auth/session';
import type { AssetStatus } from '@/components/ui/status-pill';

export interface Asset {
  id: string;
  kind: string;
  title: string;
  author: string | null;
  status: AssetStatus;
  categoryId: string | null;
  durationMs: number | null;
  createdAt: string;
}

export interface AssetPage {
  items: Asset[];
  nextCursor: string | null;
}

export interface AssetFilters {
  kind?: string;
  status?: AssetStatus;
  categoryId?: string;
  search?: string;
  cursor?: string;
  limit?: number;
}

export function fetchAssets(filters: AssetFilters = {}): Promise<AssetPage> {
  const qs = new URLSearchParams();
  for (const [k, v] of Object.entries(filters)) {
    if (v !== undefined && v !== '') qs.set(k, String(v));
  }
  const suffix = qs.toString() ? `?${qs}` : '';
  return withRefresh(() => apiFetch<AssetPage>(`/assets${suffix}`));
}

export function publishAsset(id: string): Promise<unknown> {
  return withRefresh(() => apiFetch(`/assets/${id}/publish`, { method: 'POST' }));
}

export function unpublishAsset(id: string): Promise<unknown> {
  return withRefresh(() => apiFetch(`/assets/${id}/unpublish`, { method: 'POST' }));
}

export function deleteAsset(id: string): Promise<unknown> {
  return withRefresh(() => apiFetch(`/assets/${id}`, { method: 'DELETE' }));
}
```

- [ ] **Step 2: Write the failing test `components/assets/asset-list.test.tsx`**

```tsx
import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import type { Asset } from '@/lib/api/assets';
import { AssetList } from './asset-list';

const ASSETS: Asset[] = [
  {
    id: 'a1',
    kind: 'audio',
    title: 'Rain Loop',
    author: 'Studio',
    status: 'published',
    categoryId: 'c1',
    durationMs: 65_000,
    createdAt: '2026-09-20T10:00:00Z',
  },
];

describe('AssetList', () => {
  it('renders a table for desktop and cards for mobile, both mounted', () => {
    render(<AssetList assets={ASSETS} />);
    // The core of the responsive claim: two genuinely different components,
    // not one table with different CSS. Both render; CSS picks one.
    expect(screen.getByTestId('asset-table')).toBeInTheDocument();
    expect(screen.getByTestId('asset-cards')).toBeInTheDocument();
  });

  it('hides the table below md and the cards at md and up', () => {
    render(<AssetList assets={ASSETS} />);
    expect(screen.getByTestId('asset-table')).toHaveClass('hidden', 'md:block');
    expect(screen.getByTestId('asset-cards')).toHaveClass('md:hidden');
  });

  it('uses a real table element on desktop', () => {
    render(<AssetList assets={ASSETS} />);
    expect(screen.getByTestId('asset-table').querySelector('table')).not.toBeNull();
  });

  it('does NOT use a table element in the mobile list', () => {
    // A card list built from a table is the exact failure this split exists to
    // avoid — it inherits table layout semantics and cannot reflow.
    render(<AssetList assets={ASSETS} />);
    expect(screen.getByTestId('asset-cards').querySelector('table')).toBeNull();
  });

  it('shows the title in both presentations', () => {
    render(<AssetList assets={ASSETS} />);
    expect(screen.getAllByText('Rain Loop')).toHaveLength(2);
  });

  it('renders an empty state when there are no assets', () => {
    render(<AssetList assets={[]} />);
    expect(screen.getByText(/no assets/i)).toBeInTheDocument();
  });
});
```

- [ ] **Step 3: Run it and watch it fail**

Run: `npx vitest run components/assets/asset-list.test.tsx`
Expected: FAIL — cannot resolve `./asset-list`.

- [ ] **Step 4: Write `components/assets/artwork.tsx`**

```tsx
/**
 * Assets have no thumbnail until a processor generates one, and processors are
 * currently disabled server-side. A gradient keyed on the asset id keeps the
 * layout correct now and gives each asset a stable identity; real artwork
 * drops into the same box later.
 */
export function Artwork({ id, size = 40 }: { id: string; size?: number }) {
  let hash = 0;
  for (let i = 0; i < id.length; i += 1) hash = (hash * 31 + id.charCodeAt(i)) % 360;

  return (
    <div
      className="shrink-0 rounded-md"
      style={{
        width: size,
        height: size,
        background: `linear-gradient(135deg, hsl(${hash} 45% 35%), hsl(${(hash + 40) % 360} 45% 25%))`,
      }}
    />
  );
}
```

- [ ] **Step 5: Write `components/assets/asset-table.tsx`**

A real `<table>` with columns: artwork, title, author, duration, status pill, created, actions. Rows hover to `--elevated`. Wrapped in a `div` with `data-testid="asset-table"` and `className="hidden md:block"`.

- [ ] **Step 6: Write `components/assets/asset-card.tsx`**

A `<div>`-based card: artwork left, title and author stacked, duration and status pill on a second line, overflow menu right. Minimum height 44px for tap targets. No table elements.

- [ ] **Step 7: Write `components/assets/asset-list.tsx`**

```tsx
import type { Asset } from '@/lib/api/assets';
import { AssetCard } from './asset-card';
import { AssetTable } from './asset-table';

export function AssetList({ assets }: { assets: Asset[] }) {
  if (assets.length === 0) {
    return <p className="py-12 text-center text-sm text-subtle">No assets yet.</p>;
  }

  return (
    <>
      <div data-testid="asset-table" className="hidden md:block">
        <AssetTable assets={assets} />
      </div>
      <div data-testid="asset-cards" className="flex flex-col gap-2 md:hidden">
        {assets.map((a) => (
          <AssetCard key={a.id} asset={a} />
        ))}
      </div>
    </>
  );
}
```

- [ ] **Step 8: Write `app/(dashboard)/assets/page.tsx`**

TanStack Query calling `fetchAssets`. Filter toolbar inline at `md`+; below `md` a "Filters" button opening a bottom sheet. Explicit pager at `md`+, infinite scroll below.

- [ ] **Step 9: Run the suite and commit**

```bash
npx vitest run
git add lib/api/assets.ts components/assets app/\(dashboard\)/assets
git commit -m "feat: add the asset list with separate mobile and desktop presentations

Two components, not one table with responsive CSS. The tests assert the mobile
list contains no table element, because a card list built from a table inherits
table layout semantics and cannot reflow - which is the failure this split
exists to avoid.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

## Task 9: Upload queue

**Files:**
- Create: `lib/upload/queue.ts`, `lib/upload/queue.test.ts`
- Create: `components/upload/upload-drawer.tsx`, `components/upload/upload-row.tsx`

**Interfaces:**
- Consumes: `apiFetch`, `withRefresh`
- Produces: `uploadFile(file, meta, hooks)` running ticket → PUT → finalize; `UploadItem` state machine

- [ ] **Step 1: Write the failing test `lib/upload/queue.test.ts`**

```ts
import { afterEach, describe, expect, it, vi } from 'vitest';
import { uploadFile } from './queue';

afterEach(() => vi.unstubAllGlobals());

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

const FILE = new File(['x'], 'loop.mp3', { type: 'audio/mpeg' });
const META = { kind: 'audio', title: 'Loop', categoryId: 'c1' };

describe('uploadFile', () => {
  it('runs ticket, upload, finalize in order and reports ready', async () => {
    const calls: string[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        calls.push(String(url));
        if (String(url).includes('upload-ticket')) {
          return jsonResponse({ success: true, data: { uploadUrl: 'https://up/1', sessionId: 's1' } });
        }
        if (String(url).includes('finalize')) {
          return jsonResponse({ success: true, data: { assetId: 'a1', status: 'ready' } });
        }
        return new Response(null, { status: 200 });
      }),
    );

    const states: string[] = [];
    const result = await uploadFile(FILE, META, { onState: (s) => states.push(s) });

    expect(result.status).toBe('ready');
    expect(calls[0]).toContain('upload-ticket');
    expect(calls[2]).toContain('finalize');
    expect(states).toEqual(['ticketing', 'uploading', 'finalizing', 'done']);
  });

  it('marks the file failed with the server message when the ticket is refused', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        jsonResponse(
          { success: false, error: { code: 'UNPROCESSABLE', message: 'Unsupported extension', traceId: 't' } },
          422,
        ),
      ),
    );

    const states: string[] = [];
    await expect(
      uploadFile(FILE, META, { onState: (s) => states.push(s) }),
    ).rejects.toMatchObject({ message: 'Unsupported extension' });

    expect(states).toContain('failed');
  });

  it('does not call finalize when the storage PUT fails', async () => {
    // Finalizing an upload that never landed creates an asset row pointing at
    // a file that does not exist.
    const calls: string[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        calls.push(String(url));
        if (String(url).includes('upload-ticket')) {
          return jsonResponse({ success: true, data: { uploadUrl: 'https://up/1', sessionId: 's1' } });
        }
        return new Response(null, { status: 500 });
      }),
    );

    await expect(uploadFile(FILE, META, {})).rejects.toBeTruthy();
    expect(calls.some((c) => c.includes('finalize'))).toBe(false);
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `npx vitest run lib/upload/queue.test.ts`
Expected: FAIL — cannot resolve `./queue`.

- [ ] **Step 3: Write `lib/upload/queue.ts`**

```ts
import { ApiError, apiFetch } from '@/lib/api/client';
import { withRefresh } from '@/lib/auth/session';

export type UploadState =
  | 'queued'
  | 'ticketing'
  | 'uploading'
  | 'finalizing'
  | 'done'
  | 'failed';

export interface UploadMeta {
  kind: string;
  title: string;
  author?: string;
  categoryId?: string;
}

interface Hooks {
  onState?: (state: UploadState) => void;
  onProgress?: (fraction: number) => void;
}

/**
 * Each file runs its own ticket -> PUT -> finalize sequence so one failure
 * does not fail the batch. finalize is reached ONLY after the storage PUT
 * succeeds: finalizing an upload that never landed would create an asset row
 * pointing at a file that does not exist.
 */
export async function uploadFile(
  file: File,
  meta: UploadMeta,
  hooks: Hooks,
): Promise<{ assetId: string; status: string }> {
  try {
    hooks.onState?.('ticketing');
    const ticket = await withRefresh(() =>
      apiFetch<{ uploadUrl: string; sessionId: string }>('/assets/upload-ticket', {
        method: 'POST',
        body: JSON.stringify({
          kind: meta.kind,
          filename: file.name,
          contentType: file.type,
          byteSize: file.size,
        }),
      }),
    );

    hooks.onState?.('uploading');
    const put = await fetch(ticket.uploadUrl, {
      method: 'PUT',
      body: file,
      headers: { 'content-type': file.type },
    });
    if (!put.ok) throw new Error(`Upload failed (${put.status}).`);
    hooks.onProgress?.(1);

    hooks.onState?.('finalizing');
    const result = await withRefresh(() =>
      apiFetch<{ assetId: string; status: string }>('/assets/finalize', {
        method: 'POST',
        body: JSON.stringify({
          sessionId: ticket.sessionId,
          title: meta.title,
          author: meta.author,
          categoryId: meta.categoryId,
        }),
      }),
    );

    hooks.onState?.('done');
    return result;
  } catch (err) {
    hooks.onState?.('failed');
    if (err instanceof ApiError) throw err;
    throw err instanceof Error ? err : new Error('Upload failed.');
  }
}
```

- [ ] **Step 4: Run it and watch it pass**

Run: `npx vitest run lib/upload/queue.test.ts`
Expected: PASS, 3 tests.

- [ ] **Step 5: Write `components/upload/upload-row.tsx` and `upload-drawer.tsx`**

Drag-and-drop zone; each file a row with artwork placeholder, editable title/author/category, a progress bar, and state. A failed row keeps its server message and shows a Retry button. Sheet from bottom below `md`, dialog at `md`+. A floating action button opens it on mobile.

- [ ] **Step 6: Commit**

```bash
git add lib/upload components/upload
git commit -m "feat: add the per-file upload queue

Each file runs its own ticket/PUT/finalize sequence so one failure does not
fail the batch, and finalize is reached only after the storage PUT succeeds -
finalizing an upload that never landed would create an asset row pointing at a
file that does not exist.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

## Task 10: Categories screen

**Files:**
- Create: `lib/api/categories.ts`
- Create: `components/categories/category-tree.tsx`, `components/categories/category-tree.test.tsx`, `components/categories/delete-dialog.tsx`, `components/categories/delete-dialog.test.tsx`
- Create: `app/(dashboard)/categories/page.tsx`

**Interfaces:**
- Consumes: `apiFetch`, `withRefresh`, `ApiError`
- Produces: `fetchTree(kind)`, `createCategory`, `updateCategory`, `reorderCategories`, `deleteCategory`

- [ ] **Step 1: Write `lib/api/categories.ts`**

```ts
import { apiFetch } from './client';
import { withRefresh } from '@/lib/auth/session';

export interface Category {
  id: string;
  kind: string;
  parentId: string | null;
  slug: string;
  name: string;
  description: string | null;
  sortOrder: number;
  isActive: boolean;
  children?: Category[];
}

export function fetchTree(kind: string): Promise<Category[]> {
  return withRefresh(() => apiFetch<Category[]>(`/categories?kind=${encodeURIComponent(kind)}`));
}

export function createCategory(input: {
  kind: string;
  name: string;
  parentId?: string;
}): Promise<Category> {
  return withRefresh(() =>
    apiFetch<Category>('/categories', { method: 'POST', body: JSON.stringify(input) }),
  );
}

export function updateCategory(id: string, input: { name?: string; isActive?: boolean }): Promise<Category> {
  return withRefresh(() =>
    apiFetch<Category>(`/categories/${id}`, { method: 'PATCH', body: JSON.stringify(input) }),
  );
}

export function reorderCategories(items: { id: string; sortOrder: number }[]): Promise<unknown> {
  return withRefresh(() =>
    apiFetch('/categories/reorder', { method: 'POST', body: JSON.stringify({ items }) }),
  );
}

export function deleteCategory(id: string): Promise<unknown> {
  return withRefresh(() => apiFetch(`/categories/${id}`, { method: 'DELETE' }));
}
```

- [ ] **Step 2: Write the failing test `components/categories/delete-dialog.test.tsx`**

```tsx
import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { ApiError } from '@/lib/api/client';
import { DeleteDialog } from './delete-dialog';

describe('DeleteDialog', () => {
  it('shows the asset count from a 409 rather than a generic failure', () => {
    // The count is the one number that makes this error actionable. Falling
    // back to a generic toast loses it.
    const err = new ApiError(
      {
        code: 'CONFLICT',
        message: 'Cannot delete: 12 assets use this category.',
        traceId: 't',
      },
      409,
    );

    render(<DeleteDialog open name="SFX" error={err} onConfirm={() => {}} onClose={() => {}} />);
    expect(screen.getByText(/12 assets use this category/i)).toBeInTheDocument();
  });

  it('offers to view the blocking assets on a 409', () => {
    const err = new ApiError({ code: 'CONFLICT', message: '3 assets use this category.', traceId: 't' }, 409);
    render(<DeleteDialog open name="SFX" error={err} onConfirm={() => {}} onClose={() => {}} />);
    expect(screen.getByRole('link', { name: /view/i })).toBeInTheDocument();
  });

  it('shows a plain confirmation when there is no error yet', () => {
    render(<DeleteDialog open name="SFX" error={null} onConfirm={() => {}} onClose={() => {}} />);
    expect(screen.getByText(/delete "SFX"/i)).toBeInTheDocument();
  });
});
```

- [ ] **Step 3: Run it, watch it fail, then write `delete-dialog.tsx`**

The dialog takes the `ApiError` and, when `status === 409`, renders `error.message` verbatim plus a link to `/assets?categoryId=<id>`.

- [ ] **Step 4: Write the failing test `components/categories/category-tree.test.tsx`**

Assert: children render nested under their parent; a parent of a different kind is not offered as a target when adding a child; renaming calls `updateCategory` with only the changed field.

- [ ] **Step 5: Write `category-tree.tsx` and the page**

Kind selector at the top, tree below, drag to reorder, inline rename on double-click.

- [ ] **Step 6: Run the suite and commit**

```bash
npx vitest run
git add lib/api/categories.ts components/categories app/\(dashboard\)/categories
git commit -m "feat: add the categories tree with a specific delete conflict dialog

A 409 surfaces the API's asset count verbatim and links to the blocking
assets. A generic failure toast would discard the one number that tells the
operator what to do next.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

## Task 11: Settings — non-secret fields

**Files:**
- Create: `lib/api/settings.ts`
- Create: `components/settings/setting-row.tsx`, `components/settings/settings-group.tsx`
- Create: `app/(dashboard)/settings/page.tsx`

**Interfaces:**
- Consumes: `apiFetch`, `withRefresh`
- Produces: `fetchSettings(group)`, `updateSetting(key, value, proof)`, `revealSecret(key, password)`

- [ ] **Step 1: Write `lib/api/settings.ts`**

```ts
import { apiFetch } from './client';
import { withRefresh } from '@/lib/auth/session';

export interface MaskedSetting {
  key: string;
  group: string;
  type: 'string' | 'number' | 'boolean' | 'json';
  isSecret: boolean;
  /** False when the setting has never been set. Render an empty field, not a mask. */
  configured: boolean;
  description: string;
  value: unknown;
}

export interface RevealResult {
  value: string;
  grant: string;
  expiresIn: number;
}

export function fetchSettings(group: string): Promise<MaskedSetting[]> {
  return withRefresh(() => apiFetch<MaskedSetting[]>(`/settings?group=${encodeURIComponent(group)}`));
}

export function updateSetting(
  key: string,
  value: unknown,
  proof: { password?: string; grant?: string } = {},
): Promise<void> {
  return withRefresh(() =>
    apiFetch<void>(`/settings/${encodeURIComponent(key)}`, {
      method: 'PUT',
      body: JSON.stringify({ value, ...proof }),
    }),
  );
}

/**
 * Deliberately NOT wrapped in withRefresh's retry and never cached. A failed
 * reveal feeds the account lockout counter, so an automatic retry spends a
 * second attempt the user did not make.
 */
export function revealSecret(key: string, password: string): Promise<RevealResult> {
  return apiFetch<RevealResult>(`/settings/${encodeURIComponent(key)}/reveal`, {
    method: 'POST',
    body: JSON.stringify({ password }),
  });
}
```

- [ ] **Step 2: Write the failing test `lib/api/field-errors.test.ts`**

```ts
import { describe, expect, it } from 'vitest';
import { ApiError } from './client';
import { fieldErrors } from './field-errors';

describe('fieldErrors', () => {
  it('maps a 422 details object onto field messages', () => {
    const err = new ApiError(
      {
        code: 'UNPROCESSABLE',
        message: 'Validation failed.',
        details: { value: ['must be at least 32 characters'] },
        traceId: 't',
      },
      422,
    );
    expect(fieldErrors(err)).toEqual({ value: 'must be at least 32 characters' });
  });

  it('joins multiple messages for one field', () => {
    const err = new ApiError(
      {
        code: 'UNPROCESSABLE',
        message: 'Validation failed.',
        details: { name: ['too short', 'must be unique'] },
        traceId: 't',
      },
      422,
    );
    expect(fieldErrors(err).name).toBe('too short, must be unique');
  });

  it('returns nothing for a non-422, so a 409 still reaches its own handler', () => {
    const err = new ApiError({ code: 'CONFLICT', message: 'in use', traceId: 't' }, 409);
    expect(fieldErrors(err)).toEqual({});
  });

  it('returns nothing when a 422 carries no details', () => {
    // The API may reject without a per-field breakdown. Reading .details
    // unguarded would throw and lose the toast as well as the field hints.
    const err = new ApiError({ code: 'UNPROCESSABLE', message: 'bad', traceId: 't' }, 422);
    expect(fieldErrors(err)).toEqual({});
  });
});
```

- [ ] **Step 3: Run it, watch it fail, then write `lib/api/field-errors.ts`**

```ts
import { ApiError } from './client';

/**
 * Spec section 9: a 422 maps onto the offending form fields rather than
 * becoming a generic toast. The server returns details as
 * `{ field: string[] }`; anything else falls through to the caller's toast.
 */
export function fieldErrors(err: unknown): Record<string, string> {
  if (!(err instanceof ApiError) || err.status !== 422 || !err.details) return {};

  const out: Record<string, string> = {};
  for (const [field, messages] of Object.entries(err.details)) {
    if (Array.isArray(messages) && messages.length > 0) out[field] = messages.join(', ');
  }
  return out;
}
```

Run: `npx vitest run lib/api/field-errors.test.ts`
Expected: PASS, 4 tests.

- [ ] **Step 4: Write `components/settings/setting-row.tsx`**

Non-secret settings: label, description, inline input (or switch for boolean), save on blur when changed. An unconfigured setting renders an empty input with a "Not set" hint.

On a failed save, call `fieldErrors(err)` and render any message for this setting's key beneath the input in `--error`. If `fieldErrors` returns nothing, fall back to a toast carrying `err.message`.

- [ ] **Step 5: Write `settings-group.tsx` and the page**

Groups come from the API's `group` field. The page is owner-only — if the profile role is not `owner`, render a "You do not have access" panel rather than the form.

- [ ] **Step 6: Commit**

```bash
git add lib/api/settings.ts lib/api/field-errors.ts lib/api/field-errors.test.ts components/settings app/\(dashboard\)/settings
git commit -m "feat: add the settings screen for non-secret fields

revealSecret is deliberately outside the refresh-retry wrapper and is never
cached: a failed reveal feeds the account lockout, so an automatic retry would
spend an attempt the user did not make.

An unconfigured setting renders an empty field rather than a mask, using the
API's configured flag.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

## Task 12: The secret field — lock, reveal, re-lock

The most security-sensitive component in the dashboard. Spec §6.5 is the contract; read it before starting.

**Files:**
- Create: `components/settings/secret-field.tsx`, `components/settings/secret-field.test.tsx`
- Create: `components/settings/password-modal.tsx`
- Create: `lib/use-idle-timer.ts`, `lib/use-idle-timer.test.ts`

**Interfaces:**
- Consumes: `revealSecret`, `updateSetting`, `Input`, `Button`
- Produces: `<SecretField setting={MaskedSetting} />`, `useIdleTimer(ms, onIdle, active)`

- [ ] **Step 1: Write the failing test `lib/use-idle-timer.test.ts`**

```ts
import { renderHook, act } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useIdleTimer } from './use-idle-timer';

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe('useIdleTimer', () => {
  it('fires after the timeout when active', () => {
    const onIdle = vi.fn();
    renderHook(() => useIdleTimer(1000, onIdle, true));
    act(() => { vi.advanceTimersByTime(1000); });
    expect(onIdle).toHaveBeenCalledTimes(1);
  });

  it('does not fire when inactive', () => {
    const onIdle = vi.fn();
    renderHook(() => useIdleTimer(1000, onIdle, false));
    act(() => { vi.advanceTimersByTime(5000); });
    expect(onIdle).not.toHaveBeenCalled();
  });

  it('restarts when reset is called, so active typing never locks mid-type', () => {
    // This is the trigger the spec calls most important. A timer that resets
    // on render instead of on input looks identical until someone types slowly.
    const onIdle = vi.fn();
    const { result } = renderHook(() => useIdleTimer(1000, onIdle, true));

    act(() => { vi.advanceTimersByTime(800); });
    act(() => { result.current.reset(); });
    act(() => { vi.advanceTimersByTime(800); });
    expect(onIdle).not.toHaveBeenCalled();

    act(() => { vi.advanceTimersByTime(300); });
    expect(onIdle).toHaveBeenCalledTimes(1);
  });

  it('clears its timer on unmount', () => {
    const onIdle = vi.fn();
    const { unmount } = renderHook(() => useIdleTimer(1000, onIdle, true));
    unmount();
    act(() => { vi.advanceTimersByTime(2000); });
    // A timer firing after unmount would call a setter on a dead component and
    // keep the closure — and whatever it captured — alive.
    expect(onIdle).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run it, watch it fail, then write `lib/use-idle-timer.ts`**

```ts
'use client';

import { useCallback, useEffect, useRef } from 'react';

export function useIdleTimer(ms: number, onIdle: () => void, active: boolean) {
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const callback = useRef(onIdle);
  callback.current = onIdle;

  const clear = useCallback(() => {
    if (timer.current) {
      clearTimeout(timer.current);
      timer.current = null;
    }
  }, []);

  const reset = useCallback(() => {
    clear();
    if (active) timer.current = setTimeout(() => callback.current(), ms);
  }, [active, clear, ms]);

  useEffect(() => {
    reset();
    return clear;
  }, [reset, clear]);

  return { reset, clear };
}
```

- [ ] **Step 3: Write the failing test `components/settings/secret-field.test.tsx`**

```tsx
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { MaskedSetting } from '@/lib/api/settings';
import { SecretField } from './secret-field';

vi.mock('@/lib/api/settings', async () => {
  const actual = await vi.importActual<typeof import('@/lib/api/settings')>('@/lib/api/settings');
  return {
    ...actual,
    revealSecret: vi.fn(async () => ({ value: 'super-secret-value', grant: 'g-1', expiresIn: 120 })),
    updateSetting: vi.fn(async () => undefined),
  };
});

const SETTING: MaskedSetting = {
  key: 'cloudinary.apiSecret',
  group: 'storage',
  type: 'string',
  isSecret: true,
  configured: true,
  description: 'Cloudinary API secret',
  value: 'clo••••4f2a',
};

let client: QueryClient;

function renderField(setting: MaskedSetting = SETTING) {
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <SecretField setting={setting} />
    </QueryClientProvider>,
  );
}

afterEach(() => vi.clearAllMocks());

describe('SecretField', () => {
  it('shows a constant placeholder, never the API mask', async () => {
    renderField();
    const input = screen.getByLabelText(/cloudinary api secret/i) as HTMLInputElement;
    expect(input.value).toBe('••••••••••');
    // The API mask reveals a prefix and suffix. Rendering it leaks more than
    // the lock implies.
    expect(input.value).not.toContain('clo');
    expect(input.value).not.toContain('4f2a');
  });

  it('renders an empty field when the setting is not configured', () => {
    renderField({ ...SETTING, configured: false, value: null });
    const input = screen.getByLabelText(/cloudinary api secret/i) as HTMLInputElement;
    expect(input.value).toBe('');
  });

  it('is read-only until unlocked', () => {
    renderField();
    expect(screen.getByLabelText(/cloudinary api secret/i)).toHaveAttribute('readonly');
  });

  it('reveals the true value after a correct password and becomes editable', async () => {
    const user = userEvent.setup();
    renderField();

    await user.click(screen.getByRole('button', { name: /reveal/i }));
    await user.type(screen.getByLabelText(/password/i), 'owner-password');
    await user.click(screen.getByRole('button', { name: /unlock/i }));

    await waitFor(() => {
      const input = screen.getByLabelText(/cloudinary api secret/i) as HTMLInputElement;
      expect(input.value).toBe('super-secret-value');
      expect(input).not.toHaveAttribute('readonly');
    });
  });

  it('NEVER writes the password or the revealed value into the query cache', async () => {
    const user = userEvent.setup();
    renderField();

    await user.click(screen.getByRole('button', { name: /reveal/i }));
    await user.type(screen.getByLabelText(/password/i), 'owner-password');
    await user.click(screen.getByRole('button', { name: /unlock/i }));

    await waitFor(() =>
      expect((screen.getByLabelText(/cloudinary api secret/i) as HTMLInputElement).value).toBe(
        'super-secret-value',
      ),
    );

    const dump = JSON.stringify(client.getQueryCache().getAll().map((q) => q.state.data));
    expect(dump).not.toContain('owner-password');
    expect(dump).not.toContain('super-secret-value');
  });

  it('never writes the password or revealed value to storage', async () => {
    const user = userEvent.setup();
    renderField();

    await user.click(screen.getByRole('button', { name: /reveal/i }));
    await user.type(screen.getByLabelText(/password/i), 'owner-password');
    await user.click(screen.getByRole('button', { name: /unlock/i }));

    await waitFor(() =>
      expect((screen.getByLabelText(/cloudinary api secret/i) as HTMLInputElement).value).toBe(
        'super-secret-value',
      ),
    );

    expect(JSON.stringify(localStorage)).not.toContain('super-secret-value');
    expect(JSON.stringify(sessionStorage)).not.toContain('super-secret-value');
    expect(JSON.stringify(localStorage)).not.toContain('owner-password');
  });

  it('re-locks when the tab is hidden', async () => {
    const user = userEvent.setup();
    renderField();

    await user.click(screen.getByRole('button', { name: /reveal/i }));
    await user.type(screen.getByLabelText(/password/i), 'owner-password');
    await user.click(screen.getByRole('button', { name: /unlock/i }));
    await waitFor(() =>
      expect((screen.getByLabelText(/cloudinary api secret/i) as HTMLInputElement).value).toBe(
        'super-secret-value',
      ),
    );

    Object.defineProperty(document, 'visibilityState', { value: 'hidden', configurable: true });
    document.dispatchEvent(new Event('visibilitychange'));

    await waitFor(() =>
      expect((screen.getByLabelText(/cloudinary api secret/i) as HTMLInputElement).value).toBe(
        '••••••••••',
      ),
    );
  });

  it('re-locks on unmount, so leaving the route drops the value', async () => {
    const user = userEvent.setup();
    const { unmount } = renderField();

    await user.click(screen.getByRole('button', { name: /reveal/i }));
    await user.type(screen.getByLabelText(/password/i), 'owner-password');
    await user.click(screen.getByRole('button', { name: /unlock/i }));
    await waitFor(() =>
      expect((screen.getByLabelText(/cloudinary api secret/i) as HTMLInputElement).value).toBe(
        'super-secret-value',
      ),
    );

    unmount();
    const dump = JSON.stringify(client.getQueryCache().getAll().map((q) => q.state.data));
    expect(dump).not.toContain('super-secret-value');
  });

  it('does not retry automatically when the password is wrong', async () => {
    const settings = await import('@/lib/api/settings');
    vi.mocked(settings.revealSecret).mockRejectedValueOnce(new Error('Password is incorrect.'));

    const user = userEvent.setup();
    renderField();

    await user.click(screen.getByRole('button', { name: /reveal/i }));
    await user.type(screen.getByLabelText(/password/i), 'wrong');
    await user.click(screen.getByRole('button', { name: /unlock/i }));

    await waitFor(() => expect(screen.getByText(/password is incorrect/i)).toBeInTheDocument());
    // A retry spends a second lockout attempt the user never made.
    expect(settings.revealSecret).toHaveBeenCalledTimes(1);
  });

  it('treats an expired grant as an ordinary re-prompt rather than an error', async () => {
    const settings = await import('@/lib/api/settings');
    vi.mocked(settings.updateSetting).mockRejectedValueOnce(
      Object.assign(new Error('That authorisation has expired.'), { status: 403 }),
    );

    const user = userEvent.setup();
    renderField();

    await user.click(screen.getByRole('button', { name: /reveal/i }));
    await user.type(screen.getByLabelText(/password/i), 'owner-password');
    await user.click(screen.getByRole('button', { name: /unlock/i }));
    await waitFor(() =>
      expect((screen.getByLabelText(/cloudinary api secret/i) as HTMLInputElement).value).toBe(
        'super-secret-value',
      ),
    );

    await user.clear(screen.getByLabelText(/cloudinary api secret/i));
    await user.type(screen.getByLabelText(/cloudinary api secret/i), 'new-value');
    await user.click(screen.getByRole('button', { name: /save/i }));

    // The server grant is 120s and the UI lock is 2min: independent clocks
    // that drift. An expired grant must re-open the password modal, not show
    // a failure the user cannot act on.
    await waitFor(() => expect(screen.getByLabelText(/password/i)).toBeInTheDocument());
  });
});
```

- [ ] **Step 4: Run it and watch it fail**

Run: `npx vitest run components/settings/secret-field.test.tsx`
Expected: FAIL — cannot resolve `./secret-field`.

- [ ] **Step 5: Write `components/settings/password-modal.tsx`**

A dialog with one password input and Unlock/Cancel. It calls an `onSubmit(password)` prop and clears its own input on close. It never stores the password anywhere but local state.

- [ ] **Step 6: Write `components/settings/secret-field.tsx`**

Requirements, all pinned by the tests above:

```
LOCKED_PLACEHOLDER = '••••••••••'   // constant, never the API's mask

state: value (string|null), grant (string|null), modalOpen (boolean), error (string|null)

lock():
  set value = null, grant = null
  clear the idle timer
  // Actually drop the strings. Hiding behind a CSS class leaves them in the
  // heap and in React DevTools.

unlock(password):
  result = await revealSecret(key, password)   // NOT via TanStack Query
  set value = result.value, grant = result.grant
  password is never stored — it lives in the modal's local state and the modal
  clears it on close, success or failure

save():
  await updateSetting(key, value, { grant })
  on 403 -> lock() and re-open the modal (the grant expired)
  on success -> lock() immediately

re-lock triggers:
  1. save success
  2. document visibilitychange -> hidden, and window blur
  3. component unmount (covers navigation)
  4. useIdleTimer(120_000, lock, value !== null), reset on every input change
```

- [ ] **Step 7: Run it and watch it pass**

Run: `npx vitest run components/settings/secret-field.test.tsx`
Expected: PASS, 10 tests.

- [ ] **Step 8: Prove the cache test is not vacuous**

Temporarily change the component to reveal via `useQuery` instead of a direct call. Confirm the "NEVER writes … into the query cache" test FAILS. Restore, confirm it passes. Report what you saw.

- [ ] **Step 9: Commit**

```bash
git add components/settings/secret-field.tsx components/settings/secret-field.test.tsx components/settings/password-modal.tsx lib/use-idle-timer.ts lib/use-idle-timer.test.ts
git commit -m "feat: add the locked secret field with password-gated reveal

The locked state is a constant placeholder, never the API's masked value: the
mask reveals a prefix and suffix, which leaks more than a lock implies.

The reveal bypasses TanStack Query entirely so neither the password nor the
revealed value can enter the cache, and re-locking drops the strings rather
than hiding them behind a class - a value still in memory is recoverable from
a heap snapshot.

An expired grant re-opens the password modal rather than showing an error: the
120s server grant and the 2min UI lock are independent clocks that drift.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

## Task 13: Audit screen and final wiring

**Files:**
- Create: `lib/api/audit.ts`
- Create: `components/audit/audit-table.tsx`
- Create: `app/(dashboard)/audit/page.tsx`
- Modify: `app/(dashboard)/page.tsx` (link Audit from Overview)
- Create: `README.md` section on running against the API

**Interfaces:**
- Consumes: `apiFetch`, `withRefresh`
- Produces: `fetchAuditLogs(filters)` with cursor pagination

- [ ] **Step 1: Write `lib/api/audit.ts`**

```ts
import { apiFetch } from './client';
import { withRefresh } from '@/lib/auth/session';

export interface AuditEntry {
  id: string;
  actorId: string | null;
  actorType: string;
  action: string;
  entityType: string;
  entityId: string | null;
  ip: string | null;
  createdAt: string;
}

export interface AuditPage {
  data: AuditEntry[];
  meta: { nextCursor: string | null };
}

export function fetchAuditLogs(filters: {
  actorId?: string;
  action?: string;
  entityType?: string;
  cursor?: string;
  limit?: number;
} = {}): Promise<AuditPage> {
  const qs = new URLSearchParams();
  for (const [k, v] of Object.entries(filters)) {
    if (v !== undefined && v !== '') qs.set(k, String(v));
  }
  const suffix = qs.toString() ? `?${qs}` : '';
  return withRefresh(() => apiFetchEnvelope<AuditEntry[], { nextCursor: string | null }>(
    `/audit-logs${suffix}`,
  ));
}
```

**This endpoint does not fit `apiFetch`.** It returns `{ success, data, meta }` with `meta` as a SIBLING of `data`, not nested inside it (verified in `admin-audit.controller.ts`). `apiFetch` returns only `data`, so `meta.nextCursor` would be `undefined` and "Load more" would silently never advance past page one.

- [ ] **Step 2: Add `apiFetchEnvelope` to `lib/api/client.ts`**

First the failing test, appended to `lib/api/client.test.ts`:

```ts
describe('apiFetchEnvelope', () => {
  it('returns data AND meta, which apiFetch discards', async () => {
    vi.stubGlobal(
      'fetch',
      mockFetch({ success: true, data: [{ id: 'x' }], meta: { nextCursor: 'c1' } }),
    );

    const page = await apiFetchEnvelope<{ id: string }[], { nextCursor: string | null }>('/audit-logs');
    expect(page.data).toEqual([{ id: 'x' }]);
    expect(page.meta.nextCursor).toBe('c1');
  });

  it('still throws ApiError on a failure envelope', async () => {
    vi.stubGlobal(
      'fetch',
      mockFetch({ success: false, error: { code: 'X', message: 'no', traceId: 't' } }, 400),
    );
    await expect(apiFetchEnvelope('/audit-logs')).rejects.toBeInstanceOf(ApiError);
  });
});
```

Then the implementation, beside `apiFetch`:

```ts
/**
 * Like apiFetch, but keeps `meta` alongside `data`. Cursor-paginated endpoints
 * put nextCursor in meta as a sibling of data, and apiFetch's unwrapping drops
 * it — which makes pagination stop after one page without any error.
 */
export async function apiFetchEnvelope<T, M = unknown>(
  path: string,
  init?: RequestInit,
): Promise<{ data: T; meta: M }> {
  const headers = new Headers(init?.headers);
  if (!headers.has('content-type') && init?.body) {
    headers.set('content-type', 'application/json');
  }
  if (accessToken) headers.set('authorization', `Bearer ${accessToken}`);

  const res = await fetch(`${API_BASE}${path}`, { ...init, headers });

  let body: { success: boolean; data?: T; meta?: M; error?: ApiErrorBody };
  try {
    body = await res.json();
  } catch {
    throw new ApiError(
      {
        code: 'NETWORK',
        message: `The server returned an unreadable response (${res.status}).`,
        traceId: 'none',
      },
      res.status,
    );
  }

  if (!body.success || body.data === undefined) {
    throw new ApiError(
      body.error ?? { code: 'UNKNOWN', message: 'Request failed.', traceId: 'none' },
      res.status,
    );
  }
  return { data: body.data, meta: body.meta as M };
}
```

Run: `npx vitest run lib/api/client.test.ts`
Expected: PASS, 8 tests.

- [ ] **Step 3: Write `components/audit/audit-table.tsx`**

Columns: timestamp, actor, action, entity. Read-only — no delete affordance anywhere, because the API offers none. Below `md`, a stacked list rather than a table.

- [ ] **Step 4: Write `app/(dashboard)/audit/page.tsx`**

Filters for actor, action and entity type. "Load more" using `meta.nextCursor`.

- [ ] **Step 5: Link Audit from Overview**

A "View all" link on the recent-activity card. Audit deliberately does not get a fifth nav tab.

- [ ] **Step 6: Add a README section**

Document `NEXT_PUBLIC_API_BASE`, how to run the server locally, and that the dashboard needs an owner account to reach Settings.

- [ ] **Step 7: Full gates**

```bash
npm test
npm run lint
npm run build
```
All three must pass.

- [ ] **Step 8: Commit**

```bash
git add lib/api/audit.ts components/audit app/\(dashboard\)/audit app/\(dashboard\)/page.tsx README.md
git commit -m "feat: add the audit log screen and wire it from the overview

Read-only with no delete affordance at any permission level, because the API
offers none - an audit log an admin can erase is not an audit log.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

## Deferred

Not built here, because the API does not expose them:

- **Failed-job introspection and retry** (`GET /jobs/failed`, `POST /jobs/:id/retry`). The Overview health strip shows counts from `/jobs/health` only.
- **Storage-provider CRUD** — a second security-sensitive surface; it deserves its own spec and plan rather than being appended here.
- **Admin user management** — owner-only admin CRUD is a later phase per spec §3.
- **End-to-end tests** — the API has its own suite; spec §10 explicitly defers browser E2E.
