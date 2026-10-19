import { render } from 'preact';

function AuthPanel() {
  return (
    <form id="authForm" class="auth-card">
      <img src="/icon.svg" alt="" width="64" height="64" />
      <h1>PocketPhotos</h1>
      <p id="authHint">Sign in to your library</p>
      <input
        id="authUser"
        type="text"
        autocomplete="username"
        autocapitalize="none"
        autocorrect="off"
        spellcheck={false}
        placeholder="User ID"
        required
      />
      <input id="authPass" type="password" autocomplete="current-password" placeholder="Password" required />
      <button type="submit" class="btn primary" id="authBtn">Sign in</button>
      <p id="authErr" class="err" aria-live="polite"></p>
      <p id="authAdmin" class="hidden"><a href="/admin">Open admin page →</a></p>
    </form>
  );
}

const authRoot = document.querySelector('#auth-root');
if (!authRoot) throw new Error('Missing Preact authentication mount point');

render(<AuthPanel />, authRoot);
const legacyAppUrl = new URL('/app.js', window.location.origin).href;
await import(/* @vite-ignore */ legacyAppUrl);
