/* bot-page.bundle.js (NO HTML CREATION)
   - Assumes ALL HTML already exists on the page
   - NO orb rendering (sca-orb.js handles it)
   - NO start/stop creation (voice-patient.js binds to existing #startBtn/#stopBtn/#status)
   - Wires accordion toggles
   - Fetches Airtable case data via proxy
   - Populates: name/age, PMHx, DHx, notes (with photos), results
   - Listens to vp:ui to update badge/status/glow/avatar (optional)
*/
(() => {
  const PROXY_BASE_URL =
    window.PROXY_BASE_URL || "https://scarevision-airtable-proxy.vercel.app";

  const ENABLE_PROFILE_FETCH = false;
  const PROFILE_ENDPOINT = "/api/case-profile?caseId=";

  const $ = (id) => document.getElementById(id);
  const clamp01 = (x) => Math.max(0, Math.min(1, Number(x || 0)));

     // ---------------- Timer colouring (driven by vp:ui) ----------------
  function setTimerClass(remainingSec) {
    const el = $("vpTimer");
    if (!el) return;

    el.classList.remove("vpTimer--safe", "vpTimer--warn", "vpTimer--danger");

    const s = Math.max(0, Math.floor(Number(remainingSec)));

    // 12:00 → 7:00 inclusive
    if (s >= 7 * 60) el.classList.add("vpTimer--safe");
    // 6:59 → 1:00 inclusive
    else if (s >= 60) el.classList.add("vpTimer--warn");
    // 0:59 → 0:00
    else el.classList.add("vpTimer--danger");
  }

  // ---------------- Case ID helpers ----------------
  function getCaseIdFromUrl() {
    try {
      const url = new URL(window.location.href);
      const caseParam = url.searchParams.get("case");
      if (caseParam && /^\d+$/.test(caseParam)) return Number(caseParam);

      // support bare ?341
      if (!caseParam && url.search) {
        const bare = url.search.replace(/^\?/, "");
        if (bare && /^\d+$/.test(bare)) return Number(bare);
      }
    } catch {}
    return null;
  }

  function getCaseTableName() {
    const n = getCaseIdFromUrl();
    return n ? `Case ${n}` : null;
  }

  // ---------------- Accordion binding ----------------
  function bindAccordion() {
    const acc = $("scaAccordion");
    if (!acc || acc.__scaBound) return;
    acc.__scaBound = true;

    // Ensure hidden attribute always collapses even if theme CSS is weird
    // (CSS is preferred, but this is a safe fallback)
    const ensureHiddenWorks = () => {
      acc.querySelectorAll(".sca-accBody[hidden]").forEach((el) => {
        el.style.display = "none";
      });
      acc.querySelectorAll(".sca-accBody:not([hidden])").forEach((el) => {
        el.style.display = "";
      });
    };
    ensureHiddenWorks();

    acc.addEventListener(
      "click",
      (e) => {
        const header = e.target.closest(".sca-accHeader");
        if (!header || !acc.contains(header)) return;

        e.preventDefault();

        const item = header.closest(".sca-accItem");
        const body = item?.querySelector(".sca-accBody");
        if (!body) return;

        const expanded = header.getAttribute("aria-expanded") === "true";
        header.setAttribute("aria-expanded", expanded ? "false" : "true");
        body.hidden = expanded;

        ensureHiddenWorks();
      },
      true
    );
  }

  // ---------------- vp:ui -> page elements (optional bridge) ----------------
  function setBadge(state) {
  const badge = $("sca-badge");
  if (!badge) return;

  badge.className = "sca-badge";

  if (state === "idle") {
    badge.textContent = "Not Connected";
    badge.classList.add("sca-badge-idle");

  } else if (state === "connecting") {
    badge.textContent = "Connecting…";
    badge.classList.add("sca-badge-connecting"); // add CSS or let it fall back visually

  } else if (state === "waiting") {
    badge.textContent = "Waiting for patient…";
    badge.classList.add("sca-badge-waiting"); // add CSS or let it fall back visually

  } else if (state === "thinking") {
    badge.textContent = "Thinking";
    badge.classList.add("sca-badge-thinking");

  } else if (state === "listening") {
    badge.textContent = "Listening";
    badge.classList.add("sca-badge-listening");

  } else if (state === "talking") {
    badge.textContent = "Talking";
    badge.classList.add("sca-badge-talking");

  } else if (state === "error") {
    badge.textContent = "Error";
    badge.classList.add("sca-badge-error");

  } else {
  // Unknown state: don't change the badge
  return;
}
}

  function setGlow(glow01) {
    const ring = $("sca-ring");
    if (!ring) return;
    ring.style.setProperty("--glow", String(clamp01(glow01)));
  }

  function setAvatar(url) {
    const img = $("sca-avatar-img");
    if (!img) return;

    const clearState = () => {
      img.classList.remove("is-loaded", "is-loading");
      img.classList.add("is-empty");
    };

    if (url) {
      img.classList.remove("is-loaded", "is-empty");
      img.classList.add("is-loading");

      const probe = new Image();
      probe.onload = () => {
        if (img.dataset.pendingAvatarUrl !== url) return;
        img.src = url;
        img.classList.remove("is-empty", "is-loading");
        img.classList.add("is-loaded");
      };
      probe.onerror = () => {
        if (img.dataset.pendingAvatarUrl !== url) return;
        img.src = "data:image/gif;base64,R0lGODlhAQABAAAAACwAAAAAAQABAAA=";
        clearState();
      };

      img.dataset.pendingAvatarUrl = url;
      probe.src = url;
    } else {
      img.src = "data:image/gif;base64,R0lGODlhAQABAAAAACwAAAAAAQABAAA=";
      clearState();
      delete img.dataset.pendingAvatarUrl;
    }
  }

  window.addEventListener("vp:ui", (e) => {
    const d = e.detail || {};

    // voice-patient.js already writes #status; we mirror state/badge/glow/avatar if present
    if (typeof d.state === "string") setBadge(d.state);
    if (typeof d.glow === "number") setGlow(d.glow);

    if ("avatarUrl" in d) setAvatar(d.avatarUrl || null);

    // ✅ Timer colouring (voice-patient emits timerRemainingSec)
    if (typeof d.timerRemainingSec === "number") setTimerClass(d.timerRemainingSec);
  });

  // ---------------- Airtable fetch (proxy) ----------------
  async function fetchJson(url) {
    const resp = await fetch(url, { cache: "no-store" });
    const text = await resp.text();
    let data = null;
    try { data = text ? JSON.parse(text) : null; } catch {}
    if (!resp.ok) {
      const msg = (data && (data.error || data.message)) || `HTTP ${resp.status}`;
      const err = new Error(msg);
      err.status = resp.status;
      err.data = data;
      err.url = url;
      throw err;
    }
    return data;
  }

  function pickAttachmentUrl(att) {
    if (!att) return null;
    if (Array.isArray(att) && att.length) {
      const a = att[0];
      return a?.thumbnails?.large?.url || a?.thumbnails?.full?.url || a?.url || null;
    }
    if (typeof att === "object") {
      return att?.thumbnails?.large?.url || att?.thumbnails?.full?.url || att?.url || null;
    }
    if (typeof att === "string") return att;
    return null;
  }

  function findPatientImageFromCaseRecords(records) {
    for (const r of records || []) {
      const url = pickAttachmentUrl(r?.fields?.PatientImage);
      if (url) return url;
    }
    return null;
  }

  async function fetchCaseProfileImage(caseId) {
    if (!ENABLE_PROFILE_FETCH) return null;
    if (!caseId) return null;
    try {
      const url = `${PROXY_BASE_URL}${PROFILE_ENDPOINT}${encodeURIComponent(caseId)}`;
      const data = await fetchJson(url);
      const prof = data?.profile || data?.fields || data || null;
      return pickAttachmentUrl(prof?.PatientImage) || null;
    } catch {
      return null;
    }
  }

  async function fetchAirtableCaseData() {
    const table = getCaseTableName();
    if (!table) return;

    const url = `${PROXY_BASE_URL}/api/case?table=${encodeURIComponent(table)}`;
    const data = await fetchJson(url);

    const records = data.records || [];
    window.airtableData = records;

    // Avatar url (optional)
    let avatarUrl = findPatientImageFromCaseRecords(records);

    // /api/case can also return profile.patientImageUrl
    if (!avatarUrl) {
      avatarUrl =
        (typeof data?.profile?.patientImageUrl === "string" && data.profile.patientImageUrl) ||
        null;
    }

    if (!avatarUrl) {
      const caseId = getCaseIdFromUrl();
      avatarUrl = await fetchCaseProfileImage(caseId);
    }

    if (avatarUrl) setAvatar(avatarUrl);

    document.dispatchEvent(new Event("airtableDataFetched"));
  }

  // ---------------- Population ----------------
  function getAirtableRecordsOrExit(contextLabel) {
    const records = window.airtableData;
    if (!records || records.length === 0) {
      console.error(`[SCA] No records found (${contextLabel}).`);
      return null;
    }
    return records;
  }

  function collectAndSortValues(records, fieldName) {
    const values = [];
    for (const record of records) {
      const order = record.fields?.Order;
      const value = record.fields?.[fieldName];
      if (value && order !== undefined) values.push({ order, value });
    }
    values.sort((a, b) => a.order - b.order);
    return values.map((item) => item.value);
  }

  function renderList(listEl, items) {
    if (!listEl) return;
    listEl.innerHTML = "";
    items.forEach((item) => {
      const li = document.createElement("li");
      li.textContent = item;
      listEl.appendChild(li);
    });
  }

  function populatePatientData(records) {
    // These IDs must exist in your page HTML:
    // #sca-mainName, #sca-mainAge, #patientPMHx, #patientDHx
    const names = collectAndSortValues(records, "Name");
    const ages  = collectAndSortValues(records, "Age");
    const pmHx  = collectAndSortValues(records, "PMHx Record");
    const dHx   = collectAndSortValues(records, "DHx");

    const nameEl = $("sca-mainName");
    const ageEl  = $("sca-mainAge");

    if (nameEl) nameEl.textContent = names.join(", ") || "N/A";
    if (ageEl)  ageEl.textContent  = ages.join(", ") || "N/A";

    renderList($("patientPMHx"), pmHx);
    renderList($("patientDHx"), dHx);
  }

  function populateMedicalNotes(records) {
    // Requires #medicalNotes
    const medicalNotes        = collectAndSortValues(records, "Medical Notes");
    const medicalNotesContent = collectAndSortValues(records, "Medical Notes Content");
    const medicalNotesPhotos  = collectAndSortValues(records, "Notes Photo");

    const wrap = $("medicalNotes");
    if (!wrap) return;
    wrap.innerHTML = "";

    for (let i = 0; i < medicalNotes.length; i++) {
      const note = medicalNotes[i];
      const content = medicalNotesContent[i] || "";
      const photos = medicalNotesPhotos[i];

      const noteEl = document.createElement("div");
      const contentEl = document.createElement("div");

      noteEl.classList.add("underline");
      contentEl.classList.add("quote-box", "quote-box-medical");

      noteEl.textContent = (i > 0 ? "\n" : "") + note;
      contentEl.innerHTML = content.replace(/\n/g, "<br>") + "<br>";

      wrap.appendChild(noteEl);
      wrap.appendChild(contentEl);

      if (photos && Array.isArray(photos) && photos.length > 0) {
        photos.forEach((photo) => {
          if (!photo || !photo.url) return;
          const img = document.createElement("img");
          img.src = photo.url;
          img.alt = "Medical Notes Image";
          img.loading = "lazy";
          img.style.width = "100%";
          img.style.maxWidth = "800px";
          img.style.height = "auto";
          img.style.display = "block";
          img.style.margin = "10px auto";
          wrap.appendChild(img);
        });
      }
    }
  }

  function populateResults(records) {
    // Requires #resultsContent
    const results        = collectAndSortValues(records, "Results");
    const resultsContent = collectAndSortValues(records, "Results Content");

    const wrap = $("resultsContent");
    if (!wrap) return;
    wrap.innerHTML = "";

    for (let i = 0; i < results.length; i++) {
      const title = results[i];
      const content = resultsContent[i] || "";

      const titleEl = document.createElement("div");
      const contentEl = document.createElement("div");

      titleEl.classList.add("underline");
      contentEl.classList.add("quote-box", "quote-box-results");

      titleEl.textContent = (i > 0 ? "\n" : "") + title;
      contentEl.innerHTML = content.replace(/\n/g, "<br>") + "<br>";

      wrap.appendChild(titleEl);
      wrap.appendChild(contentEl);
    }
  }

  function populateAll() {
    const records = getAirtableRecordsOrExit("patient+notes+results");
    if (!records) return;
    populatePatientData(records);
    populateMedicalNotes(records);
    populateResults(records);
  }

  // ---------------- Boot ----------------
function boot() {
  // Ensure page-scoped CSS activates
  try { document.body.classList.add("sca-botpage"); } catch {}

  // DO NOT CREATE HTML HERE. Just bind + populate.
  bindAccordion();

    fetchAirtableCaseData().catch((e) => {
      console.error("[SCA] fetchAirtableCaseData failed:", e);
    });

    document.addEventListener("airtableDataFetched", populateAll);

    // fallback if already set
    if (window.airtableData && Array.isArray(window.airtableData) && window.airtableData.length) {
      populateAll();
    }
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", boot);
  } else {
    boot();
  }
})();
