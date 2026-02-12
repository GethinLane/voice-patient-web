/* bot-page-ui.js
   Visual-only wrapper. Does not alter your Airtable logic or voice-patient.js logic.
   It only:
   - builds the 2-column shell
   - moves existing DOM nodes into it
   - adds accordion toggles
*/

(() => {
  const DEFAULT_SUBTITLE = "Follow-up appointment for ongoing health and medication review";

  const $ = (id) => document.getElementById(id);

  function addAccItem(acc, { title, icon, contentNode, open }) {
    const item = document.createElement("section");
    item.className = "sca-accItem";

    const header = document.createElement("button");
    header.type = "button";
    header.className = "sca-accHeader";
    header.setAttribute("aria-expanded", open ? "true" : "false");
    header.innerHTML = `
      <span class="sca-accIcon" aria-hidden="true">${icon}</span>
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

  function init() {
    if (window.__scaBotPageUiMounted) return;
    window.__scaBotPageUiMounted = true;

    // Identify an anchor that definitely exists on this page
    const anchor = $("sca-patient-card") || $("patientDataBox") || $("startBtn");
    if (!anchor || !anchor.parentNode) return;

    document.body.classList.add("sca-botpage");

    // Build shell
    const root = document.createElement("div");
    root.id = "scaBotPageRoot";
    root.innerHTML = `
      <div class="sca-grid">
        <div class="sca-left">
          <div class="sca-heroRow">
            <div id="scaAvatarSlot"></div>

            <div class="sca-heroMeta">
              <div class="sca-callout" id="scaCalloutSlot"></div>
            </div>
          </div>

          <div class="sca-mainMeta">
            <div class="sca-mainName" data-bind="name">Loading…</div>
            <div class="sca-mainAge">Age: <span data-bind="age">…</span></div>
            <div class="sca-mainDesc" id="scaMainDesc"></div>
          </div>

          <div class="sca-botUpdate">
            <div class="sca-botUpdateHeader">
              <span class="sca-botIcon" aria-hidden="true">🤖</span>
              <div class="sca-botUpdateTitle">Bot update</div>
            </div>
            <ul class="sca-botUpdateList" id="scaBotUpdateList"></ul>
          </div>

          <div class="sca-seg" id="scaSegSlot"></div>
        </div>

        <aside class="sca-right">
          <div class="sca-infoCard">
            <div class="sca-infoHeader">
              <span aria-hidden="true">🗂️</span>
              <div class="sca-infoHeaderTitle">Patient Information</div>
            </div>
            <div class="sca-accordion" id="scaAccordion"></div>
          </div>
        </aside>
      </div>
    `;

    // Insert shell in the same Squarespace section as your existing elements
    anchor.parentNode.insertBefore(root, anchor);

    // Move patient card host into avatar slot
    const avatarSlot = root.querySelector("#scaAvatarSlot");
    const cardHost = $("sca-patient-card");
    if (avatarSlot && cardHost) avatarSlot.appendChild(cardHost);

    // Callout: prefer the existing caseIndicator block; otherwise show subtitle
    const calloutSlot = root.querySelector("#scaCalloutSlot");
    const caseIndicator = $("caseIndicator");
    if (calloutSlot) {
      if (caseIndicator) calloutSlot.appendChild(caseIndicator);
      else calloutSlot.textContent = DEFAULT_SUBTITLE;
    }

    // Main subtitle text
    const mainDesc = root.querySelector("#scaMainDesc");
    if (mainDesc) mainDesc.textContent = DEFAULT_SUBTITLE;

    // Bot update list contains your existing #status (voice-patient.js updates it)
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

    // Start/Stop buttons moved into segmented control (listeners remain intact)
    const segSlot = root.querySelector("#scaSegSlot");
    const startBtn = $("startBtn");
    const stopBtn = $("stopBtn");
    if (segSlot) {
      if (startBtn) segSlot.appendChild(startBtn);
      if (stopBtn) segSlot.appendChild(stopBtn);
    }

    // Accordion: move your existing content blocks into sections
    const acc = root.querySelector("#scaAccordion");
    if (acc) {
      const pmhx = $("patientPMHx");
      const dhx = $("patientDHx");
      const notesBox = $("medicalNotesBox");
      const resultsBox = $("resultsBox");

      if (pmhx) pmhx.classList.add("sca-cleanList");
      if (dhx) dhx.classList.add("sca-cleanList");

      if (pmhx) addAccItem(acc, { title: "Medical History", icon: "🩺", contentNode: pmhx, open: true });
      if (dhx) addAccItem(acc, { title: "Medication", icon: "💊", contentNode: dhx, open: true });
      if (notesBox) addAccItem(acc, { title: "Medical Notes", icon: "📝", contentNode: notesBox, open: true });
      if (resultsBox) addAccItem(acc, { title: "Investigation Results", icon: "🧪", contentNode: resultsBox, open: false });
    }

    // Hide original patientDataBox (keep in DOM so your existing scripts still work)
    const patientDataBox = $("patientDataBox");
    if (patientDataBox) patientDataBox.setAttribute("data-sca-hidden", "true");

    // Bind name/age (your Airtable script writes into #patientName/#patientAge)
    const nameSpan = $("patientName");
    const ageSpan = $("patientAge");

    const sync = () => {
      const name = (nameSpan?.textContent || "").trim();
      const age = (ageSpan?.textContent || "").trim();

      root.querySelectorAll("[data-bind='name']").forEach((el) => {
        el.textContent = name || "Loading…";
      });
      root.querySelectorAll("[data-bind='age']").forEach((el) => {
        el.textContent = age || "…";
      });
    };

    sync();

    const mo = new MutationObserver(sync);
    if (nameSpan) mo.observe(nameSpan, { childList: true, subtree: true, characterData: true });
    if (ageSpan) mo.observe(ageSpan, { childList: true, subtree: true, characterData: true });
  }

  // Run after other DOMContentLoaded handlers (voice-patient.js etc.)
  window.addEventListener("DOMContentLoaded", () => setTimeout(init, 0));
})();
