/* bot-page.bundle.js
   Merged:
   - Patient card overlay (avatar + ring + badge + status + vp:ui listener)
   - bot-page-ui shell + accordion + bindings
   - Case fetch (proxy) -> window.airtableData -> airtableDataFetched
   - Patient/Notes/Results population
   - Case indicator sync
   - Avatar loads on page load (from Airtable records; optional profile endpoint support)
*/
(() => {
  // ---------------- Config ----------------
  // Existing proxy (kept)
  const PROXY_BASE_URL =
    window.PROXY_BASE_URL || "https://scarevision-airtable-proxy.vercel.app";

  // OPTIONAL: if you later add a profile endpoint (CaseProfiles) in your proxy, set this true
  // and implement /api/case-profile?caseId=123 returning { profile: { PatientImage: [...] } }.
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

  // ---------------- Patient card overlay ----------------
  function mountPatientCard() {
    const host = $("sca-patient-card");
    if (!host) return;

    // Avoid double-mount
    if (host.__scaMounted) return;
    host.__scaMounted = true;

    host.innerHTML = `
      <div class="sca-card">
        <div class="sca-header">
          <div class="sca-title">Patient</div>
          <div id="sca-badge" class="sca-badge sca-badge-idle">Idle</div>
        </div>

        <div class="sca-avatarWrap">
          <div class="sca-ring" id="sca-ring">
            <canvas id="sca-orb-canvas" class="sca-orbCanvas" width="500" height="500" aria-hidden="true"></canvas>
            <div class="sca-avatar">
              <img id="sca-avatar-img"
     alt=""
     src="data:image/gif;base64,R0lGODlhAQABAAAAACwAAAAAAQABAAA="
     class="is-empty"
/>

            </div>
          </div>
        </div>

        <div id="sca-status" class="sca-status">Waiting…</div>
      </div>
    `;
  }

  function setStatus(text) {
    const el = $("sca-status");
    if (el) el.textContent = text || "";
  }

  function setBadge(state) {
    const badge = $("sca-badge");
    const ring = $("sca-ring");
    if (!badge || !ring) return;

    badge.className = "sca-badge";
    ring.classList.remove("thinking");

    if (state === "idle") {
      badge.textContent = "Idle";
      badge.classList.add("sca-badge-idle");
    } else if (state === "thinking") {
      badge.textContent = "Thinking";
      badge.classList.add("sca-badge-thinking");
      ring.classList.add("thinking");
    } else if (state === "listening") {
      badge.textContent = "Listening";
      badge.classList.add("sca-badge-listening");
    } else if (state === "talking") {
      badge.textContent = "Talking";
      badge.classList.add("sca-badge-talking");
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

  if (url) {
    img.src = url;
    img.classList.remove("is-empty");
  } else {
    img.src = "data:image/gif;base64,R0lGODlhAQABAAAAACwAAAAAAQABAAA=";
    img.classList.add("is-empty");
  }
}

  // ---------------- Orb edge animation ----------------
  const ORB_STATE = {
    mode: "idle",
    glow: 0.15,

    // per-particle in/out wobble (NOT whole-orb scaling)
    pulseValue: 1,
    pulseTarget: 1,
    pulseFrames: 0,

    // keep orb size constant across states
    baseScaleCurrent: 0.86,
    baseScaleTarget: 0.86,

    animationId: null,
    particles: [],
    lastMode: "idle"
  };

  function respawnEdgeParticle(p) {
    const angle = Math.random() * Math.PI * 2;
    const depth = Math.random();
    const radiusNorm = 1.01 + depth * 0.1;

    p.angle = angle;
    p.radiusNorm = radiusNorm;
    p.baseRadiusNorm = radiusNorm;
    p.radialDir = Math.random() < 0.5 ? -1 : 1;

    p.speed = 0.0008 + Math.random() * 0.002;
    p.size = 1.2 + Math.random() * 1.8;
    p.alpha = 0.2 + Math.random() * 0.55;

    // fade lifecycle: t goes 0→1, alpha uses sin(pi*t), then respawn
    p.t = 0;
    p.tSpeed = 0.006 + Math.random() * 0.012;

    // delay controls “gaps” where particle is not visible
    const delayMax =
      ORB_STATE.mode === "idle" ? 140 :
      ORB_STATE.mode === "listening" ? 90 :
      ORB_STATE.mode === "thinking" ? 70 :
      55; // talking = most active
    p.delay = Math.floor(Math.random() * delayMax);
  }

  function kickOrbParticles() {
    // on state change: force a visible “re-seed” so blobs start appearing immediately
    const parts = ORB_STATE.particles || [];
    for (let i = 0; i < parts.length; i += 1) {
      if (Math.random() < 0.35) {
        parts[i].delay = Math.floor(Math.random() * 8);
        parts[i].t = Math.random() * 0.25;
      }
    }
  }

   
  function createEdgeParticles() {
    const count = 220;
    const parts = [];
    for (let i = 0; i < count; i += 1) {
      const p = {};
      respawnEdgeParticle(p);
      // start staggered so they don’t all appear at once
      p.t = Math.random();
      parts.push(p);
    }
    ORB_STATE.particles = parts;
  }


  function chooseOrbPulse() {
    const mode = ORB_STATE.mode;

    // keep orb size constant always (no diameter pumping)
    ORB_STATE.baseScaleTarget = 0.86;

    if (mode === "talking") {
      // more in/out activity, but no overall scale-up
      ORB_STATE.pulseTarget = 0.985 + Math.random() * 0.03;
      ORB_STATE.pulseFrames = 10 + Math.floor(Math.random() * 10);
      return;
    }

    if (mode === "thinking") {
      ORB_STATE.pulseTarget = 0.99 + Math.random() * 0.03;
      ORB_STATE.pulseFrames = 16 + Math.floor(Math.random() * 14);
      return;
    }

    if (mode === "listening") {
      ORB_STATE.pulseTarget = 0.995 + Math.random() * 0.01;
      ORB_STATE.pulseFrames = 28 + Math.floor(Math.random() * 22);
      return;
    }

    // idle
    ORB_STATE.pulseTarget = 1;
    ORB_STATE.pulseFrames = 60;
  }


  function updateOrbDynamics() {
    if (ORB_STATE.pulseFrames <= 0) chooseOrbPulse();
    ORB_STATE.pulseFrames -= 1;

    const talking = ORB_STATE.mode === "talking";
    const idle = ORB_STATE.mode === "idle";
    const pulseLerp = talking ? 0.08 : 0.04;
    const scaleLerp = talking ? 0.07 : 0.04;

    if (idle) {
      ORB_STATE.pulseValue = 1;
      ORB_STATE.baseScaleCurrent += (ORB_STATE.baseScaleTarget - ORB_STATE.baseScaleCurrent) * 0.03;
      return;
    }

    ORB_STATE.pulseValue += (ORB_STATE.pulseTarget - ORB_STATE.pulseValue) * pulseLerp;
    ORB_STATE.baseScaleCurrent += (ORB_STATE.baseScaleTarget - ORB_STATE.baseScaleCurrent) * scaleLerp;
  }

  function drawOrbFrame() {
    const canvas = $("sca-orb-canvas");
    if (!canvas) {
      ORB_STATE.animationId = null;
      return;
    }

    const ctx = canvas.getContext("2d");
    if (!ctx) {
      ORB_STATE.animationId = null;
      return;
    }

    const dpr = Math.max(1, window.devicePixelRatio || 1);
    const width = canvas.clientWidth || 500;
    const height = canvas.clientHeight || 500;

    const nextW = Math.round(width * dpr);
    const nextH = Math.round(height * dpr);
    if (canvas.width !== nextW || canvas.height !== nextH) {
      canvas.width = nextW;
      canvas.height = nextH;
    }

    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, width, height);

    if (!ORB_STATE.particles.length) createEdgeParticles();
    updateOrbDynamics();

    const cx = width / 2;
    const cy = height / 2;
    const avatarRadius = Math.min(width, height) * 0.5;
    const ringCenter = avatarRadius * 1.02;

    const talking = ORB_STATE.mode === "talking";
    const thinking = ORB_STATE.mode === "thinking";
    const listening = ORB_STATE.mode === "listening";
    const idle = ORB_STATE.mode === "idle";
    const movementBoost = idle ? 0 : talking ? 0.42 : (thinking || listening) ? 0.65 : 0.65;
    const alphaBoost = talking ? 0.08 : (thinking || listening) ? 0.02 : -0.04;
    const tint = 112 + Math.round(40 * ORB_STATE.glow);

    for (const p of ORB_STATE.particles) {
      p.angle += p.speed * movementBoost;

      const pulseDelta = ORB_STATE.pulseValue - 1;
      const radialShift = p.radialDir * pulseDelta * 0.9;
      const effectiveNorm = p.baseRadiusNorm + radialShift;
      p.radiusNorm = Math.max(0.995, Math.min(1.11, effectiveNorm));

      const radius = ringCenter * p.radiusNorm * ORB_STATE.baseScaleCurrent;
      const x = cx + Math.cos(p.angle) * radius;
      const y = cy + Math.sin(p.angle) * radius;

      // --- fade lifecycle: come/go even when not rotating ---
      const idle = ORB_STATE.mode === "idle";
      const talking = ORB_STATE.mode === "talking";
      const thinking = ORB_STATE.mode === "thinking";
      const listening = ORB_STATE.mode === "listening";

      const twinkleFactor = idle ? 0.75 : talking ? 1.55 : (thinking ? 1.25 : (listening ? 1.05 : 1.1));

      if (p.delay > 0) {
        p.delay -= 1;
        continue; // not visible yet
      }

      p.t += p.tSpeed * twinkleFactor;
      if (p.t >= 1) {
        respawnEdgeParticle(p);
        continue;
      }

      const lifeAlpha = Math.sin(Math.PI * p.t); // 0 → 1 → 0

      let alpha = (p.alpha * lifeAlpha) + alphaBoost;
      alpha = Math.max(0.02, Math.min(0.92, alpha));


      const dotRadius = p.size * (talking ? 0.98 : 1);
      const grad = ctx.createRadialGradient(x, y, 0, x, y, dotRadius * 3.6);
      grad.addColorStop(0, `rgba(20, 101, 192, ${alpha})`);
      grad.addColorStop(0.6, `rgba(85, ${tint}, 230, ${alpha * 0.55})`);
      grad.addColorStop(1, "rgba(160, 210, 255, 0)");

      ctx.fillStyle = grad;
      ctx.beginPath();
      ctx.arc(x, y, dotRadius * 2.2, 0, Math.PI * 2);
      ctx.fill();
    }

    ORB_STATE.animationId = requestAnimationFrame(drawOrbFrame);
  }

  function startOrbAnimation() {
    if (ORB_STATE.animationId) return;
    chooseOrbPulse();
    ORB_STATE.animationId = requestAnimationFrame(drawOrbFrame);
  }

  // Listen for voice-patient.js updates
  window.addEventListener("vp:ui", (e) => {
    const d = e.detail || {};
    if (d.status) setStatus(d.status);
    if (d.state) {
      setBadge(d.state);

      const nextMode = d.state;
      const changed = nextMode !== ORB_STATE.mode;

      ORB_STATE.mode = nextMode;
      chooseOrbPulse();

      if (changed) kickOrbParticles();
    }


    if (!d.state && typeof d.status === "string" && /not connected|disconnected/i.test(d.status)) {
      ORB_STATE.mode = "idle";
      chooseOrbPulse();
    }
    if (typeof d.glow === "number") {
      setGlow(d.glow);
      ORB_STATE.glow = clamp01(d.glow);
    }
  });

  // ---------------- bot-page-ui shell + accordion ----------------
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

    header.addEventListener("click", () => {
      const expanded = header.getAttribute("aria-expanded") === "true";
      header.setAttribute("aria-expanded", expanded ? "false" : "true");
      body.hidden = expanded;
    });

    item.appendChild(header);
    item.appendChild(body);
    acc.appendChild(item);
  }

  function mountPageShell() {
    if (window.__scaBotPageUiMounted) return;
    window.__scaBotPageUiMounted = true;

    const anchor = $("sca-patient-card") || $("patientDataBox") || $("startBtn");
    if (!anchor || !anchor.parentNode) return;

    document.body.classList.add("sca-botpage");

    const root = document.createElement("div");
    root.id = "scaBotPageRoot";
    root.innerHTML = `
      <div class="sca-grid">
        <div class="sca-left">
          <div class="sca-heroRow">
            <div class="sca-heroMedia">
              <div id="scaAvatarSlot"></div>
            </div>
          </div>

          <div class="sca-mainMeta">
            <div class="sca-mainName" data-bind="name">Loading…</div>
            <div class="sca-mainAge">Age: <span data-bind="age">…</span></div>
          </div>

          <div class="sca-botUpdate">
            <div class="sca-botUpdateHeader">
              <div class="sca-botUpdateTitle">Bot update</div>
            </div>
            <ul class="sca-botUpdateList" id="scaBotUpdateList"></ul>
          </div>

          <div class="sca-seg" id="scaSegSlot"></div>
        </div>

        <aside class="sca-right">
          <div class="sca-infoCard">
            <div class="sca-infoHeader">
              <div class="sca-infoHeaderTitle">Patient Information</div>
            </div>
            <div class="sca-accordion" id="scaAccordion"></div>
          </div>
        </aside>
      </div>
    `;

    anchor.parentNode.insertBefore(root, anchor);

    // Move patient card host into avatar slot
    const avatarSlot = root.querySelector("#scaAvatarSlot");
    const cardHost = $("sca-patient-card");
    if (avatarSlot && cardHost) avatarSlot.appendChild(cardHost);

    // Keep caseIndicator hidden (it remains in the original hidden box for compatibility)

    // Bot update list contains #status from voice-patient.js
    const updateList = root.querySelector("#scaBotUpdateList");
    const statusEl = $("status");
    if (updateList) {
      if (statusEl) {
        const li = document.createElement("li");
        li.appendChild(statusEl);
        updateList.appendChild(li);
      } else {
        updateList.innerHTML = `<li>Status element (#status) not found.</li>`;
      }
    }

    // Start/Stop into seg
    const segSlot = root.querySelector("#scaSegSlot");
    const startBtn = $("startBtn");
    const stopBtn = $("stopBtn");
    if (segSlot) {
      if (startBtn) segSlot.appendChild(startBtn);
      if (stopBtn) segSlot.appendChild(stopBtn);
    }

    // Accordion
    const acc = root.querySelector("#scaAccordion");
    if (acc) {
      const pmhx = $("patientPMHx");
      const dhx = $("patientDHx");
      const notesBox = $("medicalNotesBox");
      const resultsBox = $("resultsBox");

      if (pmhx) pmhx.classList.add("sca-cleanList");
      if (dhx) dhx.classList.add("sca-cleanList");

      if (pmhx) addAccItem(acc, { title: "Medical History", contentNode: pmhx, open: true });
      if (dhx) addAccItem(acc, { title: "Medication", contentNode: dhx, open: true });
      if (notesBox) addAccItem(acc, { title: "Medical Notes", contentNode: notesBox, open: true });
      if (resultsBox) addAccItem(acc, { title: "Investigation Results", contentNode: resultsBox, open: false });
    }

    // Hide original patientDataBox but keep it in DOM
    const patientDataBox = $("patientDataBox");
    if (patientDataBox) patientDataBox.setAttribute("data-sca-hidden", "true");

    // Bind name/age (Airtable script writes #patientName/#patientAge)
    const nameSpan = $("patientName");
    const ageSpan = $("patientAge");

    const sync = () => {
      const name = (nameSpan?.textContent || "").trim();
      const age = (ageSpan?.textContent || "").trim();

      root.querySelectorAll("[data-bind='name']").forEach((el) => { el.textContent = name || "Loading…"; });
      root.querySelectorAll("[data-bind='age']").forEach((el) => { el.textContent = age || "…"; });
    };

    sync();

    const mo = new MutationObserver(sync);
    if (nameSpan) mo.observe(nameSpan, { childList: true, subtree: true, characterData: true });
    if (ageSpan) mo.observe(ageSpan, { childList: true, subtree: true, characterData: true });
  }

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

  // Attachment -> best URL
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

     // ✅ NEW: read profile image out of /api/case payload (because you updated /api/case.js already)
  function findPatientImageFromApiPayload(data) {
    if (!data) return null;

    // 1) direct URL field (if you added it)
    if (typeof data.profilePatientImageUrl === "string" && data.profilePatientImageUrl) {
      return data.profilePatientImageUrl;
    }

    // 2) profile object with PatientImage attachment (common shape)
    const prof = data.profile || data.caseProfile || data.profileFields || null;
    if (prof) {
      const url = pickAttachmentUrl(prof.PatientImage);
      if (url) return url;
    }

    // 3) debug object shape (if present)
    if (data.debugPatientImage && typeof data.debugPatientImage.url === "string") {
      return data.debugPatientImage.url || null;
    }

    return null;
  }

  // Try to find PatientImage in the Case table rows (only works if you put it there)
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
      const urlFromProf = pickAttachmentUrl(prof?.PatientImage);
      return urlFromProf || null;
    } catch {
      return null;
    }
  }

  async function fetchAirtableCaseData() {
    const table = getCaseTableName();
    if (!table) return;

    window.airtableData = window.airtableData || null;

    const url = `${PROXY_BASE_URL}/api/case?table=${encodeURIComponent(table)}`;
    const data = await fetchJson(url);

    const records = data.records || [];
    window.airtableData = records;

    // Avatar on page load:
    // 1) try PatientImage stored in Case table rows (only works if you put it there)
    let avatarUrl = findPatientImageFromCaseRecords(records);

    // 2) ✅ NEW: your /api/case returns CaseProfiles data as { profile: { patientImageUrl: "..." } }
    if (!avatarUrl) {
      avatarUrl =
        (typeof data?.profile?.patientImageUrl === "string" && data.profile.patientImageUrl) ||
        null;
    }

     setAvatar(avatarUrl);


    // 3) optional old path (only if you later enable a separate profile endpoint)
    if (!avatarUrl) {
      const caseId = getCaseIdFromUrl();
      avatarUrl = await fetchCaseProfileImage(caseId);
    }

    document.dispatchEvent(new Event("airtableDataFetched"));
  }



  // ---------------- Patient info rendering ----------------
  function getAirtableRecordsOrExit(contextLabel) {
    const records = window.airtableData;
    if (!records || records.length === 0) {
      console.error(`No records found or failed to fetch records (${contextLabel}).`);
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

    const nameEl = $("patientName");
    const ageEl  = $("patientAge");

    if (nameEl) nameEl.textContent = names.join(", ") || "N/A";
    if (ageEl)  ageEl.textContent  = ages.join(", ") || "N/A";

    renderList($("patientPMHx"), pmHx);
    renderList($("patientDHx"), dHx);
  }

  function populateMedicalNotes(records) {
    const medicalNotes        = collectAndSortValues(records, "Medical Notes");
    const medicalNotesContent = collectAndSortValues(records, "Medical Notes Content");
    const medicalNotesPhotos  = collectAndSortValues(records, "Notes Photo"); // attachments per row

    const medicalNotesDiv = $("medicalNotes");
    if (!medicalNotesDiv) return;
    medicalNotesDiv.innerHTML = "";

    for (let i = 0; i < medicalNotes.length; i++) {
      const note = medicalNotes[i];
      const content = medicalNotesContent[i] || "";
      const photos = medicalNotesPhotos[i]; // array of attachments for this row

      const noteElement = document.createElement("div");
      const contentElement = document.createElement("div");

      noteElement.classList.add("underline");
      contentElement.classList.add("quote-box", "quote-box-medical");

      noteElement.textContent = (i > 0 ? "\n" : "") + note;
      contentElement.innerHTML = content.replace(/\n/g, "<br>") + "<br>";

      medicalNotesDiv.appendChild(noteElement);
      medicalNotesDiv.appendChild(contentElement);

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
          medicalNotesDiv.appendChild(img);
        });
      }
    }
  }

  function populateResults(records) {
    const results        = collectAndSortValues(records, "Results");
    const resultsContent = collectAndSortValues(records, "Results Content");

    const resultsDiv = $("resultsContent");
    if (!resultsDiv) return;
    resultsDiv.innerHTML = "";

    for (let i = 0; i < results.length; i++) {
      const title = results[i];
      const content = resultsContent[i] || "";

      const titleEl = document.createElement("div");
      const contentEl = document.createElement("div");

      titleEl.classList.add("underline");
      contentEl.classList.add("quote-box", "quote-box-results");

      titleEl.textContent = (i > 0 ? "\n" : "") + title;
      contentEl.innerHTML = content.replace(/\n/g, "<br>") + "<br>";

      resultsDiv.appendChild(titleEl);
      resultsDiv.appendChild(contentEl);
    }
  }

  function populateAllThree() {
    const records = getAirtableRecordsOrExit("Bot page (patient + notes + results)");
    if (!records) return;
    populatePatientData(records);
    populateMedicalNotes(records);
    populateResults(records);
  }

  // ---------------- Boot ----------------
  function boot() {
    // 1) Mount patient card early so avatar can be set
    mountPatientCard();
    startOrbAnimation();

    // 2) Build shell & move nodes
    mountPageShell();

    // 3) Load Airtable data
    fetchAirtableCaseData().catch((e) => {
      console.error("[SCA] fetchAirtableCaseData failed:", e);
      uiEmit({ avatarUrl: null });
    });

    // 4) Populate patient info when data arrives
    document.addEventListener("airtableDataFetched", populateAllThree);

    // Fallback if something pre-set airtableData
    if (window.airtableData && Array.isArray(window.airtableData) && window.airtableData.length) {
      populateAllThree();
    }

  }

  window.addEventListener("DOMContentLoaded", boot);
})();
