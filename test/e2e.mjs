// Loads the unpacked extension in Chrome for Testing and drives the popup page end to end
// against the real server, with the Chrome DevTools Protocol. No npm packages.
//
//   CHROME_PATH=/path/to/chrome-for-testing/chrome node test/e2e.mjs
//
// Needs port 3000 free (the host permission in manifest.json). Branded Chrome builds
// ignore --load-extension, so use Chrome for Testing or Chromium.
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';

const require = createRequire(import.meta.url);
const { createApp } = require('../server/src/server.js');
const { openStore } = require('../server/src/store.js');
const vectors = require('../server/test/fixtures/moonetix-vectors.json');

const CHROME = process.env.CHROME_PATH;
if (!CHROME) {
  console.error('Set CHROME_PATH to a Chrome for Testing or Chromium binary.');
  process.exit(2);
}
const EXT_DIR = realpathSync(new URL('../extension', import.meta.url).pathname);
// Chrome derives an unpacked extension's ID from its absolute path.
const EXT_ID = [...createHash('sha256').update(EXT_DIR).digest('hex').slice(0, 32)]
  .map((c) => String.fromCharCode(97 + parseInt(c, 16)))
  .join('');
const POPUP = `chrome-extension://${EXT_ID}/popup.html`;

const store = openStore(':memory:');
const server = createApp({
  config: { currencyName: 'Points', sessionDays: 1, appId: vectors.app_id, linkSalt: vectors.link_salt, sub1: 'extension', postbackKey: vectors.postback_key },
  store,
  log: () => {},
});
await new Promise((resolve, reject) => server.once('error', reject).listen(3000, '127.0.0.1', resolve));

const profile = mkdtempSync(path.join(tmpdir(), 'ext-e2e-'));
const chrome = spawn(CHROME, [
  '--headless=new', '--no-sandbox', '--no-first-run', '--no-default-browser-check',
  '--remote-debugging-port=0', `--user-data-dir=${profile}`,
  `--disable-extensions-except=${EXT_DIR}`, `--load-extension=${EXT_DIR}`, 'about:blank',
], { stdio: ['ignore', 'ignore', 'pipe'] });
const wsUrl = await new Promise((resolve, reject) => {
  let buf = '';
  chrome.stderr.on('data', (d) => {
    buf += d;
    const m = /DevTools listening on (ws:\/\/\S+)/.exec(buf);
    if (m) resolve(m[1]);
  });
  chrome.once('exit', (code) => reject(new Error('chrome exited ' + code + '\n' + buf)));
});

// Minimal CDP client.
const ws = new WebSocket(wsUrl);
await new Promise((r) => ws.addEventListener('open', r, { once: true }));
let nextId = 0;
const pending = new Map();
const listeners = [];
ws.addEventListener('message', ({ data }) => {
  const msg = JSON.parse(data);
  if (msg.id && pending.has(msg.id)) {
    const { resolve, reject } = pending.get(msg.id);
    pending.delete(msg.id);
    msg.error ? reject(new Error(msg.error.message)) : resolve(msg.result);
  } else {
    for (const fn of listeners) fn(msg);
  }
});
const send = (method, params = {}, sessionId) => new Promise((resolve, reject) => {
  const id = ++nextId;
  pending.set(id, { resolve, reject });
  ws.send(JSON.stringify({ id, method, params, sessionId }));
});
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const opened = [];
const errors = [];
listeners.push((msg) => {
  if (msg.method === 'Target.targetCreated' || msg.method === 'Target.targetInfoChanged') {
    const { type, url } = msg.params.targetInfo;
    if (type === 'page' && url.startsWith('https://')) opened.push(url);
  }
  if (msg.method === 'Runtime.exceptionThrown') errors.push(msg.params.exceptionDetails.text);
});
await send('Target.setDiscoverTargets', { discover: true });

async function openPage(url) {
  const { targetId } = await send('Target.createTarget', { url });
  const { sessionId } = await send('Target.attachToTarget', { targetId, flatten: true });
  await send('Runtime.enable', {}, sessionId);
  const page = {
    async eval(expression) {
      const r = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }, sessionId);
      if (r.exceptionDetails) throw new Error(r.exceptionDetails.text + ' in ' + expression);
      return r.result.value;
    },
    async waitFor(expression, label, timeout = 15000) {
      const end = Date.now() + timeout;
      while (Date.now() < end) {
        if (await page.eval(expression).catch(() => false)) return;
        await sleep(100);
      }
      throw new Error('timed out waiting for ' + label);
    },
    reload: () => send('Page.reload', {}, sessionId),
    close: () => send('Target.closeTarget', { targetId }),
  };
  await page.waitFor('document.readyState === "complete"', 'load of ' + url);
  return page;
}

