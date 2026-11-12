// Your backend. Use https in production, and list the same origin in host_permissions.
const API = "http://localhost:3000";
const WALL_ORIGIN = "https://wall.moonetix.com";

// Only a sign-in token is kept here. chrome.storage.session lives in memory and is
// cleared when the browser restarts. No balance and no key is ever stored in the extension.
const store = chrome.storage.session;
const $ = (id) => document.getElementById(id);
const NOTE = $("note").textContent;
let creating = false;

async function api(path, options = {}) {
  const { token } = await store.get("token");
  const res = await fetch(API + path, {
    ...options,
    headers: { "Content-Type": "application/json", Authorization: "Bearer " + (token || "") }
  });
  if (res.status === 401 && token) {
    await store.remove("token");
    throw new Error("signed-out");
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || "http-" + res.status);
  return data;
}

function isWallUrl(value) {
  try {
    return new URL(value).origin === WALL_ORIGIN;
  } catch {
    return false;
  }
}

// Runs every time the popup opens, so a new balance shows as soon as the user clicks the icon.
async function render() {
  const { showEarn = true } = await chrome.storage.sync.get("showEarn");
  $("earn-section").hidden = !showEarn;
  if (!showEarn) return;

  const { token } = await store.get("token");
  $("signin").hidden = Boolean(token);
  $("earn").hidden = !token;
  $("signout").hidden = !token;
  $("balance").textContent = "";
  if (!token) return;
  try {
    const me = await api("/api/me");
    $("balance").textContent = me.balance + " " + me.currency;
  } catch (err) {
    if (err.message === "signed-out") return render();
    $("balance").textContent = "Balance not available right now.";
  }
}

const MESSAGES = {
  wrong_email_or_password: "Wrong email or password.",
  email_taken: "An account with this email already exists.",
  invalid_email: "Enter a valid email address.",
  password_8_to_200_characters: "Use a password of at least 8 characters.",
  must_be_16_or_older: "You must be 16 or older to earn rewards.",
  too_many_attempts: "Too many attempts. Try again in a few minutes."
};

$("switch").addEventListener("click", () => {
  creating = !creating;
  $("age-row").hidden = !creating;
  $("submit").textContent = creating ? "Create account" : "Sign in";
  $("switch").textContent = creating ? "I already have an account" : "Create an account";
});

$("signin").addEventListener("submit", async (event) => {
  event.preventDefault();
  const form = new FormData(event.target);
  const body = { email: form.get("email"), password: form.get("password") };
  if (creating) body.over16 = form.get("over16") === "on";
  try {
    const { token } = await api(creating ? "/api/register" : "/api/login", {
      method: "POST",
      body: JSON.stringify(body)
    });
    await store.set({ token });
    $("note").textContent = NOTE;
  } catch (err) {
    $("note").textContent = MESSAGES[err.message] || "The server is not reachable right now.";
  }
  render();
});

// A fresh link on every click, opened only from this click, in a new tab.
$("earn").addEventListener("click", async (event) => {
  const button = event.target;
  button.disabled = true;
  try {
    const { url } = await api("/api/offerwall-link");
    if (!isWallUrl(url)) throw new Error("unexpected-url");
    // The popup closes once the tab is in front, so nothing important runs after this.
    await chrome.tabs.create({ url });
  } catch (err) {
    if (err.message === "signed-out") return render();
    $("note").textContent = "Offers are not available right now.";
    button.disabled = false;
  }
});

$("signout").addEventListener("click", async () => {
  await api("/api/logout", { method: "POST" }).catch(() => {});
  await store.remove("token");
  render();
});

render();
