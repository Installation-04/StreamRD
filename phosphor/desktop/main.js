(() => {
  "use strict";

  const STORAGE_KEY = "phosphor:appUrl";

  const form = document.getElementById("connect-form");
  const input = document.getElementById("app-url");
  const button = document.getElementById("connect-btn");
  const status = document.getElementById("status");

  function setStatus(message, kind) {
    status.textContent = message || "";
    status.className = "status" + (kind ? " " + kind : "");
  }

  function invoke(url) {
    // `withGlobalTauri` is enabled in tauri.conf.json, so the Tauri v2 API
    // is available as window.__TAURI__ without any bundler/npm dependency.
    // Guard against it being missing anyway (e.g. this file opened directly
    // in a regular browser during UI iteration).
    if (!window.__TAURI__ || !window.__TAURI__.core) {
      setStatus(
        "Tauri runtime not detected (are you opening this file directly in a browser?)",
        "error"
      );
      return Promise.reject(new Error("no tauri runtime"));
    }
    return window.__TAURI__.core.invoke("connect", { url });
  }

  function looksLikeHttpUrl(value) {
    return /^https?:\/\/.+/i.test(value.trim());
  }

  function attemptConnect(url, { isAutoConnect } = {}) {
    button.disabled = true;
    setStatus(isAutoConnect ? "Reconnecting..." : "Connecting...", "busy");

    invoke(url)
      .then(() => {
        // On success the window navigates away to the external app, so
        // this page (and its JS) is about to be torn down. Nothing else
        // to do here.
      })
      .catch((err) => {
        button.disabled = false;
        setStatus(String(err && err.message ? err.message : err), "error");
        if (isAutoConnect) {
          // The saved URL is bad or unreachable at the Tauri layer (e.g.
          // malformed) - fall back to showing the form so the user can fix
          // it, prefilled with what was saved.
          input.value = url;
        }
      });
  }

  form.addEventListener("submit", (event) => {
    event.preventDefault();
    const url = input.value.trim();

    if (!looksLikeHttpUrl(url)) {
      setStatus("Enter a full URL starting with http:// or https://", "error");
      return;
    }

    localStorage.setItem(STORAGE_KEY, url);
    attemptConnect(url);
  });

  // On startup: if a URL was already configured, skip the form entirely and
  // reconnect straight away. Otherwise leave the form visible for input.
  const saved = localStorage.getItem(STORAGE_KEY);
  if (saved && looksLikeHttpUrl(saved)) {
    input.value = saved;
    attemptConnect(saved, { isAutoConnect: true });
  } else {
    input.focus();
  }
})();