let passed = 0;
async function step(name, fn) {
  await fn();
  passed += 1;
  console.log('ok ' + passed + ' - ' + name);
}

try {
  let popup;
  await step('popup loads from the unpacked extension', async () => {
    popup = await openPage(POPUP);
    await popup.waitFor('document.getElementById("signin").offsetHeight > 0', 'sign-in form');
    assert.equal(await popup.eval('document.getElementById("earn").offsetHeight'), 0);
    assert.equal(await popup.eval('document.getElementById("age-row").offsetHeight'), 0);
  });

  await step('every script on the popup ships in the package', async () => {
    const srcs = await popup.eval('[...document.scripts].map((s) => s.src)');
    assert.ok(srcs.length > 0);
    for (const src of srcs) assert.ok(src.startsWith(`chrome-extension://${EXT_ID}/`), src);
  });

  await step('creating an account needs the 16+ box', async () => {
    await popup.eval(`(() => {
      document.getElementById('switch').click();
      const f = document.getElementById('signin');
      f.email.value = 'ana@example.com';
      f.password.value = 'correct horse battery';
      f.requestSubmit();
    })()`);
    await popup.waitFor('document.getElementById("note").textContent.includes("16 or older")', 'age message');
    await popup.eval(`(() => {
      const f = document.getElementById('signin');
      f.over16.checked = true;
      f.requestSubmit();
    })()`);
    await popup.waitFor('document.getElementById("balance").textContent === "0 Points"', 'balance 0');
    assert.equal(await popup.eval('document.getElementById("earn").hidden'), false);
    // Checks the rendered layout, not just the attribute: CSS can override [hidden].
    assert.equal(await popup.eval('document.getElementById("signin").offsetHeight'), 0);
    assert.ok(await popup.eval('document.getElementById("earn").offsetHeight') > 0);
  });

  await step('Earn opens the signed link for account 1 in a new tab', async () => {
    await popup.eval('document.getElementById("earn").click()');
    const expected = vectors.walls['1'] + '&sub1=extension';
    const end = Date.now() + 15000;
    while (!opened.includes(expected) && Date.now() < end) await sleep(100);
    assert.ok(opened.includes(expected), 'opened: ' + JSON.stringify(opened));
  });

  await step('a verified postback shows in the popup after it reopens', async () => {
    const u = new URL(vectors.postbacks.credit_150);
    const res = await fetch('http://127.0.0.1:3000' + u.pathname + u.search);
    assert.equal(await res.text(), 'credited');
    await popup.reload();
    await popup.waitFor('document.getElementById("balance").textContent === "150 Points"', 'balance 150');
  });

  await step('the extension stores a sign-in token only', async () => {
    const session = await popup.eval('chrome.storage.session.get(null)');
    assert.deepEqual(Object.keys(session), ['token']);
    const local = await popup.eval('chrome.storage.local.get(null)');
    assert.deepEqual(local, {});
  });

  await step('the settings page hides the Rewards section', async () => {
    const options = await openPage(`chrome-extension://${EXT_ID}/options.html`);
    await options.waitFor('document.getElementById("show-earn").checked === true', 'checkbox on');
    await options.eval('document.getElementById("show-earn").click()');
    await sleep(200);
    await options.close();
    await popup.reload();
    await popup.waitFor('document.readyState === "complete" && document.getElementById("earn-section").hidden && document.getElementById("earn-section").offsetHeight === 0', 'section hidden');
  });

  await step('no script errors on extension pages', async () => {
    assert.deepEqual(errors, []);
  });
  console.log(`# pass ${passed}`);
} catch (err) {
  console.error('not ok - ' + err.message);
  process.exitCode = 1;
} finally {
  const exited = new Promise((r) => chrome.once('exit', r));
  await send('Browser.close').catch(() => chrome.kill());
  await exited;
  ws.close();
  await sleep(500);
  try {
    rmSync(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  } catch {
    console.error('Could not remove the temporary profile ' + profile);
  }
  server.close();
  store.close();
}
