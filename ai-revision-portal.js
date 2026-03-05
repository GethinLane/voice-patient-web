// ai-revision-portal.js
// Handles: MemberSpace identity, Stripe link rewriting, credits display, random case, purchase polling
// Hosted at: https://voice-patient-web.vercel.app/ai-revision-portal.js

(() => {

  // ============================================================
  // CONFIG
  // ============================================================
  const API_ORIGIN    = "https://voice-patient-web.vercel.app";
  const STRIPE_HOSTS  = new Set(["buy.stripe.com"]);
  const CASE_COUNT    = 355;
  const RANDOM_BASE   = "https://www.scarevision.ai/ai-patient?case=";

  // ============================================================
  // MEMBERSPACE IDENTITY + STRIPE LINK REWRITING
  // ============================================================
  let currentMember = null;

  function getMemberInfo(detail) {
    return detail?.memberInfo || detail || null;
  }

  function rewriteLinks() {
    if (!currentMember?.email) return;
    const email    = String(currentMember.email).trim();
    const memberId = currentMember.id != null ? String(currentMember.id) : "";

    document.querySelectorAll('a[href*="ms_lock=1"]').forEach(a => {
      try {
        const url = new URL(a.href);
        if (!STRIPE_HOSTS.has(url.host)) return;
        url.searchParams.delete("ms_lock");
        url.searchParams.set("locked_prefilled_email", email);
        if (memberId) url.searchParams.set("client_reference_id", memberId);
        a.href = url.toString();
        a.dataset.msStripeLocked = "1";
      } catch {}
    });
  }

  function setMember(raw) {
    const mi = getMemberInfo(raw);
    if (!mi) return;
    currentMember          = mi;
    window.__msMemberInfo  = mi;
    rewriteLinks();
  }

  document.addEventListener("MemberSpace.member.info", (e) => setMember(e.detail));
  document.addEventListener("MemberSpace.ready", (e) => {
  const mi = e?.detail?.memberInfo || null;
  if (mi) setMember(mi);
});

  document.addEventListener("DOMContentLoaded", () => {
    if (window.MemberSpace && typeof MemberSpace.getMemberInfo === "function") {
      const data = MemberSpace.getMemberInfo();
      if (data?.isLoggedIn && data.memberInfo) setMember(data.memberInfo);
    }
  });

  // Re-run on Squarespace AJAX navigation
  const linkObs = new MutationObserver(() => rewriteLinks());
  linkObs.observe(document.documentElement, { childList: true, subtree: true });

  // ============================================================
  // CREDITS DISPLAY
  // ============================================================
  let lastEmail            = null;
  let expectStripeReturn   = false;
  let pollTimer            = null;
  let inFlight             = null;

  function getCreditsEl() {
    return document.getElementById("creditsRemaining");
  }

  function showBigSpinner() {
    const el = getCreditsEl();
    if (!el) return;
    el.classList.add("is-loading");
    el.innerHTML = `<span class="sca-spinner" aria-label="Loading"></span>`;

    clearTimeout(showBigSpinner._t);
    showBigSpinner._t = setTimeout(() => {
      if (el.classList.contains("is-loading")) setValue("—");
    }, 12000);
  }

  function setValue(v) {
    const el = getCreditsEl();
    if (!el) return;
    el.classList.remove("is-loading");
    el.textContent = (v ?? "—");
  }

  function getDisplayedCredits() {
    const el = getCreditsEl();
    if (!el) return null;
    const n = parseInt((el.textContent || "").trim(), 10);
    return Number.isFinite(n) ? n : null;
  }

  function extractEmail(obj) {
    if (obj?.email) return obj.email;
    if (obj?.isLoggedIn && obj?.memberInfo?.email) return obj.memberInfo.email;
    return null;
  }

  function getEmailFromMS() {
    if (window.MemberSpace?.ready && typeof window.MemberSpace.getMemberInfo === "function") {
      return extractEmail(window.MemberSpace.getMemberInfo());
    }
    return null;
  }

  async function fetchCredits(email, attempt = 1) {
    const userId = window.__msMemberInfo?.id
      ? String(window.__msMemberInfo.id).trim()
      : "";

    const url =
      `${API_ORIGIN}/api/credits?email=${encodeURIComponent(email)}` +
      (userId ? `&userId=${encodeURIComponent(userId)}` : "");

    const controller = new AbortController();
    const t = setTimeout(() => controller.abort(), 8000);

    try {
      const res = await fetch(url, { mode: "cors", signal: controller.signal });
      const ct  = res.headers.get("content-type") || "";
      if (!res.ok || !ct.includes("application/json")) return null;
      const json = await res.json();
      return typeof json?.creditsRemaining === "number" ? json.creditsRemaining : null;
    } catch {
      if (attempt === 1) return fetchCredits(email, 2);
      return null;
    } finally {
      clearTimeout(t);
    }
  }

  async function refreshCredits({ visible = false, force = false } = {}) {
    const email = lastEmail || getEmailFromMS();

    if (!email) {
      if (visible && getDisplayedCredits() === null) showBigSpinner();
      return null;
    }

    lastEmail = email;

    if (!force && inFlight) return inFlight;

    const shouldShowSpinner = visible && getDisplayedCredits() === null;
    if (shouldShowSpinner) showBigSpinner();

    inFlight = (async () => {
      const latest = await fetchCredits(email);
      inFlight = null;

      if (latest === null) {
        if (shouldShowSpinner) setValue("—");
        return null;
      }

      const current = getDisplayedCredits();
      if (current === null || latest !== current) setValue(latest);
      return latest;
    })();

    return inFlight;
  }

  // ============================================================
  // STRIPE RETURN POLLING (fast at first, then slows down)
  // ============================================================
  function stopPoll() {
    if (pollTimer) clearTimeout(pollTimer);
    pollTimer = null;
  }

  function startSilentPollAfterReturn() {
    stopPoll();

    const startValue   = getDisplayedCredits();
    const start        = Date.now();
    let pollInterval   = 2000; // start fast at 2s

    refreshCredits({ visible: false, force: true });

    const doPoll = async () => {
      await refreshCredits({ visible: false, force: true });

      const nowValue = getDisplayedCredits();

      // Credits changed — stop polling
      if (startValue !== null && nowValue !== null && nowValue !== startValue) {
        stopPoll();
        return;
      }

      // Timeout after 90s
      if (Date.now() - start > 90000) {
        stopPoll();
        return;
      }

      // Slow down after 20s
      if (Date.now() - start > 20000) pollInterval = 6000;

      pollTimer = setTimeout(doPoll, pollInterval);
    };

    pollTimer = setTimeout(doPoll, pollInterval);
  }

function onReturnToTab() {
    if (expectStripeReturn) {
      // Returning from Stripe — use aggressive polling
      expectStripeReturn = false;
      startSilentPollAfterReturn();
    } else {
      // Returning from anywhere else — just do one silent refresh
      refreshCredits({ visible: false, force: true });
    }
  }

  window.addEventListener("focus", onReturnToTab);
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") onReturnToTab();
  });

  // Arm Stripe return detection when a pack is clicked
  document.addEventListener("click", (e) => {
    const btn = e.target.closest("a.pack-cta");
    if (!btn) return;
    btn.setAttribute("target", "_blank");
    btn.setAttribute("rel", "noopener");
    expectStripeReturn = true;
  });

  // ============================================================
  // MEMBERSPACE HOOKS FOR CREDITS
  // ============================================================
  function initCreditsHooks() {
    document.addEventListener("MemberSpace.member.info", (e) => {
      const email = extractEmail(e.detail);
      if (email) {
        lastEmail = email;
        refreshCredits({ visible: true, force: true });
      }
    });

    document.addEventListener("MemberSpace.member.logout", () => {
      stopPoll();
      setValue("—");
    });

    document.addEventListener("MemberSpace.ready", () => {
      const email = getEmailFromMS();
      if (email) lastEmail = email;
      refreshCredits({ visible: true, force: true });
    }, { once: true });

    if (window.MemberSpace?.ready) {
      const email = getEmailFromMS();
      if (email) lastEmail = email;
    }
  }

  // ============================================================
  // RANDOM CASE
  // ============================================================
  function randomCaseId() {
    return Math.floor(Math.random() * CASE_COUNT) + 1;
  }

  document.addEventListener("click", (e) => {
    const link = e.target.closest("a.js-random-case");
    if (!link) return;
    e.preventDefault();
    window.location.href = `${RANDOM_BASE}${randomCaseId()}`;
  });

  // ============================================================
  // PACK CTA — open in new tab
  // ============================================================
  function initPackCtaLinks() {
    document.querySelectorAll("a.pack-cta").forEach(a => {
      a.setAttribute("target", "_blank");
      a.setAttribute("rel", "noopener");
    });
  }

  // ============================================================
  // BOOT
  // ============================================================
function boot() {
    showBigSpinner();
    initCreditsHooks();
    initPackCtaLinks();

    // Wait up to 1500ms for MemberSpace identity so we can use userId (hits KV instantly)
    // rather than falling back to slow Airtable on email-only lookup
    let identityWait = 0;
    const waitForIdentity = setInterval(() => {
      identityWait += 100;
      const hasIdentity = !!(window.__msMemberInfo?.id || getEmailFromMS());

      if (hasIdentity || identityWait >= 1500) {
        clearInterval(waitForIdentity);
        if (window.__msMemberInfo?.id) {
          lastEmail = window.__msMemberInfo.email || getEmailFromMS();
        }
        refreshCredits({ visible: true, force: false });
      }
    }, 100);
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", boot, { once: true });
  } else {
    boot();
  }

})();
