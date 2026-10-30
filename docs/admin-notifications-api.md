# SlimShot admin API: push notifications

The routes behind System › Notifications. Owner only (`notifications.send`). Base URL
`https://<server>/api/admin/v1`; the usual envelope and admin token. Setup: `docs/deploy/vps-setup.md`
step 8B; the app side: `docs/app-push-api.md`.

## `GET /notifications`

```json
{
  "configured": true,
  "devices": 1284,
  "messages": [
    {
      "id": "cm…",
      "title": "New sounds",
      "body": "Ten new sounds are in.",
      "audience": "all",
      "userId": null,
      "status": "sent",
      "targetCount": 1284,
      "sentCount": 1279,
      "failedCount": 5,
      "error": null,
      "createdAt": "2026-10-30T09:00:00.000Z",
      "finishedAt": "2026-10-30T09:00:04.000Z"
    }
  ]
}
```

- `configured: false`: `FIREBASE_SERVICE_ACCOUNT_BASE64` isn't set; sending answers 503.
- `devices`: installs with notifications on.
- `messages`: the latest 50, newest first. `status` is `sending`, `sent` or `failed` (with
  `error`). Poll while any is `sending`.

## `POST /notifications`

```json
{ "title": "New sounds", "body": "Ten new sounds are in.", "user": "amaka@example.com" }
```

`title` 1–100 characters, `body` 1–1000, both trimmed. `user` (optional): one user, by id, email
or username; left out, it goes to every install. **202** `{ "id": "cm…" }`; the message is sent in
the background.

| Status | `code` | When |
|---|---|---|
| 503 | `PUSH_NOT_CONFIGURED` | Firebase isn't set up on the server |
| 404 | `NOT_FOUND` | no user matches `user` |
| 422 | `PUSH_NO_RECIPIENTS` | nobody (or that user) has notifications on |
| 422 | `VALIDATION_FAILED` | a field is missing, empty or too long |

Every send is audited as `push.sent`.
