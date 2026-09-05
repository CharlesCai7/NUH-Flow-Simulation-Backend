/* ==========================================================================
   NUHS ED Command Center — shared shell.
   Renders the top command bar, owns SETTINGS, and brokers IMPORT / EXPORT /
   optional PNG / SAVE out to whichever page mounted it. PLAN and SIMULATE are separate
   documents, so cross-tab state travels through localStorage.
   ========================================================================== */
(function(global){
  "use strict";

  var SETTINGS_KEY = "nuhs-ed-settings-v1";

  var DEFAULT_SETTINGS = {
    filename: "Emergency_Department-plan",
    department: "Emergency Department",
    observedBy: "",
    date: new Date().toISOString().slice(0,10),
    notes: ""
  };

  /* ---------- settings ---------- */
  function loadSettings(){
    try{
      var raw = localStorage.getItem(SETTINGS_KEY);
      if(raw) return Object.assign({}, DEFAULT_SETTINGS, JSON.parse(raw));
    }catch(e){}
    return Object.assign({}, DEFAULT_SETTINGS);
  }
  function saveSettings(s){
    try{ localStorage.setItem(SETTINGS_KEY, JSON.stringify(s)); return true; }
    catch(e){ return false; }
  }

  /* ---------- toast ---------- */
  var toastEl = null, toastTimer = null;
  function toast(msg, bad){
    if(!toastEl){
      toastEl = document.createElement("div");
      toastEl.className = "toast";
      document.body.appendChild(toastEl);
    }
    toastEl.textContent = msg;
    toastEl.classList.toggle("bad", !!bad);
    toastEl.classList.add("show");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function(){ toastEl.classList.remove("show"); }, 2400);
  }

  /* ---------- helpers ---------- */
  function el(tag, cls, text){
    var n = document.createElement(tag);
    if(cls) n.className = cls;
    if(text != null) n.textContent = text;
    return n;
  }
  function downloadBlob(blob, filename){
    var a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = filename;
    a.click();
    setTimeout(function(){ URL.revokeObjectURL(a.href); }, 1000);
  }
  function slug(s, fallback){
    s = (s || "").replace(/[^\w-]+/g, "_").replace(/^_+|_+$/g, "");
    return s || fallback;
  }
  function cleanFilename(s, fallback){
    s = (s || "").replace(/\.(json|zip|png|jpe?g|webp)$/i, "")
      .replace(/[\\/:*?"<>|]+/g, "_")
      .replace(/^\.+|\.+$/g, "")
      .trim();
    return s || fallback || "ed-flow-plan";
  }

  /* ---------- top bar ---------- */
  /* opts: { active:"plan"|"simulate", onImport, onExport, onPng, onSave,
             onHelp, pngEnabled:Boolean, showPng:Boolean } */
  function mountTopBar(opts){
    opts = opts || {};
    var bar = el("header", "topbar");

    bar.appendChild(el("div", "brand", "Emergency Department Simulator"));

    var tabs = el("nav", "tabs");
    [["plan","PLAN","ed_flow_annotator.html"],
     ["simulate","SIMULATE","ed_flow_sim.html"]].forEach(function(t){
      var a = el("a", "tab" + (opts.active === t[0] ? " active" : ""), t[1]);
      a.href = t[2];
      if(opts.active === t[0]) a.setAttribute("aria-current","page");
      tabs.appendChild(a);
    });
    bar.appendChild(tabs);

    var acts = el("div", "acts");
    function act(label, cls, handler, title){
      var b = el("button", "act" + (cls ? " " + cls : ""), label);
      b.type = "button";
      if(title) b.title = title;
      if(handler) b.addEventListener("click", handler);
      else b.disabled = true;
      acts.appendChild(b);
      return b;
    }
    act("?", "help", opts.onHelp || null, "Help and shortcuts");
    act("Import", null, opts.onImport || null);
    act("Export", null, opts.onExport || null);
    var pngBtn = null;
    if(opts.showPng !== false){
      pngBtn = act("PNG", null, opts.onPng || null);
      if(opts.pngEnabled === false) pngBtn.disabled = true;
    }
    act("Settings", null, openSettings);
    act("Save", "save", opts.onSave || null);
    bar.appendChild(acts);

    var host = document.querySelector(".app") || document.body;
    host.insertBefore(bar, host.firstChild);

    return { bar: bar, pngBtn: pngBtn };
  }

  /* ---------- settings modal ---------- */
  var settingsModal = null;
  function buildSettingsModal(){
    var m = el("div", "modal");
    m.hidden = true;
    m.innerHTML =
      '<div class="box" role="dialog" aria-modal="true" aria-label="Settings">' +
        '<h2>Settings</h2>' +
        '<label class="field"><span>Filename</span>' +
          '<input type="text" id="set-filename"></label>' +
        '<label class="field"><span>Department</span>' +
          '<input type="text" id="set-dept"></label>' +
        '<div style="display:grid;grid-template-columns:1fr 1fr;gap:12px">' +
          '<label class="field"><span>Observed by</span>' +
            '<input type="text" id="set-obs"></label>' +
          '<label class="field"><span>Date</span>' +
            '<input type="date" id="set-date"></label>' +
        '</div>' +
        '<label class="field" style="margin-bottom:0"><span>Notes</span>' +
          '<textarea id="set-notes" placeholder="Planning assumptions, observed constraints, route collection notes."></textarea></label>' +
        '<p style="color:var(--text-dim);font-size:12.5px;line-height:1.5;margin:14px 0 0">' +
          'Changing filename will count as a new file when Saved. Saving settings does not automatically save, please click the Save button.</p>' +
        '<div class="row">' +
          '<button class="btn" id="set-cancel" type="button">Cancel</button>' +
          '<button class="btn primary" id="set-save" type="button">Save Settings</button>' +
        '</div>' +
      '</div>';
    document.body.appendChild(m);

    m.addEventListener("click", function(e){ if(e.target === m) closeSettings(); });
    m.querySelector("#set-cancel").addEventListener("click", closeSettings);
    m.querySelector("#set-save").addEventListener("click", function(){
      var s = {
        filename:   cleanFilename(m.querySelector("#set-filename").value, "ed-flow-plan"),
        department: m.querySelector("#set-dept").value.trim(),
        observedBy: m.querySelector("#set-obs").value.trim(),
        date:       m.querySelector("#set-date").value,
        notes:      m.querySelector("#set-notes").value
      };
      if(saveSettings(s)){
        Shell.settings = s;
        document.dispatchEvent(new CustomEvent("nuhs:settings", { detail:s }));
        toast("Settings saved");
      } else {
        toast("Couldn't save settings in this browser", true);
      }
      closeSettings();
    });
    return m;
  }
  function openSettings(){
    if(!settingsModal) settingsModal = buildSettingsModal();
    var s = loadSettings();
    settingsModal.querySelector("#set-filename").value = s.filename;
    settingsModal.querySelector("#set-dept").value  = s.department;
    settingsModal.querySelector("#set-obs").value   = s.observedBy;
    settingsModal.querySelector("#set-date").value  = s.date;
    settingsModal.querySelector("#set-notes").value = s.notes;
    settingsModal.hidden = false;
    settingsModal.querySelector("#set-filename").focus();
  }
  function closeSettings(){ if(settingsModal) settingsModal.hidden = true; }

  document.addEventListener("keydown", function(e){
    if(e.key === "Escape" && settingsModal && !settingsModal.hidden) closeSettings();
  });

  /* ---------- confirm dialog ---------- */
  /* confirm({title, body, confirmLabel, cancelLabel, danger}) -> Promise<bool> */
  function confirmDialog(o){
    return new Promise(function(resolve){
      var m = el("div", "modal");
      m.innerHTML =
        '<div class="box" role="dialog" aria-modal="true" style="width:min(400px,100%)">' +
          '<h2 style="font-size:19px;font-weight:700;margin-bottom:10px"></h2>' +
          '<p style="color:var(--text-dim);margin:0;font-size:13.5px"></p>' +
          '<div class="row">' +
            '<button class="btn" data-no type="button"></button>' +
            '<button class="btn primary" data-yes type="button"></button>' +
          '</div>' +
        '</div>';
      m.querySelector("h2").textContent = o.title || "Are you sure?";
      m.querySelector("p").textContent  = o.body || "";
      var yes = m.querySelector("[data-yes]"), no = m.querySelector("[data-no]");
      yes.textContent = o.confirmLabel || "Confirm";
      no.textContent  = o.cancelLabel  || "Cancel";
      if(o.danger){ yes.classList.remove("primary"); yes.classList.add("danger"); }
      function done(v){ m.remove(); document.removeEventListener("keydown", onKey); resolve(v); }
      function onKey(e){ if(e.key === "Escape") done(false); }
      yes.addEventListener("click", function(){ done(true); });
      no.addEventListener("click",  function(){ done(false); });
      m.addEventListener("click", function(e){ if(e.target === m) done(false); });
      document.addEventListener("keydown", onKey);
      document.body.appendChild(m);
      no.focus();
    });
  }

  /* ---------- unique naming: "New Zone", "New Zone (2)", ... ---------- */
  function uniqueName(base, existing){
    var taken = {};
    (existing || []).forEach(function(n){ taken[String(n).toLowerCase()] = true; });
    if(!taken[base.toLowerCase()]) return base;
    var i = 2;
    while(taken[(base + " (" + i + ")").toLowerCase()]) i++;
    return base + " (" + i + ")";
  }

  /* ---------- shared palette ---------- */
  var PALETTE = ["#E4002B","#F7941D","#2FBF71","#00A9E0","#7D8CB3"];

  var Shell = {
    SETTINGS_KEY: SETTINGS_KEY,
    PALETTE: PALETTE,
    settings: loadSettings(),
    loadSettings: loadSettings,
    saveSettings: saveSettings,
    mountTopBar: mountTopBar,
    openSettings: openSettings,
    confirm: confirmDialog,
    toast: toast,
    el: el,
    downloadBlob: downloadBlob,
    slug: slug,
    uniqueName: uniqueName
  };

  global.NUHS = Shell;
})(window);
