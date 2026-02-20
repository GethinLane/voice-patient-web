/* bot-page.bundle.js (simplified + robust)
   - Single UI mount into #sca-patient-card
   - NO orb rendering (handled by sca-orb.js)
   - Provides the required IDs for voice-patient.js: #startBtn #stopBtn #status
   - Provides mode selector compatible with voice-patient.js (name="vpMode")
   - Fetches Airtable case data via proxy
   - Populates: name/age, PMHx, DHx, notes (with photos), results
   - Accordion behaviour + vp:ui badge/status/glow/avatar updates
*/
(() => {
  // ---------------- Config ----------------
  const PROXY_BASE_URL =
    window.PROXY_BASE_URL || "https://scarevision-airtable-proxy.vercel.app";

  // Only needed if you later re-enable an extra endpoint
  const ENABLE_PROFILE_FETCH = false;
  const PROFILE_ENDPOINT = "/api/case-profile?caseId=";

  const $ = (id) => document.getElementById(id);
  const clamp01 = (x) => Math.max(0, Math.min(1, Number(x || 0)));

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

  // ---------------- UI Mount ----------------
  function mountAppShell() {
    const host = $("sca-patient-card");
    if (!host) return null;

    // Avoid double-mount (Squarespace can re-run scripts)
    if (host.__scaMounted) return host;
    host.__scaMounted = true;

    document.body.classList.add("sca-botpage");

    // IMPORTANT:
    // - startBtn/stopBtn/status must exist exactly once
    // - vpMode radios must exist for voice-patient.js getSelectedMode()
    host.innerHTML = `
      <div id="scaBotPageRoot">
        <div class="sca-grid">

          <!-- LEFT -->
          <div class="sca-left">

            <div class="sca-heroRow">
              <div class="sca-heroMedia">
                <div class="sca-avatarWrap">
                  <div class="sca-ring" id="sca-ring">
                    <!-- canvas MUST exist for sca-orb.js -->
                    <canvas id="sca-orb-canvas" class="sca-orbCanvas" width="500" height="500" aria-hidden="true"></canvas>

                    <div class="sca-avatar">
                      <img
                        id="sca-avatar-img"
                        alt=""
                        src="data:image/gif;base64,R0lGODlhAQABAAAAACwAAAAAAQABAAA="
                        class="is-empty"
                      />
                    </div>
                  </div>
                </div>
              </div>
            </div>

            <div class="sca-mainMeta">
              <div class="sca-mainName" id="scaName">Loading…</div>
              <div class="sca-mainAge">Age: <span id="scaAge">…</span></div>
            </div>

            <div class="sca-botUpdate">
              <div class="sca-botUpdateHeader">
                <div class="sca-botUpdateTitle">Bot update</div>
                <div id="sca-badge" class="sca-badge sca-badge-idle" style="margin-left:auto;">Not Connected</div>
              </div>
              <ul class="sca-botUpdateList">
                <li><span id="status">Waiting…</span></li>
              </ul>
            </div>

            <!-- Mode selector: MUST be input[name="vpMode"] for voice-patient.js -->
            <div class="sca-botUpdate" style="padding:12px 14px;">
              <div style="font-weight:800; color: var(--sca-ink); margin-bottom:10px;">Bot type</div>

              <!-- Hidden radios (source of truth for voice-patient.js) -->
              <div style="position:absolute; left:-9999px; width:1px; height:1px; overflow:hidden;">
                <label><input type="radio" name="vpMode" id="vpModeStandard" value="standard" checked> Standard</label>
                <label><input type="radio" name="vpMode" id="vpModePremium" value="premium"> Premium</label>
              </div>

              <!-- Pretty buttons that toggle the radios -->
              <div style="display:flex; gap:10px;">
                <button id="botTypeStandard" type="button"
                  style="flex:1; height:46px; border-radius:12px; border:1px solid var(--sca-border); background: rgba(255,255,255,.75); font-weight:800; cursor:pointer;">
                  Standard
                </button>
                <button id="botTypePremium" type="button"
                  style="flex:1; height:46px; border-radius:12px; border:1px solid var(--sca-border); background: rgba(255,255,255,.55); font-weight:800; cursor:pointer;">
                  Premium
                </button>
              </div>
            </div>

            <!-- Start/Stop buttons: IDs required by voice-patient.js -->
            <div class="sca-seg">
              <button id="startBtn" type="button">Start</button>
              <button id="stopBtn" type="button" disabled>Stop</button>
            </div>

          </div>

          <!-- RIGHT -->
          <aside class="sca-right">
            <div class="sca-infoCard">
              <div class="sca-infoHeader">
                <div class="sca-infoHeaderTitle">Patient Information</div>
              </div>

              <div class="sca-accordion" id="scaAccordion"></div>
            </div>
          </aside>

        </div>
      </div>
    `;

    // Build accordion sections with stable targets
    const acc = host.querySelector("#scaAccordion");
    if (acc && !acc.__scaBuilt) {
      acc.__scaBuilt = true;

      addAccItem(acc, { title: "Medical History", contentNode: makeListNode("scaPMHxList"), open: true });
      addAccItem(acc, { title: "Medication", contentNode: makeListNode("scaDHxList"), open: true });
      addAccItem(acc, { title: "Medical Notes", contentNode: makeDivNode("scaNotesWrap"), open: false });
      addAccItem(acc, { title: "Investigation Results", contentNode: makeDivNode("scaResultsWrap"), open: false });

      if (!acc.__scaDelegated) {
        acc.__scaDelegated = true;
        acc.addEventListener(
          "click",
          (e) => {
            const header = e.target.closest(".sca-accHeader");
            if (!header || !acc.contains(header)) return;

            // ignore clicks inside body content
            if (e.target.closest(".sca-accBody")) return;

            e.preventDefault();

            const item = header.closest(".sca-accItem");
            const body = item?.querySelector(".sca-accBody");
            if (!body) return;

            const expanded = header.getAttribute("aria-expanded") === "true";
            header.setAttribute("aria-expanded", expanded ? "false" : "true");
            body.hidden = expanded;
          },
          true
        );
      }
    }

    // Wire the pretty mode buttons to the radios (voice-patient reads radios)
    wireModeButtons();

    return host;
  }

  function makeListNode(id) {
    const ul = document.createElement("ul");
    ul.id = id;
    ul.className = "sca-cleanList";
    return ul;
  }

  function makeDivNode(id) {
    const div = document.createElement("div");
    div.id = id;
    return div;
  }

  function addAccItem(acc, { title, contentNode, open }) {
    const item = document.createElement("section");
    item.className = "sca-accItem";

    const header = document.createElement("button");
    header.type = "button";
    header.className = "sca-accHeader";
    header.setAttribute("aria-expanded", open ? "true" : "false");
    header.innerHTML = `
      <span class="sca-accTitle">${title}</span>
      <span class="sca-accChevron" aria-hidden="true">›</span>
    `;

    const body = document.createElement("div");
    body.className = "sca-accBody";
    body.hidden = !open;

    const wrap = document.createElement("div");
    wrap.className = "sca-accContent";
    wrap.appendChild(contentNode);
    body.appendChild(wrap);

    item.appendChild(header);
    item.appendChild(body);
    acc.appendChild(item);
  }

  // ---------------- Mode selector wiring ----------------
  function wireModeButtons() {
    const btnStd = $("botTypeStandard");
    const btnPre = $("botTypePremium");
    const rStd = $("vpModeStandard");
    const rPre = $("vpModePremium");
    if (!btnStd || !btnPre || !rStd || !rPre) return;

    // restore previous selection
    try {
      const saved = String(localStorage.getItem("vp_mode") || "").toLowerCase();
      if (saved === "premium") rPre.checked = true;
      else rStd.checked = true;
    } catch {}

    const paint = () => {
      const isPremium = !!rPre.checked;
      btnStd.style.background = isPremium ? "rgba(255,255,255,.55)" : "rgba(255,255,255,.85)";
      btnPre.style.background = isPremium ? "rgba(255,255,255,.85)" : "rgba(255,255,255,.55)";
    };

    const setMode = (mode) => {
      if (mode === "premium") rPre.checked = true;
      else rStd.checked = true;
      paint();
      try { localStorage.setItem("vp_mode", mode); } catch {}
    };

    btnStd.addEventListener("click", () => setMode("standard"));
    btnPre.addEventListener("click", () => setMode("premium"));
    paint();
  }

  // ---------------- Badge / Status / Avatar helpers ----------------
  function setBadge(state) {
    const badge = $("sca-badge");
    if (!badge) return;

    badge.className = "sca-badge";

    if (state === "idle") {
      badge.textContent = "Not Connected";
      badge.classList.add("sca-badge-idle");
    } else if (state === "thinking") {
      badge.textContent = "Thinking";
      badge.classList.add("sca-badge-thinking");
    } else if (state === "listening") {
      badge.textContent = "Listening";
      badge.classList.add("sca-badge-listening");
    } else if (state === "talking") {
      badge.textContent = "Talking";
      badge.classList.add("sca-badge-talking");
    }
  }

  function setStatus(text) {
    const el = $("status");
    if (el) el.textContent = text || "";
  }

  function setGlow(glow01) {
    const ring = $("sca-ring");
    if (!ring) return;
    ring.style.setProperty("--glow", String(clamp01(glow01)));
  }

  function setAvatar(url) {
    const img = $("sca-avatar-img");
    if (!img) return;

    if (url) {
      img.src = url;
      img.classList.remove("is-empty");
      img.classList.add("is-loaded");
    } else {
      img.src = "data:image/gif;base64,R0lGODlhAQABAAAAACwAAAAAAQABAAA=";
      img.classList.add("is-empty");
      img.classList.remove("is-loaded");
    }
  }

  // Listen for voice-patient.js updates
  window.addEventListener("vp:ui", (e) => {
    const d = e.detail || {};
    if (typeof d.status === "string") setStatus(d.status);
    if (typeof d.state === "string") setBadge(d.state);
    if (typeof d.glow === "number") setGlow(d.glow);

    // optional: avatar updates from start-session payload
    if ("avatarUrl" in d) setAvatar(d.avatarUrl || null);

    // If disconnected, force idle badge
    if (!d.state && typeof d.status === "string" && /not connected|disconnected/i.test(d.status)) {
      setBadge("idle");
    }
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

    // Avatar url
    let avatarUrl = findPatientImageFromCaseRecords(records);

    // /api/case can also return profile.patientImageUrl
    if (!avatarUrl) {
      avatarUrl =
        (typeof data?.profile?.patientImageUrl === "string" && data.profile.patientImageUrl) ||
        null;
    }

    // optional extra endpoint
    if (!avatarUrl) {
      const caseId = getCaseIdFromUrl();
      avatarUrl = await fetchCaseProfileImage(caseId);
    }

    setAvatar(avatarUrl);

    document.dispatchEvent(new Event("airtableDataFetched"));
  }

  // ---------------- Rendering helpers ----------------
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
    const names = collectAndSortValues(records, "Name");
    const ages  = collectAndSortValues(records, "Age");
    const pmHx  = collectAndSortValues(records, "PMHx Record");
    const dHx   = collectAndSortValues(records, "DHx");

    const nameEl = $("scaName");
    const ageEl  = $("scaAge");

    if (nameEl) nameEl.textContent = names.join(", ") || "N/A";
    if (ageEl)  ageEl.textContent  = ages.join(", ") || "N/A";

    renderList($("scaPMHxList"), pmHx);
    renderList($("scaDHxList"), dHx);
  }

  function populateMedicalNotes(records) {
    const medicalNotes        = collectAndSortValues(records, "Medical Notes");
    const medicalNotesContent = collectAndSortValues(records, "Medical Notes Content");
    const medicalNotesPhotos  = collectAndSortValues(records, "Notes Photo");

    const wrap = $("scaNotesWrap");
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
    const results        = collectAndSortValues(records, "Results");
    const resultsContent = collectAndSortValues(records, "Results Content");

    const wrap = $("scaResultsWrap");
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
    // Mount ASAP
    mountAppShell();

    // Airtable
    fetchAirtableCaseData().catch((e) => {
      console.error("[SCA] fetchAirtableCaseData failed:", e);
      // DO NOT call window.uiEmit here (voice-patient's uiEmit is internal)
    });

    document.addEventListener("airtableDataFetched", populateAll);

    // Fallback if data already present
    if (window.airtableData && Array.isArray(window.airtableData) && window.airtableData.length) {
      populateAll();
    }
  }

  // Run immediately if possible (helps voice-patient bind early)
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", boot);
  } else {
    boot();
  }
})();
