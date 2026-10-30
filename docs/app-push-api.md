# SlimShot app API: push notifications

What the app does so the owner can send it notifications from the dashboard
(System › Notifications). Messages go out through Firebase Cloud Messaging (FCM).

## Basics

- **Base URL:** `https://<server>/api/app/v1`.
- **Envelope:** `{ "success": true, "data": … }` or
  `{ "success": false, "error": { "code", "message", "details"?, "traceId" } }`.
- The install's `deviceToken` is the one from `POST /devices` (see `app-credits-api.md` §1).

## 1. Set up Firebase in the app

1. The owner adds the app to the SlimShot Firebase project: an Android app (package name), and an
   iOS app (bundle ID) if there is one. Firebase gives `google-services.json` (Android) and
   `GoogleService-Info.plist` (iOS); put them in the Flutter project as FlutterFire describes.
2. Add `firebase_core` and `firebase_messaging`. On iOS, also upload an APNs key in the Firebase
   console (Project settings › Cloud Messaging) and turn on the Push Notifications capability.
3. Ask for permission (`FirebaseMessaging.instance.requestPermission()`; on Android 13+ this is the
   `POST_NOTIFICATIONS` permission).

## 2. `PUT /push/token`

Send the install's FCM token. No sign-in needed: every install receives messages sent to
everyone, and an install signed in to an account also receives messages sent to that user.

```json
{ "deviceToken": "<from POST /devices>", "token": "<FirebaseMessaging.instance.getToken()>" }
```

`200`: `{ "success": true, "data": { "registered": true } }`

Send it:
- on every app start, once `deviceToken` exists and permission is granted;
- whenever `FirebaseMessaging.instance.onTokenRefresh` fires;
- after signing in, so the token is tied to the account.

To stop notifications (the user turns them off in the app's settings), send `"token": null`:
`{ "registered": false }`.

| Status | `error.code` | What the app does |
|---|---|---|
| 422 | `DEVICE_NOT_REGISTERED` | `POST /devices`, store the new token, retry |
| 422 | `VALIDATION_FAILED` | a field is missing or too long; fix the request |

## 3. What arrives

A standard FCM notification: `notification.title` and `notification.body` as the owner wrote them,
and `data.messageId` (the message's id on the server). The system shows it when the app is in the
background or closed; in the foreground, show it yourself from `FirebaseMessaging.onMessage`.

Tokens Firebase reports as gone (the app was uninstalled, or the token replaced) are removed by
the server on the next send; nothing for the app to do.
