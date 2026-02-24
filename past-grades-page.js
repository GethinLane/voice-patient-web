// public/past-grades-page.js
(() => {
  const API_BASE = "https://voice-patient-web.vercel.app";
  const PAGE_SIZE = 12; // show at least 12
  const API_LIMIT = 50; // lighter/faster than 200 (increase if needed)
  const GRADING_PAGE_BASE = "https://www.scarevision.ai/grading";

  // Cache (instant repeat loads)
  const CACHE_KEY = "vp_attempts_cache_v1";
  const CACHE_TTL_MS = 2 * 60 * 1000; // 2 minutes

  // Debug (set to false when done)
  const VP_DEBUG = true;
  const log = (...a) => { if (VP_DEBUG) console.log("[vp-history]", ...a); };
  const warn = (...a) => console.warn("[vp-history]", ...a);
  const errlog = (...a) => console.error("[vp-history]", ...a);

  const els = {
    loadBtn: document.getElementById("vpLoadAttempts"),
    identity: document.getElementById("vpIdentity"),
    count: document.getElementById("vpCount"),
    wrap: document.getElementById("vpAttemptsWrap"),
    body: document.getElementById("vpAttemptsBody"),
    empty: document.getElementById("vpEmpty"),
    err: document.getElementById("vpError"),
  };

  if (!els.wrap || !els.body || !els.identity) return; // page guard

  // Catch global errors so it never "silently crashes"
  window.addEventListener("error", (e) => {
    errlog("window error:", e.message, e.error);
  });
  window.addEventListener("unhandledrejection", (e) => {
    errlog("unhandledrejection:", e.reason);
  });

  function showError(msg) {
    if (!els.err) return;
    els.err.style.display = "block";
    els.err.textContent = msg;
  }
  function clearError() {
    if (!els.err) return;
    els.err.style.display = "none";
    els.err.textContent = "";
  }

  function escapeHtml(s) {
    return String(s || "")
      .replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;").replaceAll("'", "&#039;");
  }

  function formatDate(iso) {
    try {
      const d = new Date(iso);
      if (Number.isNaN(d.getTime())) return iso || "";
      return d.toLocaleString(undefined, {
        year: "numeric", month: "short", day: "2-digit", hour: "2-digit", minute: "2-digit"
      });
    } catch {
      return iso || "";
    }
  }

  async function postJSON(url, body) {
    const r = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body || {}),
    });
    const txt = await r.text();
    let json;
    try { json = JSON.parse(txt); } catch { json = { raw: txt }; }
    if (!r.ok) throw new Error(json.error || json.detail || ("HTTP " + r.status));
    return json;
  }

  // -----------------------------
  // MemberSpace identity
  // -----------------------------
  let lastIdentity = { userId: null, email: null };
  let didAutoLoad = false;

  function setIdentityFromMemberInfo(memberInfo) {
    if (!memberInfo) return;

    const email = memberInfo.email || memberInfo.member?.email || null;
    const userId =
      memberInfo.id ||
      memberInfo.memberId ||
      memberInfo.member?.id ||
      memberInfo.member?.memberId ||
      null;

    lastIdentity = {
      userId: userId ? String(userId) : null,
      email: email ? String(email) : null
    };

    if (lastIdentity.userId || lastIdentity.email) {
      els.identity.textContent = `Signed in as ${lastIdentity.email || ("User " + lastIdentity.userId)}`;
    } else {
      els.identity.textContent = "Signed in, but MemberSpace did not provide an id/email.";
    }
  }

  // Fastest path: when MemberSpace pushes identity, load immediately
  document.addEventListener("MemberSpace.member.info", ({ detail }) => {
    if (detail && detail.memberInfo) setIdentityFromMemberInfo(detail.memberInfo);

    if (!didAutoLoad && (lastIdentity.userId || lastIdentity.email)) {
      didAutoLoad = true;
      loadAttempts().catch(() => {});
    }
  });

  function getMsReadyPromise() {
    return new Promise((resolve) => {
      if (window.MemberSpace && window.MemberSpace.ready) {
        resolve(window.MemberSpace.getMemberInfo());
      } else {
        const handleReady = ({ detail }) => {
          resolve(detail);
          document.removeEventListener("MemberSpace.ready", handleReady);
        };
        document.addEventListener("MemberSpace.ready", handleReady);
      }
    });
  }

  async function waitForIdentity(timeoutMs = 2500) {
    const start = Date.now();

    // Try a quick ready call (short timeout)
    try {
      const detail = await Promise.race([
        getMsReadyPromise(),
        new Promise((_, rej) => setTimeout(() => rej(new Error("MemberSpace not ready yet")), 800)),
      ]);
      if (detail && detail.memberInfo) setIdentityFromMemberInfo(detail.memberInfo);
    } catch (_) {}

    // Light polling (event listener above is the main path)
    while (Date.now() - start < timeoutMs) {
      if (lastIdentity.userId || lastIdentity.email) return lastIdentity;
      await new Promise(r => setTimeout(r, 120));
    }

    els.identity.textContent = "Not signed in (MemberSpace identity not detected).";
    return lastIdentity;
  }

  // -----------------------------
  // Cache helpers
  // -----------------------------
  function readCache(ident) {
    try {
      const raw = sessionStorage.getItem(CACHE_KEY);
      if (!raw) return null;
      const { ts, userId, email, attempts } = JSON.parse(raw);
      if (!ts || Date.now() - ts > CACHE_TTL_MS) return null;

      // Ensure cache belongs to same identity (when present)
      if (userId && ident.userId && userId !== ident.userId) return null;
      if (email && ident.email && email !== ident.email) return null;

      return Array.isArray(attempts) ? attempts : null;
    } catch {
      return null;
    }
  }

  function writeCache(ident, attempts) {
    try {
      sessionStorage.setItem(CACHE_KEY, JSON.stringify({
        ts: Date.now(),
        userId: ident.userId || null,
        email: ident.email || null,
        attempts: Array.isArray(attempts) ? attempts : []
      }));
    } catch {}
  }

  // -----------------------------
  // Attempts rendering + filtering
  // -----------------------------
  let allAttempts = [];
  let selectedSessionId = null;

  const filterEls = {
    btn: document.getElementById("vpFilterBtn"),
    panel: document.getElementById("vpFiltersPanel"),
    case: document.getElementById("vpFilterCase"),
    from: document.getElementById("vpFilterFrom"),
    to: document.getElementById("vpFilterTo"),
    clear: document.getElementById("vpFilterClear"),
  };

  function toStartOfDay(d) {
    const x = new Date(d);
    x.setHours(0, 0, 0, 0);
    return x;
  }
  function toEndOfDay(d) {
    const x = new Date(d);
    x.setHours(23, 59, 59, 999);
    return x;
  }

  function getActiveFilters() {
    // Accept "220" or "Case 220" etc: strip to digits
    const raw = (filterEls.case?.value || "").trim();
    const digits = raw.replace(/[^\d]/g, "");
    const caseNum = digits ? parseInt(digits, 10) : null;
    const hasCase = Number.isFinite(caseNum);

    const fromVal = filterEls.from?.value || "";
    const toVal = filterEls.to?.value || "";

    // Use explicit time so Safari date parsing is stable
    const fromDate = fromVal ? toStartOfDay(new Date(fromVal + "T00:00:00")) : null;
    const toDate = toVal ? toEndOfDay(new Date(toVal + "T00:00:00")) : null;

    return { raw, digits, caseNum, hasCase, fromVal, toVal, fromDate, toDate };
  }

  function safeRenderFiltered() {
    try {
      const f = getActiveFilters();
      log("filters:", f);

      if (!Array.isArray(allAttempts)) {
        warn("allAttempts is not an array", allAttempts);
        return;
      }

      const filtered = allAttempts.filter((a, idx) => {
        // Defensive: a can be undefined or odd
        if (!a || typeof a !== "object") {
          warn("bad attempt item at", idx, a);
          return false;
        }

        // Case
        if (f.hasCase) {
          const aCaseDigits = a.caseId != null ? String(a.caseId).replace(/[^\d]/g, "") : "";
          const aCase = aCaseDigits ? parseInt(aCaseDigits, 10) : NaN;
          if (!Number.isFinite(aCase) || aCase !== f.caseNum) return false;
        }

        // Date
        if (f.fromDate || f.toDate) {
          const t = new Date(a.createdTime);
          if (Number.isNaN(t.getTime())) return false;
          if (f.fromDate && t < f.fromDate) return false;
          if (f.toDate && t > f.toDate) return false;
        }

        return true;
      });

      if (els.count) {
        els.count.textContent = `${filtered.length} shown (of ${allAttempts.length})`;
      }

      if (!filtered.length) {
        els.wrap.style.display = "none";
        els.empty.style.display = "block";
        els.empty.textContent = "No attempts match your filters.";
        return;
      }

      els.empty.style.display = "none";
      els.wrap.style.display = "block";
      renderAttemptRows(filtered);

    } catch (e) {
      errlog("filter/render crashed:", e);
      showError(`Filter crashed: ${e?.message || e}`);
    }
  }

  // Debounce so typing numbers can't hammer the DOM and “feel like a crash”
  let filterTimer = null;
  function scheduleFilter() {
    clearTimeout(filterTimer);
    filterTimer = setTimeout(safeRenderFiltered, 120);
  }

  function setFiltersOpen(isOpen) {
    if (!filterEls.btn || !filterEls.panel) return;
    filterEls.btn.setAttribute("aria-expanded", isOpen ? "true" : "false");
    filterEls.panel.hidden = !isOpen;
  }

  function toggleFilters() {
    const isOpen = filterEls.btn?.getAttribute("aria-expanded") === "true";
    setFiltersOpen(!isOpen);
  }

  // Wire up filter UI
  if (filterEls.btn && filterEls.panel) {
    setFiltersOpen(false);

    filterEls.btn.addEventListener("click", (e) => {
      e.preventDefault();
      toggleFilters();
    });

    // IMPORTANT: inputmode numeric can still type letters on desktop, so normalize in getActiveFilters()
    filterEls.case?.addEventListener("input", scheduleFilter);
    filterEls.from?.addEventListener("change", scheduleFilter);
    filterEls.to?.addEventListener("change", scheduleFilter);

    filterEls.clear?.addEventListener("click", () => {
      if (filterEls.case) filterEls.case.value = "";
      if (filterEls.from) filterEls.from.value = "";
      if (filterEls.to) filterEls.to.value = "";
      if (els.empty) els.empty.textContent = "No attempts found for your account yet.";
      safeRenderFiltered();
      setFiltersOpen(false);
    });

    // Close on outside click
    document.addEventListener("click", (e) => {
      const open = filterEls.btn.getAttribute("aria-expanded") === "true";
      if (!open) return;
      const within = e.target.closest("#vpFiltersPanel") || e.target.closest("#vpFilterBtn");
      if (!within) setFiltersOpen(false);
    });

    // Close on Esc
    document.addEventListener("keydown", (e) => {
      if (e.key === "Escape") setFiltersOpen(false);
    });
  }

  function openGradingPage(sessionId) {
    const url = `${GRADING_PAGE_BASE}?sessionId=${encodeURIComponent(sessionId)}`;
    window.open(url, "_blank", "noopener");
  }

  function renderAttemptRows(attempts) {
    // Sticky header row
    els.body.innerHTML = `
      <div class="vp-attempt vp-attempt-head">
        <div>Date</div>
        <div>Case</div>
        <div></div>
      </div>
    `;

    const initial = attempts.slice(0, PAGE_SIZE);

    for (const a of initial) {
      const row = document.createElement("div");
      row.className = "vp-attempt" + (a.sessionId === selectedSessionId ? " is-selected" : "");
      row.innerHTML = `
        <div>
          <div style="font-weight:700;">${escapeHtml(formatDate(a.createdTime))}</div>
        </div>
        <div>
          <div style="font-weight:700;">${escapeHtml(a.caseId != null ? ("Case " + a.caseId) : "—")}</div>
        </div>
        <div>
          <button class="vp-view" data-session="${escapeHtml(a.sessionId)}">View grading</button>
        </div>
      `;
      els.body.appendChild(row);
    }

    if (attempts.length > PAGE_SIZE) {
      const more = document.createElement("div");
      more.style.padding = "10px 12px";
      more.innerHTML = `
        <button id="vpLoadMore" class="vp-view" style="width:100%; padding:10px; border-style:dashed;">
          Load more attempts
        </button>
      `;
      els.body.appendChild(more);

      const loadMoreBtn = more.querySelector("#vpLoadMore");
      if (loadMoreBtn) {
        loadMoreBtn.onclick = () => {
          const already = els.body.querySelectorAll(".vp-attempt:not(.vp-attempt-head)").length;
          const next = attempts.slice(already, already + PAGE_SIZE);

          for (const a of next) {
            const row = document.createElement("div");
            row.className = "vp-attempt" + (a.sessionId === selectedSessionId ? " is-selected" : "");
            row.innerHTML = `
              <div>
                <div style="font-weight:700;">${escapeHtml(formatDate(a.createdTime))}</div>
              </div>
              <div>
                <div style="font-weight:700;">${escapeHtml(a.caseId != null ? ("Case " + a.caseId) : "—")}</div>
              </div>
              <div>
                <button class="vp-view" data-session="${escapeHtml(a.sessionId)}">View grading</button>
              </div>
            `;
            els.body.insertBefore(row, more);
          }

          if (els.body.querySelectorAll(".vp-attempt:not(.vp-attempt-head)").length >= attempts.length) {
            more.remove();
          }
        };
      }
    }
  }

  function renderLoadingSkeleton() {
    els.wrap.style.display = "block";
    els.empty.style.display = "none";

    els.body.innerHTML = `
      <div class="vp-attempt vp-attempt-head">
        <div>Date</div><div>Case</div><div></div>
      </div>
      ${Array.from({ length: PAGE_SIZE }).map(() => `
        <div class="vp-attempt">
          <div style="opacity:.5">Loading…</div>
          <div style="opacity:.5">—</div>
          <div><button class="vp-view" disabled>View grading</button></div>
        </div>
      `).join("")}
    `;
  }

  // Delegated click handler (Squarespace safe)
  document.addEventListener("click", (e) => {
    const btn = e.target.closest("button[data-session]");
    if (!btn) return;
    const sessionId = btn.getAttribute("data-session");
    if (!sessionId) return;
    openGradingPage(sessionId);
  });

  async function loadAttempts() {
    clearError();
    els.wrap.style.display = "none";
    els.empty.style.display = "none";
    els.body.innerHTML = "";
    if (els.count) els.count.textContent = "";

    renderLoadingSkeleton();

    const ident = await waitForIdentity(2500);
    if (!ident.userId && !ident.email) {
      els.wrap.style.display = "none";
      showError("MemberSpace identity not detected. Ensure this page is protected by MemberSpace.");
      return;
    }

    const cached = readCache(ident);
    if (cached && cached.length) {
      allAttempts = cached;
      if (els.count) els.count.textContent = `${allAttempts.length} attempt(s) found`;
      els.wrap.style.display = "block";
      safeRenderFiltered(); // respects any filters already typed
      // continue to refresh below
    }

    try {
      const data = await postJSON(`${API_BASE}/api/my-attempts`, {
        userId: ident.userId,
        email: ident.email,
        limit: API_LIMIT,
      });

      allAttempts = (data && data.attempts) || [];
      writeCache(ident, allAttempts);

      if (!allAttempts.length) {
        els.wrap.style.display = "none";
        els.empty.style.display = "block";
        return;
      }

      els.wrap.style.display = "block";
      safeRenderFiltered(); // IMPORTANT: always go through filter render

    } catch (e) {
      errlog("loadAttempts fetch failed:", e);
      if (!cached || !cached.length) {
        els.wrap.style.display = "none";
        showError(e?.message || "Failed to load attempts.");
      }
    }
  }

  // Hide the button (we auto-load), but keep it functional as a fallback
  if (els.loadBtn) {
    els.loadBtn.style.display = "none";
    els.loadBtn.addEventListener("click", () => loadAttempts().catch(() => {}));
  }

  loadAttempts().catch(() => {});
})();
