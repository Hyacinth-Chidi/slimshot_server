export const DELETION_PAGE_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Delete your SlimShot account</title>
<style>
  body { margin: 0; font: 16px/1.5 system-ui, sans-serif; background: #09090b; color: #fafafa; }
  main { max-width: 420px; margin: 0 auto; padding: 48px 16px; }
  h1 { font-size: 22px; margin: 0 0 8px; }
  p { color: #a1a1aa; }
  label { display: block; margin: 16px 0 6px; font-size: 14px; }
  input { width: 100%; box-sizing: border-box; height: 44px; padding: 0 12px; border-radius: 8px; border: 1px solid #3f3f46; background: #18181b; color: #fafafa; font-size: 16px; }
  button { margin-top: 16px; width: 100%; height: 44px; border: 0; border-radius: 8px; background: #ef4444; color: #fff; font-size: 16px; cursor: pointer; }
  #error { color: #f87171; min-height: 24px; }
</style>
</head>
<body>
<main>
  <h1>Delete your SlimShot account</h1>
  <p>This removes your email, username and sign-in, and forfeits your credits. It cannot be undone.</p>
  <section id="step-email">
    <form id="form-email">
      <label for="email">Your account email</label>
      <input id="email" type="email" autocomplete="email" required>
      <button type="submit">Email me a code</button>
    </form>
  </section>
  <section id="step-code" hidden>
    <p>If an account uses that email, we sent it a 6-digit code.</p>
    <form id="form-code">
      <label for="code">Code</label>
      <input id="code" inputmode="numeric" pattern="[0-9]{6}" maxlength="6" required>
      <button type="submit">Delete my account</button>
    </form>
  </section>
  <section id="step-done" hidden>
    <p>Your account has been deleted.</p>
  </section>
  <p id="error" role="alert"></p>
</main>
<script src="/account-deletion/app.js"></script>
</body>
</html>
`;

export const DELETION_PAGE_JS = `'use strict';
const byId = (id) => document.getElementById(id);
async function post(path, body) {
  const res = await fetch('/api/app/v1/account-deletion/' + path, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  const json = await res.json().catch(() => null);
  if (!json || !json.success) throw new Error((json && json.error && json.error.message) || 'Something went wrong. Try again.');
  return json.data;
}
function show(step) {
  for (const id of ['step-email', 'step-code', 'step-done']) byId(id).hidden = id !== step;
}
function fail(message) { byId('error').textContent = message; }
byId('form-email').addEventListener('submit', async (event) => {
  event.preventDefault();
  fail('');
  try { await post('start', { email: byId('email').value }); show('step-code'); } catch (err) { fail(err.message); }
});
byId('form-code').addEventListener('submit', async (event) => {
  event.preventDefault();
  fail('');
  try { await post('confirm', { email: byId('email').value, code: byId('code').value }); show('step-done'); } catch (err) { fail(err.message); }
});
`;
