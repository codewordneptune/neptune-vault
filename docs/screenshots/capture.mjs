// Takes the README's screenshots from a running Neptune Vault: four phone
// screens (Home, Receive, the send review, Settings) in the light theme,
// and Home on a wide screen in the dark theme, as WebP files in this folder.
//
// Once:
// 1. Run the app and a Regtest node (README, "Run the web app" and "Local
//    regtest node"): `cd web && npm run dev` serves http://localhost:4400.
// 2. Start Chrome with a DevTools port and a profile of its own, e.g.
//      chrome --headless=new --remote-debugging-port=9222 --user-data-dir=<dir> http://localhost:4400/?developer
// 3. In that profile, make the demo wallet the screenshots show. Choose
//    Regtest in setup's Network line (there because of ?developer), and
//    restore the public test phrase ("abandon" 17 times, then "agent") as
//    "Everyday", answering "Never: this seed phrase is new".
//    On Receive, add address 1 and name it "Alex". From the node, pay
//    12.5 NPT to the main address and 3 NPT to Alex's, mining a block
//    after each. Save the node's address as the contact "Sam", send Sam
//    2 NPT at the Medium fee, and mine a block. Nothing is left pending.
//
// Then, whenever the screens change:
//      VAULT_PASSWORD=<the demo wallet's password> node docs/screenshots/capture.mjs
// VAULT_URL (default http://localhost:4400) and CDP_PORT (default 9222)
// point it elsewhere. It needs Node 22 or later, and nothing else.

import { writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const url = (process.env.VAULT_URL ?? 'http://localhost:4400').replace(/\/$/, '');
const port = process.env.CDP_PORT ?? '9222';
const password = process.env.VAULT_PASSWORD;
if (!password) {
  console.error("Set VAULT_PASSWORD to the demo wallet's password.");
  process.exit(1);
}

const PHONE = { width: 390, height: 844, deviceScaleFactor: 2, mobile: true };
const WIDE = { width: 1280, height: 800, deviceScaleFactor: 1, mobile: false };

// Each shot: its screen and theme, what to do first, and what to undo after.
const SHOTS = [
  { file: 'home.webp', screen: PHONE, scheme: 'light', before: `await go('/');` },
  { file: 'receive.webp', screen: PHONE, scheme: 'light', before: `await go('/receive'); await tab('Address');` },
  {
    file: 'send-review.webp',
    screen: PHONE,
    scheme: 'light',
    before: `
      await go('/send');
      byText('.vault-send-head button', 'Clear')?.click();
      await sleep(400);
      byText('button', 'Choose contact').click();
      await sleep(1000);
      $$('[role=dialog] .vault-pick').find((row) => row.innerText.includes('Sam')).click();
      await sleep(800);
      setValue(field('Amount'), '1.5');
      await sleep(300);
      $$('.mantine-SegmentedControl-label').find((label) => label.textContent.startsWith('Medium'))?.click();
      await sleep(300);
      byText('button', 'Review').click();
      await until(() => $('[role=dialog]'));
      await sleep(1200);`,
    after: `
      byText('[role=dialog] button', 'Edit')?.click();
      await sleep(500);
      byText('.vault-send-head button', 'Clear')?.click();`,
  },
  { file: 'settings.webp', screen: PHONE, scheme: 'light', before: `await go('/settings');` },
  { file: 'wide-home-dark.webp', screen: WIDE, scheme: 'dark', before: `await go('/');` },
];

// Run in the page: small helpers, then unlocking when the lock screen shows.
const PAGE = `
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const $ = (selector) => document.querySelector(selector);
  const $$ = (selector) => [...document.querySelectorAll(selector)];
  const byText = (selector, text) => $$(selector).find((element) => element.textContent.trim() === text);
  const until = async (test, ms = 60000) => {
    for (const end = Date.now() + ms; Date.now() < end; await sleep(200)) if (test()) return;
    throw new Error('timed out');
  };
  // React follows a field through its own value setter and an input event.
  const setValue = (input, value) => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  };
  const field = (label) => $$('main input').find((input) => input.closest('.mantine-InputWrapper-root')?.querySelector('label')?.textContent.startsWith(label));
  const go = async (path) => {
    history.pushState({}, '', path);
    dispatchEvent(new PopStateEvent('popstate'));
    await sleep(1500);
    window.scrollTo(0, 0);
  };
  const tab = async (name) => {
    $$('[role=tab]').find((element) => element.textContent.trim() === name)?.click();
    await sleep(1200);
  };
  if (document.body.innerText.includes('Welcome back')) {
    setValue($('input[type=password]'), PASSWORD);
    byText('button', 'Unlock').click();
    await until(() => !document.body.innerText.includes('Welcome back'), 120000);
    await sleep(2500);
  }
`;

const targets = await (await fetch(`http://127.0.0.1:${port}/json`)).json();
const page = targets.find((t) => t.type === 'page' && t.url.startsWith(url)) ?? targets.find((t) => t.type === 'page');
if (!page) throw new Error(`No page on the DevTools port ${port}.`);
const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((resolve, reject) => {
  ws.onopen = resolve;
  ws.onerror = () => reject(new Error('Could not reach Chrome.'));
});
let id = 0;
const waiting = new Map();
ws.onmessage = (event) => {
  const message = JSON.parse(event.data);
  const pending = waiting.get(message.id);
  if (!pending) return;
  waiting.delete(message.id);
  if (message.error) pending.reject(new Error(message.error.message));
  else pending.resolve(message.result);
};
const send = (method, params = {}) =>
  new Promise((resolve, reject) => {
    id += 1;
    waiting.set(id, { resolve, reject });
    ws.send(JSON.stringify({ id, method, params }));
  });
const run = async (body) => {
  const out = await send('Runtime.evaluate', {
    expression: `(async () => { const PASSWORD = ${JSON.stringify(password)}; ${PAGE} ${body} })()`,
    awaitPromise: true,
    userGesture: true,
  });
  if (out.exceptionDetails) throw new Error(out.exceptionDetails.exception?.description ?? out.exceptionDetails.text);
};
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

if (!page.url.startsWith(url)) {
  await send('Page.navigate', { url: `${url}/` });
  await pause(4000);
}
for (const shot of SHOTS) {
  await send('Emulation.setDeviceMetricsOverride', shot.screen);
  await send('Emulation.setTouchEmulationEnabled', { enabled: shot.screen.mobile, maxTouchPoints: shot.screen.mobile ? 5 : 1 });
  await send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: shot.scheme }] });
  await pause(600);
  // No focus ring left on whatever was pressed last.
  await run(`${shot.before} document.activeElement?.blur?.(); await sleep(400);`);
  const { data } = await send('Page.captureScreenshot', { format: 'webp', quality: 90 });
  await writeFile(join(here, shot.file), Buffer.from(data, 'base64'));
  console.log('saved', shot.file);
  if (shot.after) await run(shot.after);
}
await send('Emulation.clearDeviceMetricsOverride');
ws.close();
