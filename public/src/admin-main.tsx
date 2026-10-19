import { render } from 'preact';

function AdminGate() {
  return (
    <>
      <h3 id="gateTitle">Admin sign-in</h3>
      <p class="muted" id="gateText" style="margin-top:0"></p>
      <form id="gateForm" class="grid2">
        <input
          type="password"
          id="gatePass"
          placeholder="Admin password or PIN"
          autocomplete="current-password"
          minlength={6}
          required
        />
        <input
          type="password"
          id="gatePass2"
          placeholder="Repeat it"
          autocomplete="new-password"
          minlength={6}
          class="hidden"
        />
        <div class="row" style="grid-column:1/-1">
          <button class="btn primary" type="submit" id="gateBtn">Sign in</button>
          <span class="err" id="gateErr" aria-live="polite"></span>
        </div>
      </form>
    </>
  );
}

const gateRoot = document.querySelector('#gate-root');
if (!gateRoot) throw new Error('Missing Preact admin mount point');

render(<AdminGate />, gateRoot);
const legacyAdminUrl = new URL('/admin.js', window.location.origin).href;
await import(/* @vite-ignore */ legacyAdminUrl);
