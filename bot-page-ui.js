/* bot-page.v2.js
   Visual-only: builds the screenshot-like layout and moves your existing DOM nodes into it.
   Does NOT change Airtable logic or voice-patient.js logic.
*/

(() => {
  const DEFAULT_SUBTITLE = "Follow-up appointment for ongoing health and medication review";

  const $ = (id) => document.getElementById(id);

  function bindText(root) {
    const nameEl = $("patientName");
    const ageEl  = $("patientAge");

    const sync = () => {
      const name = (nameEl?.textContent || "").trim() || "Loading…";
      const age  = (ageEl?.textContent || "").trim()  || "…";

      root.querySelectorAll("[data-bind='name']").forEach(n => n.textContent = name);
      root.querySelectorAll("[data-bind='age']").forEach(n => n.textContent = age);
    };

    sync();

    const mo = new MutationObserver(sync);
    if (nameEl) mo.observe(nameEl, { childList: true, subtree: true, characterData: true });
    if (ageEl)  mo.observe(ageEl,  { childList: true, subtree: true, characterData: true });
  }

  function makeSection({ title, icon, contentNode }) {
    const sec = document.createElement("div");
    sec.className = "sca-sec";
    sec.innerHTML = `
      <div class="sca-secHead">
        <div class="sca-secIcon" aria-hidden="true">${icon}</div>
        <div class="sca-secTitle">${title}</div>
        <div class="sca-secChevron" aria-hidden="true">›</div>
      </div>
      <div class="sca-secBody"></div>
    `;
    sec.querySelector(".sca-secBody").appendChild(contentNode);
    return sec;
  }

  function init() {
    if (window.__scaBotV2Mounted) return;
    window.__scaBotV2Mounted = true;

    const anchor =
      $("patientDataBox") ||
      $("sca-patient-card") ||
      $("startBtn") ||
      document.body.firstElementChild;

    if (!anchor || !anchor.parentNode) return;

    document.body.classList.add("sca-botpage");

    // Root shell
    const root = document.createElement("div");
    root.id = "scaBotV2Root";
    root.innerHTML = `
      <div class="sca-inset">
        <div class="sca-grid">
          <div class="sca-left">
            <div class="sca-topRow">
              <div id="scaAvatarSlot"></div>

              <div class="sca-topMeta">
                <div>
                  <div class="sca-topName" data-bind="name">Loading…</div>
                  <div class="sca-topAge">Age: <span data-bind="age">…</span></div>
                </div>

                <div class="sca-callout" id="scaCallout">
                  <div id="scaSubtitleTop"></div>
                  <div id="scaCaseSlot"></div>
                </div>
              </div>
            </div>

            <div class="sca-mainBlock">
              <div class="sca-mainName" data-bind="name">Loading…</div>
              <div class="sca-mainAge">Age: <span data-bind="age">…</span></div>
              <div class="sca-mainSubtitle" id="scaSubtitleMain"></div>
            </div>

            <div class="sca-update">
              <div class="sca-updateHeader">
                <div class="sca-botGlyph" aria-hidden="true">🤖</div>
                <div class="sca-updateTitle">Bot update</div>
              </div>
              <ul class="sca-updateList" id="scaUpdateList"></ul>
            </div>

            <div class="sca-seg" id="scaSegSlot"></div>
          </div>

          <aside class="sca-right">
            <div class="sca-rightHeader">
              <span aria-hidden="true">🗂️</span>
              <span>Patient Information</span>
            </div>
            <div class="sca-rightInner" id="scaRightInner"></div>
          </aside>
        </div>
      </div>
    `;

    // Insert before the existing content
    anchor.parentNode.insertBefore(root, anchor);

    // Subtitle text
    root.querySelector("#scaSubtitleTop").textContent = DEFAULT_SUBTITLE;
    root.querySelector("#scaSubtitleMain").textContent = DEFAULT_SUBTITLE;

    // Move patient avatar card host
    const avatarSlot = root.querySelector("#scaAvatarSlot");
    const patientCardHost = $("sca-patient-card");
    if (avatarSlot && patientCardHost) avatarSlot.appendChild(patientCardHost);

    // Put case indicator into callout (optional)
    const caseSlot = root.querySelector("#scaCaseSlot");
    const caseIndicator = $("caseIndicator");
    if (caseSlot && caseIndicator) caseSlot.appendChild(caseIndicator);

    // Bot update: keep using your existing #status (voice-patient.js updates it)
    const updateList = root.querySelector("#scaUpdateList");
    const statusEl = $("status");
    if (updateList && statusEl) {
      const li = document.createElement("li");
      li.appendChild(statusEl);
      updateList.appendChild(li);
    }

    // Start/Stop buttons into segmented control (listeners remain attached)
    const segSlot = root.querySelector("#scaSegSlot");
    const startBtn = $("startBtn");
    const stopBtn = $("stopBtn");
    if (segSlot) {
      if (startBtn) segSlot.appendChild(startBtn);
      if (stopBtn) segSlot.appendChild(stopBtn);
    }

    // Right side sections (move your existing elements)
    const rightInner = root.querySelector("#scaRightInner");

    const pmhx = $("patientPMHx");
    const dhx  = $("patientDHx");
    const notesBox = $("medicalNotesBox");
    const resultsBox = $("resultsBox");

    if (pmhx) pmhx.classList.add("sca-cleanList");
    if (dhx)  dhx.classList.add("sca-cleanList");

    if (rightInner) {
      if (pmhx) rightInner.appendChild(makeSection({ title: "Medical History", icon: "🩺", contentNode: pmhx }));
      if (dhx)  rightInner.appendChild(makeSection({ title: "Medication", icon: "💊", contentNode: dhx }));
      if (notesBox) rightInner.appendChild(makeSection({ title: "Medical Notes", icon: "📝", contentNode: notesBox }));
      if (resultsBox) rightInner.appendChild(makeSection({ title: "Investigation Results", icon: "🧪", contentNode: resultsBox }));
    }

    // Keep patientDataBox in DOM for Airtable scripts, but hide visually
    const patientDataBox = $("patientDataBox");
    if (patientDataBox) patientDataBox.setAttribute("data-sca-hidden", "true");

    // Bind duplicated name/age text to your Airtable spans
    bindText(root);
  }

  window.addEventListener("DOMContentLoaded", () => {
    // Run after other DOMContentLoaded handlers
    setTimeout(init, 0);
  });
})();
