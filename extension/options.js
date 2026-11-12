// The Chrome Web Store Ads policy asks that ads are easy to remove.
// This setting hides the Earn section; nothing else in the extension depends on it.
const box = document.getElementById("show-earn");

chrome.storage.sync.get("showEarn").then(({ showEarn = true }) => {
  box.checked = showEarn;
});

box.addEventListener("change", () => {
  chrome.storage.sync.set({ showEarn: box.checked });
});
