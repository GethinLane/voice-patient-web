// public/past-grades-page.js
(() => {
  const API_BASE = "https://voice-patient-web.vercel.app";
  const PAGE_SIZE = 12;
  const GRADING_PAGE_BASE = "https://www.scarevision.ai/grading";

  const els = {
    loadBtn: document.getElementById("vpLoadAttempts"),
    identity: document.getElementById("vpIdentity"),
    count: document.getElementById("vpCount"),
    wrap: document.getElementById("vpAttemptsWrap"),
    body: document.getElementById("vpAttemptsBody"),
    empty: document.getElementById("vpEmpty"),
    err: document.getElementById("vpError"),
  };

  if (!els.loadBtn) return; // page guard

  function showError(msg) { els.err.style.display = "block"; els.err.textContent = msg; }
  function clearError() { els.err.style.display = "none"; els.err.textContent = ""; }

  function escapeHtml(s) {
    return String(s || "")
      .replaceAll("&","&amp;").replaceAll("<","&lt;").replaceAll(">","&gt;")
      .replaceAll('"',"&quot;").replaceAll("'","&#039;");
  }

  function formatDate(iso) {
    try {
      const d = new Date(iso);
      return d.toLocaleString(undefined, {
        year:"numeric", month:"short", day:"2-digit", hour:"2-digit", minute:"2-digit"
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
    let json; try { json = JSON.parse(txt); } catch { json = { raw: txt }; }
    if (!r.ok) throw new Error(json.error || json.detail || ("HTTP " + r.status));
    return json;
  }

  // -----------------------------
  // MemberSpace identity
  // -----------------------------
  let lastIdentity = { userId: null, email: null };

  function setIdentityFromMemberInfo(memberInfo) {
    if (!memberInfo) return;

    const email = memberInfo.email || memberInfo.member?.email || null;
    const userId =
      memberInfo.id ||
      memberInfo.memberId ||
      memberInfo.member?.id ||
      memberInfo.member?.memberId ||
      null;

    lastIdentity = { userId: userId ? String(userId) : null, email: email ? String(email) : null };

    if (lastIdentity.userId || lastIdentity.email) {
      els.identity.textContent = `Signed in as ${lastIdentity.email || ("User " + lastIdentity.userId)}`;
    } else {
      els.identity.textContent = "Signed in, but MemberSpace did not provide an id/email.";
    }
  }

  document.addEventListener("MemberSpace.member.info", ({ detail }) => {
    if (detail && detail.memberInfo) setIdentityFromMemberInfo(detail.memberInfo);
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

  async function waitForIdentity(timeoutMs = 6000) {
    const start = Date.now();
    try {
      const detail = await Promise.race([
        getMsReadyPromise(),
        new Promise((_, rej) => setTimeout(() => rej(new Error("MemberSpace not ready yet")), 2500)),
      ]);
      if (detail && detail.memberInfo) setIdentityFromMemberInfo(detail.memberInfo);
    } catch (_) {}

    while (Date.now() - start < timeoutMs) {
      if (lastIdentity.userId || lastIdentity.email) return lastIdentity;
      await new Promise(r => setTimeout(r, 150));
    }

    els.identity.textContent = "Not signed in (MemberSpace identity not detected).";
    return lastIdentity;
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
    // Keep your sticky header row (you had it in HTML already)
    els.body.innerHTML = `
      <div class="vp-attempt vp-attempt-head">
        <div>Date</div>
        <div>Case</div>
        <div></div>
      </div>
    `;

    const page = attempts.slice(0, PAGE_SIZE);

    for (const a of page) {
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
    els.count.textContent = "";

    const ident = await waitForIdentity();
    if (!ident.userId && !ident.email) {
      showError("MemberSpace identity not detected. Ensure this page is protected by MemberSpace.");
      return;
    }

    const data = await postJSON(`${API_BASE}/api/my-attempts`, {
      userId: ident.userId,
      email: ident.email,
      limit: 200,
    });

    allAttempts = (data && data.attempts) || [];

    if (!allAttempts.length) {
      els.empty.style.display = "block";
      return;
    }

    els.count.textContent = `${allAttempts.length} attempt(s) found`;
    els.wrap.style.display = "block";
    renderAttemptRows(allAttempts);
  }

// Hide button (we auto-load)
els.loadBtn.style.display = "none";

// Auto-load as soon as we have identity (give it a bit longer)
waitForIdentity(6000).then((ident) => {
  if (ident.userId || ident.email) loadAttempts().catch(() => {});
});
})();
