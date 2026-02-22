// public/past-grades-page.js
(() => {
  const API_BASE = "https://voice-patient-web.vercel.app";
  const PAGE_SIZE = 12; // show at least 12
  const API_LIMIT = 50; // lighter/faster than 200 (increase if needed)
  const GRADING_PAGE_BASE = "https://www.scarevision.ai/grading";

  // Cache (instant repeat loads)
  const CACHE_KEY = "vp_attempts_cache_v1";
  const CACHE_TTL_MS = 2 * 60 * 1000; // 2 minutes

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
  // Attempts rendering
  // -----------------------------
  let allAttempts = [];
  let selectedSessionId = null;

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

      document.getElementById("vpLoadMore").onclick = () => {
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

    // Show skeleton immediately (better perceived performance)
    renderLoadingSkeleton();

    // Identity (quick)
    const ident = await waitForIdentity(2500);
    if (!ident.userId && !ident.email) {
      els.wrap.style.display = "none";
      showError("MemberSpace identity not detected. Ensure this page is protected by MemberSpace.");
      return;
    }

    // If we have cache, render instantly, then refresh in background
    const cached = readCache(ident);
    if (cached && cached.length) {
      allAttempts = cached;
      if (els.count) els.count.textContent = `${allAttempts.length} attempt(s) found`;
      els.wrap.style.display = "block";
      renderAttemptRows(allAttempts);
      // continue to refresh below (don’t return)
    }

    // Fetch fresh
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

      if (els.count) els.count.textContent = `${allAttempts.length} attempt(s) found`;
      els.wrap.style.display = "block";
      renderAttemptRows(allAttempts);
    } catch (err) {
      // If cache rendered, keep it; otherwise show error
      if (!cached || !cached.length) {
        els.wrap.style.display = "none";
        showError(err?.message || "Failed to load attempts.");
      }
    }
  }

  // Hide the button (we auto-load), but keep it functional as a fallback
  if (els.loadBtn) {
    els.loadBtn.style.display = "none";
    els.loadBtn.addEventListener("click", () => loadAttempts().catch(() => {}));
  }

  // Kick off immediately (in case MemberSpace is already available)
  loadAttempts().catch(() => {});
})();
