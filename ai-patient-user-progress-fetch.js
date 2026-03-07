// ai-patient-user-progress-fetch.js
// Fetches CompletedCases from /api/progress and applies is-completed to case entries

(() => {

  const API_ORIGIN = "https://voice-patient-web.vercel.app";

  // ============================================================
  // FETCH COMPLETED CASES
  // ============================================================
  async function fetchCompletedCases(userId) {
    if (!userId) return [];

    const url = `${API_ORIGIN}/api/progress?userId=${encodeURIComponent(userId)}`;

    const controller = new AbortController();
    const t = setTimeout(() => controller.abort(), 8000);

    try {
      const res  = await fetch(url, { mode: "cors" , signal: controller.signal });
      if (!res.ok) return [];
      const json = await res.json();
      return Array.isArray(json.completed) ? json.completed : [];
    } catch {
      return [];
    } finally {
      clearTimeout(t);
    }
  }

  // ============================================================
  // APPLY is-completed CLASS TO CASE ENTRIES
  // ============================================================
  function applyCompletedCases(completedCases) {
    if (!completedCases.length) return;

    const completedSet = new Set(completedCases.map(String));

    document.querySelectorAll(".case-entry").forEach(entry => {
      let caseId = entry.dataset.caseId;

      // Fallback — extract from link href e.g. /ai-patient?case=65
      if (!caseId) {
        const link = entry.querySelector("a[href]");
        if (link) {
          const match = link.href.match(/[?&]case=(\d+)/);
          if (match) caseId = match[1];
        }
      }

      if (!caseId) return;

      if (completedSet.has(String(caseId))) {
        entry.classList.add("is-completed");
      } else {
        entry.classList.remove("is-completed");
      }
    });
  }

  // ============================================================
  // OBSERVE DOM — re-apply when case list updates
  // ============================================================
  function observeCaseList() {
    const target = document.getElementById("caseList");
    if (!target) return;

    const observer = new MutationObserver(() => {
      const cached = window.__scaCompletedCases;
      if (cached) applyCompletedCases(cached);
    });

    observer.observe(target, { childList: true, subtree: true });
  }

  // ============================================================
  // GET MEMBER IDENTITY FROM MEMBERSPACE
  // ============================================================
  function getUserIdFromMS() {
    if (window.__msMemberInfo?.id) return String(window.__msMemberInfo.id);
    if (window.MemberSpace?.ready && typeof window.MemberSpace.getMemberInfo === "function") {
      const info = window.MemberSpace.getMemberInfo();
      return info?.memberInfo?.id ? String(info.memberInfo.id) : null;
    }
    return null;
  }

  async function init() {
    const userId = getUserIdFromMS();
    if (!userId) return;

    const completedCases = await fetchCompletedCases(userId);
    window.__scaCompletedCases = completedCases;
    applyCompletedCases(completedCases);
    observeCaseList();
  }

  // ============================================================
  // BOOT — wait for MemberSpace identity
  // ============================================================
  function boot() {
    if (window.MemberSpace?.ready || window.__msMemberInfo?.id) {
      init();
      return;
    }

    document.addEventListener("MemberSpace.member.info", () => init(), { once: true });
    document.addEventListener("MemberSpace.ready", () => init(), { once: true });

    // Fallback poll up to 3s
    let waited = 0;
    const poll = setInterval(() => {
      waited += 200;
      if (window.__msMemberInfo?.id || window.MemberSpace?.ready) {
        clearInterval(poll);
        init();
      }
      if (waited >= 3000) clearInterval(poll);
    }, 200);
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", boot, { once: true });
  } else {
    boot();
  }

})();
