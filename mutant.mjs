Hooks.once("init", async function() {
  console.log("Mutant Chronicles 3e | Initializing System");

  // --- HELPERS HANDLEBARS ---
  Handlebars.registerHelper('eq', (a, b) => a === b);
  Handlebars.registerHelper('gte', (a, b) => a >= b);
  Handlebars.registerHelper('concat', function() {
    let outStr = '';
    for (let arg in arguments) {
      if (typeof arguments[arg] !== 'object') outStr += arguments[arg];
    }
    return outStr;
  });
  Handlebars.registerHelper('range', (min, max) => {
    let a = [];
    for (let i = min; i <= max; i++) a.push(i);
    return a;
  });

  // Pretty-print keys like "mental_strength" => "Mental Strength"
  Handlebars.registerHelper("prettyKey", (key) => {
    return String(key ?? "")
      .replace(/_/g, " ")
      .replace(/\b\w/g, (l) => l.toUpperCase());
  });

   // ===============================
   //  HIT LOCATION (1d20) helper
   // ===============================
   const _mcHitLocation = (n) => {
     const r = Number(n) || 0;
     if (r <= 2) return "HEAD";
     if (r <= 8) return "TORSO";
     if (r <= 11) return "RIGHT ARM";
     if (r <= 14) return "LEFT ARM";
     if (r <= 17) return "RIGHT LEG";
     return "LEFT LEG";
   };

  // ===============================
  //  TEXT ENRICHER: @Quality[UUID]{Label} => clickable tag
  // ===============================
  CONFIG.TextEditor.enrichers ??= [];
  CONFIG.TextEditor.enrichers.push({
    pattern: /@Quality\[(?<uuid>[^\]]+)\](?:\{(?<label>[^}]+)\})?/g,
    enricher: async (match, { uuid, label }) => {
      const doc = await fromUuid(uuid);
      const text = label || doc?.name || "Quality";

      const a = document.createElement("a");
      a.classList.add("mc-quality-tag");
      a.dataset.uuid = uuid;
      a.textContent = text;

      a.style.cssText = `
        display:inline-block;
        padding:2px 8px;
        margin:0 2px;
        border:1px solid #ff6600;
        border-radius:999px;
        background:#111;
        color:#ff6600;
        font-weight:700;
        font-size:11px;
        text-decoration:none;
        vertical-align:middle;
        cursor:pointer;
      `;

      a.addEventListener("click", async (ev) => {
        ev.preventDefault();
        const d = await fromUuid(uuid);
        if (d?.sheet) d.sheet.render(true);
      });

      return a;
    }
  });

  // ===============================
  //  ITEM SHEET: QUALITY (minimal)
  // ===============================
  class QualityItemSheet extends ItemSheet {
    static get defaultOptions() {
      return foundry.utils.mergeObject(super.defaultOptions, {
        classes: ["mutant-chronicles-3e", "sheet", "item", "quality"],
        template: "systems/mutant-chronicles-3e/templates/quality-sheet.html",
        width: 520,
        height: 640,
        resizable: true
      });
    }

    getData() {
      const ctx = super.getData();
      ctx.system = this.item.system;
      return ctx;
    }

    activateListeners(html) {
      super.activateListeners(html);

      html.find(".copy-quality-tag").click(async (ev) => {
        ev.preventDefault();

        const uuid = this.item.uuid;
        const name = this.item.name ?? "Quality";
        const tag = `@Quality[${uuid}]{${name}}`;

        try {
          await navigator.clipboard.writeText(tag);
          ui.notifications.info("Quality tag copied.");
        } catch (e) {
          console.warn(e);
          ui.notifications.warn("Auto copy failed. Manual copy: " + tag);
        }
      });
    }
  }

  // -------------------------------
  //  ITEM SHEET: WEAPON
  // -------------------------------
  class WeaponItemSheet extends ItemSheet {
    static get defaultOptions() {
      return foundry.utils.mergeObject(super.defaultOptions, {
        classes: ["mutant-chronicles-3e", "sheet", "item", "weapon"],
        template: "systems/mutant-chronicles-3e/templates/weapon-sheet.html",
        width: 860,
        height: 860,
        resizable: true
      });
    }

    async getData() {
      const ctx = await super.getData();
      ctx.system = this.item.system;

      ctx.rangeOptions = ["Reach", "Close", "Medium", "Long"];
      ctx.modeOptions = ["-", "Munition", "Semi-Automatic", "Burst", "Automatic"];
      ctx.sizeOptions = ["-", "1H", "2H", "Unbalanced"];

      const uuids = Array.isArray(this.item.system.qualities) ? this.item.system.qualities : [];
      const docs = await Promise.all(uuids.map(u => fromUuid(u).catch(() => null)));
      ctx.weaponQualities = docs.filter(Boolean).map(d => ({ uuid: d.uuid, name: d.name }));

      return ctx;
    }

    activateListeners(html) {
      super.activateListeners(html);

      html.find(".mc-quality-pill").on("click", async (ev) => {
        ev.preventDefault();
        const uuid = ev.currentTarget.dataset.uuid;
        const doc = await fromUuid(uuid);
        doc?.sheet?.render(true);
      });

      html.find(".mc-clear-qualities").on("click", async (ev) => {
        ev.preventDefault();
        await this.item.update({ "system.qualities": [] });
      });

      const dz = html.find(".mc-quality-dropzone")[0];
      if (dz) {
        dz.addEventListener("dragover", (ev) => ev.preventDefault());
        dz.addEventListener("drop", (ev) => this._onDropQuality(ev));
      }

      html.find(".mc-roll-damage").on("click", (ev) => this._onRollDamage(ev));
    }

    async _onDropQuality(ev) {
      ev.preventDefault();

      let data;
      try {
        data = JSON.parse(ev.dataTransfer.getData("text/plain"));
      } catch (_) {
        return;
      }

      const uuid = data?.uuid;
      const type = data?.type;
      if (!uuid || type !== "Item") return;

      const doc = await fromUuid(uuid);
      if (!doc || doc.type !== "quality") {
        ui.notifications.warn("You can only drop Quality items here.");
        return;
      }

      const current = Array.isArray(this.item.system.qualities) ? this.item.system.qualities : [];
      if (current.includes(doc.uuid)) return;

      await this.item.update({ "system.qualities": [...current, doc.uuid] });
    }

    // -------- Symmetry Dice (DSY) --------
    _mapDSY(face) {
      if (face === 1) return { s: 1, e: 0 };
      if (face === 2) return { s: 2, e: 0 };
      if (face === 6) return { s: 0, e: 1 };
      return { s: 0, e: 0 };
    }

    _parseDamageFormula(str) {
      const s = String(str ?? "").replace(/\s+/g, "").toUpperCase();
      const m = s.match(/^(\d+)\+(\d*)DSY$/);
      if (!m) return null;

      const base = Number(m[1] ?? 0);
      const dsyCount = m[2] === "" ? 1 : Number(m[2]);
      return { base, dsyCount };
    }

    async _onRollDamage(ev) {
      ev.preventDefault();

      const dmgStr = this.item.system?.stats?.damage ?? "1+DSY";
      const parsed = this._parseDamageFormula(dmgStr);

      if (!parsed) {
        ui.notifications.warn('Damage must be in the format "X+DSY" or "X+2DSY" (e.g. 1+DSY, 0+2DSY).');
        return;
      }

      const { base, dsyCount } = parsed;
const roll = await new Roll(`${dsyCount}d6`).evaluate();

if (game.dice3d) {
  await game.dice3d.showForRoll(roll, game.user, true);
}

// Extract the d6 term safely
const dieTerms = roll.terms.filter(t => typeof t?.faces === "number" && Array.isArray(t?.results));
const d6Term = dieTerms.find(t => t.faces === 6);

const faces = d6Term?.results?.map(r => r.result) ?? [];

      let dsySuccess = 0;
      let effects = 0;

      const parts = faces.map(f => {
        const out = this._mapDSY(f);
        dsySuccess += out.s;
        effects += out.e;

        let color = "#777";
        if (f === 1) color = "#ff6600";
        if (f === 2) color = "#00ffcc";
        if (f === 6) color = "#66ff66";
        return `<span style="color:${color}; font-weight:900">${f}</span>`;
      }).join(" | ");

      const totalDamage = base + dsySuccess;
      const weaponName = this.item.name ?? "Weapon";

      await ChatMessage.create({
        speaker: ChatMessage.getSpeaker(),
        flavor: `
<div style="background:#1a1a1a;color:white;padding:8px;border:1px solid #ff6600">
  <b style="text-transform:uppercase;">${weaponName} — DAMAGE</b><br>
  <small>Formula: ${base}+${dsyCount === 1 ? "DSY" : `${dsyCount}DSY`}</small>
  <hr style="border-color:#333">
  <div style="margin:6px 0; font-size:16px;">DSY Rolls: ${parts}</div>
  <div><b>Base:</b> ${base} &nbsp; <b>DSY Success:</b> ${dsySuccess} &nbsp; <b>Total Damage:</b> ${totalDamage}</div>
  ${effects > 0 ? `<div style="margin-top:6px;"><b style="color:#66ff66">EFFECT:</b> ${effects}</div>` : ""}
</div>`
      });
    }
  }

  // -------------------------------
  //  ITEM SHEET: ARMOR
  // -------------------------------
  class ArmorItemSheet extends ItemSheet {
    static get defaultOptions() {
      return foundry.utils.mergeObject(super.defaultOptions, {
        classes: ["mutant-chronicles-3e", "sheet", "item", "armor"],
        template: "systems/mutant-chronicles-3e/templates/armor-sheet.html",
        width: 760,
        height: 760,
        resizable: true
      });
    }

    getData() {
      const ctx = super.getData();
      ctx.system = this.item.system;

      ctx.armsCoverageOptions = [
        { value: "both", label: "Both Arms" },
        { value: "left", label: "Left Arm" },
        { value: "right", label: "Right Arm" }
      ];

      return ctx;
    }
  }

  // -------------------------------
  //  ITEM SHEET: TALENT
  // -------------------------------
  class TalentItemSheet extends ItemSheet {
    static get defaultOptions() {
      return foundry.utils.mergeObject(super.defaultOptions, {
        classes: ["mutant-chronicles-3e", "sheet", "item", "talent"],
        template: "systems/mutant-chronicles-3e/templates/talent-sheet.html",
        width: 760,
        height: 760,
        resizable: true
      });
    }

    getData() {
  const ctx = super.getData();
  ctx.system = this.item.system;

  // Try multiple sources for skills (Foundry version / system model differences)
  const fromActorModel = game.system?.model?.Actor?.character?.skills;
  const fromActorSystem = game.actors?.contents?.find(a => a.type === "character")?.system?.skills;
  const fromThisActor = this.item.parent?.system?.skills;

  const src = fromThisActor ?? fromActorSystem ?? fromActorModel ?? {};
  ctx.skillOptions = Object.keys(src);

  // last-resort fallback so the dropdown never becomes empty
  if (!ctx.skillOptions.length) {
    ctx.skillOptions = Object.keys(game.system?.template?.Actor?.character?.skills ?? {});
  }

  return ctx;
}

  }

  // -------------------------------
  //  ITEM SHEET: SPELL
  // -------------------------------
  class SpellItemSheet extends ItemSheet {
    static get defaultOptions() {
      return foundry.utils.mergeObject(super.defaultOptions, {
        classes: ["mutant-chronicles-3e", "sheet", "item", "spell"],
        template: "systems/mutant-chronicles-3e/templates/spell-sheet.html",
        width: 860,
        height: 760,
        resizable: true
      });
    }

    getData() {
      const ctx = super.getData();
      ctx.system = this.item.system;
      ctx.difficultyOptions = ["D1", "D2", "D3", "D4", "D5"];
      return ctx;
    }
  }
    // -------------------------------
  //  ITEM SHEET: VEHICLE
  // -------------------------------
  class VehicleItemSheet extends ItemSheet {
    static get defaultOptions() {
      return foundry.utils.mergeObject(super.defaultOptions, {
        classes: ["mutant-chronicles-3e", "sheet", "item", "vehicle"],
        template: "systems/mutant-chronicles-3e/templates/vehicle-sheet.html",
        width: 900,
        height: 900,
        resizable: true
      });
    }

    async getData() {
      const ctx = await super.getData();
      ctx.system = this.item.system;

      // Resolve Quality pills
      const uuids = Array.isArray(this.item.system.qualities) ? this.item.system.qualities : [];
      const docs = await Promise.all(uuids.map(u => fromUuid(u).catch(() => null)));
      ctx.vehicleQualities = docs.filter(Boolean).map(d => ({ uuid: d.uuid, name: d.name }));

      // Build damage tracker boxes from Max/Cur
      const clamp = (n, a, b) => Math.max(a, Math.min(b, Number(n || 0)));
      const mkTrack = (cur, max) => {
        const M = clamp(max, 0, 30);
        const C = clamp(cur, 0, M);
        return {
          cur: C,
          max: M,
          boxes: Array.from({ length: M }, (_, i) => ({ index: i, checked: i < C }))
        };
      };

      const loc = this.item.system.locations ?? {};
      const hull = loc.hull ?? {};
      const motive = loc.motive ?? {};

      ctx.locationsView = {
        hull: {
          label: "HULL",
          soak: Number(hull.soak ?? 0),
          surface: mkTrack(hull.surfaceCur, hull.surfaceMax),
          system: mkTrack(hull.systemCur, hull.systemMax),
          structural: mkTrack(hull.structuralCur, hull.structuralMax)
        },
        motive: {
          label: "MOTIVE SYSTEM",
          soak: Number(motive.soak ?? 0),
          surface: mkTrack(motive.surfaceCur, motive.surfaceMax),
          system: mkTrack(motive.systemCur, motive.systemMax),
          structural: mkTrack(motive.structuralCur, motive.structuralMax)
        }
      };

      return ctx;
    }

    activateListeners(html) {
      super.activateListeners(html);

      // Quality pills open
      html.find(".mc-quality-pill").on("click", async (ev) => {
        ev.preventDefault();
        const uuid = ev.currentTarget.dataset.uuid;
        const doc = await fromUuid(uuid);
        doc?.sheet?.render(true);
      });

      // Clear qualities
      html.find(".mc-clear-qualities").on("click", async (ev) => {
        ev.preventDefault();
        await this.item.update({ "system.qualities": [] });
      });

      // Dropzone Qualities
      const dzQ = html.find(".mc-quality-dropzone")[0];
      if (dzQ) {
        dzQ.addEventListener("dragover", (ev) => ev.preventDefault());
        dzQ.addEventListener("drop", (ev) => this._onDropQuality(ev));
      }

      // Dropzone Pilot (Actor)
      const dzP = html.find(".mc-pilot-dropzone")[0];
      if (dzP) {
        dzP.addEventListener("dragover", (ev) => ev.preventDefault());
        dzP.addEventListener("drop", (ev) => this._onDropPilot(ev));
      }

      // Damage boxes click => set Cur
      html.find(".mc-veh-dmg-box").on("click", async (ev) => {
        ev.preventDefault();
        const el = ev.currentTarget;
        const path = el.dataset.path; // e.g. system.locations.hull.surfaceCur
        const idx = Number(el.dataset.index ?? -1);
        const maxPath = el.dataset.maxPath; // e.g. system.locations.hull.surfaceMax
        if (!path || idx < 0 || !maxPath) return;

        const max = Number(foundry.utils.getProperty(this.item, maxPath) ?? 0);
        const cur = Number(foundry.utils.getProperty(this.item, path) ?? 0);

        const target = idx + 1;
        const next = (cur === target) ? (target - 1) : target;
        const clamped = Math.max(0, Math.min(max, next));

        await this.item.update({ [path]: clamped });
      });

      // IMPACT! button
      html.find(".mc-impact-roll").on("click", (ev) => this._onRollImpact(ev));
    }

    async _onDropQuality(ev) {
      ev.preventDefault();

      let data;
      try { data = JSON.parse(ev.dataTransfer.getData("text/plain")); }
      catch (_) { return; }

      const uuid = data?.uuid;
      const type = data?.type;
      if (!uuid || type !== "Item") return;

      const doc = await fromUuid(uuid).catch(() => null);
      if (!doc || doc.type !== "quality") {
        ui.notifications.warn("You can only drop Quality items here.");
        return;
      }

      const current = Array.isArray(this.item.system.qualities) ? this.item.system.qualities : [];
      if (current.includes(doc.uuid)) return;

      await this.item.update({ "system.qualities": [...current, doc.uuid] });
    }

    async _onDropPilot(ev) {
      ev.preventDefault();

      let data;
      try { data = JSON.parse(ev.dataTransfer.getData("text/plain")); }
      catch (_) { return; }

      // Actor drop
      const uuid = data?.uuid;
      if (!uuid || data?.type !== "Actor") {
        ui.notifications.warn("Drop an Actor here (pilot).");
        return;
      }

      const doc = await fromUuid(uuid).catch(() => null);
      if (!doc || doc.documentName !== "Actor") {
        ui.notifications.warn("Invalid pilot drop.");
        return;
      }

      await this.item.update({
        "system.crew.pilotUuid": doc.uuid,
        "system.crew.pilotName": doc.name ?? ""
      });
    }

    _mapDSY(face) {
      if (face === 1) return { s: 1, e: 0 };
      if (face === 2) return { s: 2, e: 0 };
      if (face === 6) return { s: 0, e: 1 };
      return { s: 0, e: 0 };
    }

    _parseDamageFormula(str) {
      const s = String(str ?? "").replace(/\s+/g, "").toUpperCase();
      const m = s.match(/^(\d+)\+(\d*)DSY$/);
      if (!m) return null;
      const base = Number(m[1] ?? 0);
      const dsyCount = m[2] === "" ? 1 : Number(m[2]);
      return { base, dsyCount };
    }

    async _onRollImpact(ev) {
      ev.preventDefault();

      const dmgStr = this.item.system?.impact_damage ?? "1+DSY";
      const parsed = this._parseDamageFormula(dmgStr);
      if (!parsed) {
        ui.notifications.warn('Impact Damage must be "X+DSY" or "X+2DSY".');
        return;
      }

      const { base, dsyCount } = parsed;

      const roll = await new Roll(`${dsyCount}d6`).evaluate();
      if (game.dice3d) await game.dice3d.showForRoll(roll, game.user, true);

      const dieTerms = roll.terms.filter(t => typeof t?.faces === "number" && Array.isArray(t?.results));
      const d6Term = dieTerms.find(t => t.faces === 6);
      const faces = d6Term?.results?.map(r => r.result) ?? [];

      let dsySuccess = 0;
      let effects = 0;

      const parts = faces.map(f => {
        const out = this._mapDSY(f);
        dsySuccess += out.s;
        effects += out.e;

        let color = "#777";
        if (f === 1) color = "#ff6600";
        if (f === 2) color = "#00ffcc";
        if (f === 6) color = "#66ff66";
        return `<span style="color:${color}; font-weight:900">${f}</span>`;
      }).join(" | ");

      const total = base + dsySuccess;

      await ChatMessage.create({
        speaker: ChatMessage.getSpeaker(),
        flavor: `<b style="text-transform:uppercase;">${this.item.name ?? "Vehicle"} — IMPACT</b>`,
        content: `
<div style="background:#1a1a1a;color:white;padding:8px;border:1px solid #ff6600">
  <small>Formula: ${base}+${dsyCount === 1 ? "DSY" : `${dsyCount}DSY`}</small>
  <hr style="border-color:#333">
  <div style="margin:6px 0; font-size:16px;">DSY Rolls: ${parts}</div>
  <div><b>Base:</b> ${base} &nbsp; <b>Success:</b> ${dsySuccess}</div>
  <div style="font-size:16px; font-weight:900; text-decoration:underline; text-align:right; margin-top:4px; color:#ff6600;">
    Total: ${total}
  </div>
  ${effects > 0 ? `<div style="margin-top:6px;"><b style="color:#66ff66">EFFECT:</b> ${effects}</div>` : ""}
</div>`
      });
    }
  }



  

  // Register sheets
  Items.registerSheet("mutant", WeaponItemSheet, { types: ["weapon"], makeDefault: true });
  Items.registerSheet("mutant", QualityItemSheet, { types: ["quality"], makeDefault: true });
  Items.registerSheet("mutant", ArmorItemSheet,  { types: ["armor"],  makeDefault: true });
  Items.registerSheet("mutant", TalentItemSheet, { types: ["talent"], makeDefault: true });
  Items.registerSheet("mutant", SpellItemSheet,  { types: ["spell"],  makeDefault: true });
  Items.registerSheet("mutant", VehicleItemSheet, { types: ["vehicle"], makeDefault: true });



  // --- ACTOR SHEET ---
  class MutantActorSheet extends ActorSheet {
static get defaultOptions() {
  return foundry.utils.mergeObject(super.defaultOptions, {
    classes: ["mutant-chronicles-3e", "sheet", "actor"],
    template: "systems/mutant-chronicles-3e/templates/actor-sheet.html",
    width: 900,
    height: 980,

    // Foundry-native tabs
    tabs: [{ navSelector: ".sheet-tabs", contentSelector: ".sheet-body", initial: "stats" }],

    // IMPORTANT: makes Physique/Strength changes immediately update actor data,
    // which triggers a re-render => wound boxes update live.
    submitOnChange: true,
    closeOnSubmit: false
  });
}


    // -------- Combat boxes table (Physique + Strength) --------
    _combatBoxConfig(total) {
      const rows = [
        { min: -Infinity, max: 9,  head:2, torso:5,  ra:2, la:2, rl:3, ll:3, serious:4, critical:2 },
        { min: 10, max: 11, head:2, torso:6,  ra:2, la:2, rl:4, ll:4, serious:4, critical:2 },
        { min: 12, max: 13, head:2, torso:6,  ra:3, la:3, rl:4, ll:4, serious:5, critical:3 },
        { min: 14, max: 15, head:3, torso:7,  ra:3, la:3, rl:5, ll:5, serious:5, critical:3 },
        { min: 16, max: 17, head:3, torso:7,  ra:4, la:4, rl:5, ll:5, serious:6, critical:3 },
        { min: 18, max: 19, head:3, torso:8,  ra:4, la:4, rl:6, ll:6, serious:6, critical:4 },
        { min: 20, max: 21, head:4, torso:8,  ra:5, la:5, rl:6, ll:6, serious:7, critical:4 },
        { min: 22, max: 23, head:4, torso:9,  ra:5, la:5, rl:7, ll:7, serious:7, critical:4 },
        { min: 24, max: 25, head:4, torso:9,  ra:6, la:6, rl:7, ll:7, serious:8, critical:5 },
        { min: 26, max: 27, head:5, torso:10, ra:6, la:6, rl:8, ll:8, serious:8, critical:5 },
        { min: 28, max: 29, head:5, torso:10, ra:7, la:7, rl:8, ll:9, serious:9, critical:5 },
        { min: 30, max: Infinity, head:5, torso:11, ra:7, la:7, rl:9, ll:9, serious:9, critical:6 }
      ];

      return rows.find(r => total >= r.min && total <= r.max) ?? rows[0];
    }

    _normalizeBoolArray(arr, len) {
      const a = Array.isArray(arr) ? arr.slice(0, len) : [];
      while (a.length < len) a.push(false);
      return a;
    }

    // -------- Symmetry Dice (DSY) helpers --------
    _mapDSY(face) {
      if (face === 1) return { s: 1, e: 0 };
      if (face === 2) return { s: 2, e: 0 };
      if (face === 6) return { s: 0, e: 1 };
      return { s: 0, e: 0 };
    }

    _parseDamageFormula(str) {
      const s = String(str ?? "").replace(/\s+/g, "").toUpperCase();
      const m = s.match(/^(\d+)\+(\d*)DSY$/);
      if (!m) return null;

      const base = Number(m[1] ?? 0);
      const dsyCount = m[2] === "" ? 1 : Number(m[2]);
      return { base, dsyCount };
    }


    async getData() {
      const context = super.getData();

      // Restore last active tab (must be set BEFORE render, so Foundry can activate it natively)
      const SCOPE = game.system.id;
      const saved = this.actor.getFlag(SCOPE, "activeTab") || "stats";
      if (this.options?.tabs?.[0]) this.options.tabs[0].initial = saved;

      const system = this.actor.system;

      // Chronicle Points (value/max) – ensure backward compatibility
      system.chronicle_points ??= { value: 0, max: 5 };
      system.chronicle_points.value = Number(system.chronicle_points.value ?? 0);
      system.chronicle_points.max = Number(system.chronicle_points.max ?? 5);
      if (!Number.isFinite(system.chronicle_points.max) || system.chronicle_points.max < 0) {
        system.chronicle_points.max = 0;
      }
      if (system.chronicle_points.value > system.chronicle_points.max) {
        system.chronicle_points.value = system.chronicle_points.max;
      }
      // 1. Symmetry Bonus
      const getSym = (v) => v <= 8 ? 0 : v === 9 ? 1 : v <= 11 ? 2 : v <= 13 ? 3 : v <= 15 ? 4 : 5;
      if (system.attributes) {
        system.damage_bonus.ranged.value = getSym(system.attributes.awareness.value);
        system.damage_bonus.melee.value = getSym(system.attributes.strength.value);
      }

      // 2. DREAD logic
      const totalDread = system.dread.value || 0;

      let levels = [
        { id: 0, label: "20",    code: "",   boxes: 1, threshold: 1,  val: 0 },
        { id: 1, label: "19-20", code: "D1", boxes: 2, threshold: 3,  val: 1 },
        { id: 2, label: "18-20", code: "D2", boxes: 3, threshold: 6,  val: 2 },
        { id: 3, label: "17-20", code: "D3", boxes: 4, threshold: 10, val: 3 },
        { id: 4, label: "16-20", code: "D4", boxes: 5, threshold: 15, val: 4 }
      ];

      let activeDreadValue = 0;
      let previousThreshold = 0;

      context.dreadLevels = levels.map(level => {
        const isComplete = totalDread >= level.threshold;
        if (isComplete) activeDreadValue = level.val;

        let levelBoxes = [];
        for (let i = 1; i <= level.boxes; i++) {
          let globalBoxIndex = previousThreshold + i;
          levelBoxes.push({
            globalIndex: globalBoxIndex,
            isChecked: totalDread >= globalBoxIndex
          });
        }

        previousThreshold = level.threshold;

        return {
          ...level,
          isComplete: isComplete,
          levelBoxes: levelBoxes
        };
      });

      context.activeDreadValue = activeDreadValue;
      this.calculatedDreadEffect = activeDreadValue;

      // 3. Dynamic TN
      if (system.skills && system.attributes) {
        for (let [id, skill] of Object.entries(system.skills)) {
          const attrVal = system.attributes[skill.attribute]?.value || 0;
          skill.tn = attrVal + skill.expertise;
          skill.label = id.replace(/_/g, " ");
        }
      }

            // 4. Traits (Quality items stored on the actor as UUIDs)
      let traitUuids = system.traits;

      // Backward compat: if it's a single string, convert to [string]
      if (typeof traitUuids === "string" && traitUuids.trim().length) {
        traitUuids = [traitUuids.trim()];
      }

      // Ensure array
      traitUuids = Array.isArray(traitUuids) ? traitUuids.filter(Boolean) : [];

      // Optional: write back normalized array so it stays clean
      if (!Array.isArray(system.traits) || system.traits.length !== traitUuids.length) {
        this.actor.update({ "system.traits": traitUuids }).catch(() => {});
      }

      const traitDocs = await Promise.all(traitUuids.map(u => fromUuid(u).catch(() => null)));
      context.traitQualities = traitDocs
        .filter(Boolean)
        .map(d => ({ uuid: d.uuid, name: d.name, img: d.img }));

      // -------------------------------
      //  COMBAT & GEAR DATA
      // -------------------------------
      system.combat ??= {
        statusQuality: "",
        criticalInjuryQuality: "",
        wounds: { head: [], torso: [], rightArm: [], leftArm: [], rightLeg: [], leftLeg: [] },
        seriousWounds: [],
        criticalWounds: [],
        belongings: ""
      };
      system.combat.wounds ??= { head: [], torso: [], rightArm: [], leftArm: [], rightLeg: [], leftLeg: [] };

      const phy = Number(system.attributes?.physique?.value ?? 0);
      const str = Number(system.attributes?.strength?.value ?? 0);
      const totalPS = phy + str;

      const cfg = this._combatBoxConfig(totalPS);

      const w = system.combat.wounds;
      const headArr     = this._normalizeBoolArray(w.head, cfg.head);
      const torsoArr    = this._normalizeBoolArray(w.torso, cfg.torso);
      const rArmArr     = this._normalizeBoolArray(w.rightArm, cfg.ra);
      const lArmArr     = this._normalizeBoolArray(w.leftArm, cfg.la);
      const rLegArr     = this._normalizeBoolArray(w.rightLeg, cfg.rl);
      const lLegArr     = this._normalizeBoolArray(w.leftLeg, cfg.ll);
      const seriousArr  = this._normalizeBoolArray(system.combat.seriousWounds, cfg.serious);
      const criticalArr = this._normalizeBoolArray(system.combat.criticalWounds, cfg.critical);

      // Equipped armor => soak calc
      const equippedArmors = this.actor.items.filter(i => i.type === "armor" && i.system?.equipped === true);

      const soak = { head: 0, torso: 0, rightArm: 0, leftArm: 0, rightLeg: 0, leftLeg: 0 };

      for (const a of equippedArmors) {
        const s = a.system?.soak ?? {};
        const armsCoverage = String(a.system?.armsCoverage ?? "both");

        soak.head  += Number(s.head ?? 0);
        soak.torso += Number(s.torso ?? 0);

        // legs are a single value in your armor model -> applies to both
        const legsVal = Number(s.legs ?? 0);
        soak.rightLeg += legsVal;
        soak.leftLeg  += legsVal;

        // arms coverage
        const armsVal = Number(s.arms ?? 0);
        if (armsCoverage === "both") {
          soak.rightArm += armsVal;
          soak.leftArm  += armsVal;
        } else if (armsCoverage === "right") {
          soak.rightArm += armsVal;
        } else if (armsCoverage === "left") {
          soak.leftArm += armsVal;
        }
      }

      // Combat drop qualities (Status / Critical Injury)
      const statusUuid = String(system.combat.statusQuality ?? "");
      const critUuid   = String(system.combat.criticalInjuryQuality ?? "");

      const statusDoc = statusUuid ? await fromUuid(statusUuid).catch(() => null) : null;
      const critDoc   = critUuid ? await fromUuid(critUuid).catch(() => null) : null;

      context.combatStatus = statusDoc ? { uuid: statusDoc.uuid, name: statusDoc.name } : null;
      context.combatCriticalInjury = critDoc ? { uuid: critDoc.uuid, name: critDoc.name } : null;

      const makeBoxes = (arr) => arr.map((checked, idx) => ({ index: idx, checked: !!checked }));

      // Provide BOTH: array (legacy) + object (for your new ordered layout)
      const headLoc = { label: "Head", soak: soak.head, path: "system.combat.wounds.head", boxes: makeBoxes(headArr) };
      const rArmLoc = { label: "Right Arm", soak: soak.rightArm, path: "system.combat.wounds.rightArm", boxes: makeBoxes(rArmArr) };
      const lArmLoc = { label: "Left Arm", soak: soak.leftArm, path: "system.combat.wounds.leftArm", boxes: makeBoxes(lArmArr) };
      const torsoLoc = { label: "Torso", soak: soak.torso, path: "system.combat.wounds.torso", boxes: makeBoxes(torsoArr) };
      const rLegLoc = { label: "Right Leg", soak: soak.rightLeg, path: "system.combat.wounds.rightLeg", boxes: makeBoxes(rLegArr) };
      const lLegLoc = { label: "Left Leg", soak: soak.leftLeg, path: "system.combat.wounds.leftLeg", boxes: makeBoxes(lLegArr) };

      context.combatLocations = [ headLoc, rArmLoc, lArmLoc, torsoLoc, rLegLoc, lLegLoc ];
      context.combatLoc = {
        head: headLoc,
        rightArm: rArmLoc,
        leftArm: lArmLoc,
        torso: torsoLoc,
        rightLeg: rLegLoc,
        leftLeg: lLegLoc
      };

      context.combatSeriousBoxes = makeBoxes(seriousArr);
      context.combatCriticalBoxes = makeBoxes(criticalArr);

      // --- Mental Wounds (boxes = Mental Strength) ---
      const mentalMax = Math.max(0, Number(system.attributes?.mental_strength?.value ?? 0));
      system.combat.mentalWounds = this._normalizeBoolArray(system.combat.mentalWounds, mentalMax);
      const mentalArr = system.combat.mentalWounds;
      context.combatMentalBoxes = makeBoxes(mentalArr);

      // Equipped weapons list + qualities resolve
      const equippedWeapons = this.actor.items.filter(i => i.type === "weapon" && i.system?.equipped === true);

      const weaponViews = [];
      for (const wpn of equippedWeapons) {
        const wsys = wpn.system ?? {};
        const stats = wsys.stats ?? {};
        const reloadUsed = Math.clamp(Number(wsys.reloadUsed ?? 0), 0, 5);

        const quuids = Array.isArray(wsys.qualities) ? wsys.qualities : [];
        const qdocs = await Promise.all(quuids.map(u => fromUuid(u).catch(() => null)));
        const qview = qdocs.filter(Boolean).map(d => ({ uuid: d.uuid, name: d.name }));

        weaponViews.push({
          id: wpn.id,
          uuid: wpn.uuid,
          name: wpn.name,
          img: wpn.img,
          stats: {
            range: stats.range ?? "",
            damage: stats.damage ?? "",
            enc: stats.enc ?? "",
            size: stats.size ?? "",
            reliability: stats.reliability ?? ""
          },
          reloadDots: [0,1,2,3,4].map(i => ({ index: i, filled: i < reloadUsed })),
          qualities: qview
        });
      }

      context.equippedWeapons = weaponViews;

      // -------------------------------
      //  GEAR (weapons + armors)
      // -------------------------------
      const gearItems = this.actor.items
        .filter(i => ["weapon", "armor"].includes(i.type))
        .map(i => ({
          id: i.id,
          uuid: i.uuid,
          name: i.name,
          img: i.img,
          type: i.type,
          equipped: !!i.system?.equipped
        }));

      context.gearItems = gearItems;

      // Equipped armors list (for the "Equipped Armor" panel)
      context.equippedArmors = equippedArmors.map(a => ({
        id: a.id,
        uuid: a.uuid,
        name: a.name,
        img: a.img
      }));
	  // -------------------------------
      //  TALENTS & SPELLS (tab)
      // -------------------------------

		context.talents = this.actor.items
         .filter(i => i.type === "talent")
         .map(i => {
           const rawDesc = (i.system?.description ?? "").toString();
           // Remove leading indentation per-line + trim overall (fixes "big tab" look)
           const cleanDesc = rawDesc
             .replace(/\r/g, "")
             .split("\n")
             .map(l => l.trim())
             .join("\n")
             .trim();

           return {
             id: i.id,
             uuid: i.uuid,
             name: i.name,
             img: i.img,
             talentTree: i.system?.talentTree ?? "",
             prerequisite: i.system?.prerequisite ?? "",
             description: cleanDesc
           };
         });

		context.spells = this.actor.items
         .filter(i => i.type === "spell")
         .map(i => ({
           id: i.id,
           uuid: i.uuid,
           name: i.name,
           img: i.img,
           difficulty: i.system?.difficulty ?? "D1",
           target: i.system?.target ?? "",
           duration: i.system?.duration ?? "",
           baseEffect: i.system?.baseEffect ?? "",
           momentum: i.system?.momentum ?? ""
         }));

      context.system = system;
      return context;
	}

    activateListeners(html) {
      super.activateListeners(html);

// Persist active tab (Foundry-native tabs handle switching; we only store the choice)
const SCOPE = game.system.id;
html.find(".sheet-tabs .item").on("click", (ev) => {
  const tab = ev.currentTarget?.dataset?.tab;
  if (!tab) return;
  this.actor.setFlag(SCOPE, "activeTab", tab).catch(console.error);
});




      html.find(".mc-quality-tag").on("click", async (ev) => {
        ev.preventDefault();
        const uuid = ev.currentTarget.dataset.uuid;
        const doc = await fromUuid(uuid);
        doc?.sheet?.render(true);
      });

      html.find('.roll-skill').click(this._onRollSkill.bind(this));

      html.find('.dread-box-click').click(async ev => {
        const targetValue = parseInt(ev.currentTarget.dataset.target);
        const currentValue = this.actor.system.dread.value || 0;

        let newValue = targetValue;
        if (targetValue === currentValue) {
          newValue = targetValue - 1;
        }

        await this.actor.update({ "system.dread.value": newValue });
      });

      // Traits drop zone (Quality items)
      const dzTraits = html.find(".mc-traits-dropzone")[0];
      if (dzTraits) {
        dzTraits.addEventListener("dragover", (ev) => ev.preventDefault());
        dzTraits.addEventListener("drop", async (ev) => {
          ev.preventDefault();

          let data;
          try {
            data = JSON.parse(ev.dataTransfer.getData("text/plain"));
          } catch (_) {
            return;
          }

          const uuid = data?.uuid;
          const type = data?.type;
          if (!uuid || type !== "Item") return;

          const doc = await fromUuid(uuid);
          if (!doc || doc.type !== "quality") {
            ui.notifications.warn("Only Quality items can be added as Traits.");
            return;
          }

          const current = Array.isArray(this.actor.system.traits) ? this.actor.system.traits : [];
          if (current.includes(doc.uuid)) return;

          await this.actor.update({ "system.traits": [...current, doc.uuid] });
        });
      }

      // Open trait sheet
      html.find(".mc-trait-open").on("click", async (ev) => {
        ev.preventDefault();
        ev.stopPropagation();
        const uuid = ev.currentTarget.dataset.uuid;
        const doc = await fromUuid(uuid).catch(() => null);
        doc?.sheet?.render(true);
      });

      // Delete trait (remove UUID from system.traits)
      html.find(".mc-trait-delete").on("click", async (ev) => {
        ev.preventDefault();
        ev.stopPropagation();

        const uuid = ev.currentTarget.dataset.uuid;
        if (!uuid) return;

        const current = Array.isArray(this.actor.system.traits) ? this.actor.system.traits : [];
        const next = current.filter(u => u !== uuid);

        await this.actor.update({ "system.traits": next });
      });

      // Combat & Gear: wound boxes
      html.find(".mc-wound-box").on("click", async (ev) => {
        ev.preventDefault();

        const el = ev.currentTarget;
        const path = el.dataset.path;
        const idx = Number(el.dataset.index ?? -1);
        if (!path || idx < 0) return;

        const siblings = html.find(`.mc-wound-box[data-path="${path}"]`);
        const desiredLen = siblings.length;

        const currentArr = foundry.utils.getProperty(this.actor, path);
        const notice = Array.isArray(currentArr) ? currentArr : [];
        const arr = notice.slice(0, desiredLen);
        while (arr.length < desiredLen) arr.push(false);

        arr[idx] = !arr[idx];
        await this.actor.update({ [path]: arr });
      });

      // Combat & Gear: reload dots
      html.find(".mc-reload-dot").on("click", async (ev) => {
        ev.preventDefault();
        const weaponId = ev.currentTarget.dataset.weaponId;
        const dotIndex = Number(ev.currentTarget.dataset.reloadIndex ?? -1);
        if (!weaponId || dotIndex < 0) return;

        const wpn = this.actor.items.get(weaponId);
        if (!wpn) return;

        const current = Math.clamp(Number(wpn.system?.reloadUsed ?? 0), 0, 5);
        const target = dotIndex + 1;
        const next = (current === target) ? (target - 1) : target;

        await wpn.update({ "system.reloadUsed": Math.clamp(next, 0, 5) });
      });

      // Combat & Gear: dropzones (Status / Critical Injury)
      const dropzones = html.find(".mc-combat-dropzone");
      dropzones.each((_, node) => {
        node.addEventListener("dragover", (ev) => ev.preventDefault());
        node.addEventListener("drop", async (ev) => {
          ev.preventDefault();

          let data;
          try {
            data = JSON.parse(ev.dataTransfer.getData("text/plain"));
          } catch (_) {
            return;
          }

          const uuid = data?.uuid;
          const type = data?.type;
          if (!uuid || type !== "Item") return;

          const doc = await fromUuid(uuid);
          if (!doc || doc.type !== "quality") {
            ui.notifications.warn("Only Quality items can be dropped here.");
            return;
          }

          const target = node.dataset.target; // status | criticalInjury
          if (target === "status") {
            await this.actor.update({ "system.combat.statusQuality": doc.uuid });
          } else if (target === "criticalInjury") {
            await this.actor.update({ "system.combat.criticalInjuryQuality": doc.uuid });
          }
        });
      });

      html.find(".mc-combat-quality-pill").on("click", async (ev) => {
        ev.preventDefault();
        const uuid = ev.currentTarget.dataset.uuid;
        const doc = await fromUuid(uuid);
        doc?.sheet?.render(true);
      });
     
             // -------------------------------
             //  GEAR UI (drop + edit + equip + delete)
             // -------------------------------
 
             // Drop weapon/armor into GEAR
             const dzGear = html.find(".mc-gear-dropzone")[0];
             if (dzGear) {
                 dzGear.addEventListener("dragover", ev => ev.preventDefault());
                 dzGear.addEventListener("drop", async (ev) => {
                     ev.preventDefault();
					 ev.stopPropagation();
 
                     let data;
                     try {
                         data = JSON.parse(ev.dataTransfer.getData("text/plain"));
                     } catch (_) {
                         return;
                     }
 
                     if (data.type !== "Item" || !data.uuid) return;
 
                     const doc = await fromUuid(data.uuid).catch(() => null);
                     if (!doc || !["weapon", "armor"].includes(doc.type)) {
                         ui.notifications.warn("Only WEAPON and ARMOR can be dropped in GEAR.");
                         return;
                     }
 
                     // Create embedded item on actor
                     await this.actor.createEmbeddedDocuments("Item", [doc.toObject()]);
                 });
             }
 
             // Edit item
             html.find(".mc-gear-edit").on("click", (ev) => {
                 ev.preventDefault();
                 const id = ev.currentTarget.dataset.itemId;
                 const it = this.actor.items.get(id);
                 it?.sheet?.render(true);
             });
 
             // Equip / Unequip item (weapon or armor)
             html.find(".mc-gear-toggle").on("click", async (ev) => {
                 ev.preventDefault();
                 const id = ev.currentTarget.dataset.itemId;
                 const it = this.actor.items.get(id);
                 if (!it) return;

                 const now = !!it.system?.equipped;
                 await it.update({ "system.equipped": !now });
             });
 
             // Delete from actor (remove from GEAR)
             html.find(".mc-gear-delete").on("click", async (ev) => {
                 ev.preventDefault();
                 const id = ev.currentTarget.dataset.itemId;
                 if (!id) return;
                 await this.actor.deleteEmbeddedDocuments("Item", [id]);
             });
			       // -------------------------------
      //  TALENTS & SPELLS UI (drop + chat + edit + delete)
      // -------------------------------
      const _safeDropItemToActor = async (ev, allowedType) => {
        ev.preventDefault();
        ev.stopPropagation();

        let data;
        try {
          data = JSON.parse(ev.dataTransfer.getData("text/plain"));
        } catch (_) {
          return;
        }

        if (data.type !== "Item" || !data.uuid) return;

        const doc = await fromUuid(data.uuid).catch(() => null);
        if (!doc || doc.type !== allowedType) {
          ui.notifications.warn(`Only ${allowedType.toUpperCase()} items can be dropped here.`);
          return;
        }

        // If you're dragging an embedded item from THIS actor onto itself, do nothing
        if (doc.parent?.uuid === this.actor.uuid) return;

        await this.actor.createEmbeddedDocuments("Item", [doc.toObject()]);
      };

      // Dropzones
      const dzTalents = html.find(".mc-talents-dropzone")[0];
      if (dzTalents) {
        dzTalents.addEventListener("dragover", ev => ev.preventDefault());
        dzTalents.addEventListener("drop", ev => _safeDropItemToActor(ev, "talent"));
      }

      const dzSpells = html.find(".mc-spells-dropzone")[0];
      if (dzSpells) {
        dzSpells.addEventListener("dragover", ev => ev.preventDefault());
        dzSpells.addEventListener("drop", ev => _safeDropItemToActor(ev, "spell"));
      }

      // Buttons (chat / edit / delete)
      html.find(".mc-item-edit").on("click", (ev) => {
        ev.preventDefault();
        const id = ev.currentTarget.dataset.itemId;
        this.actor.items.get(id)?.sheet?.render(true);
      });

      html.find(".mc-item-delete").on("click", async (ev) => {
        ev.preventDefault();
        const id = ev.currentTarget.dataset.itemId;
        if (!id) return;
        await this.actor.deleteEmbeddedDocuments("Item", [id]);
      });

      html.find(".mc-item-chat").on("click", async (ev) => {
        ev.preventDefault();
        const id = ev.currentTarget.dataset.itemId;
        const item = this.actor.items.get(id);
        if (!item) return;

        // Foundry standard: send item description to chat
        const content = await TextEditor.enrichHTML(item.system?.description ?? "", { async: true });

        await ChatMessage.create({
          speaker: ChatMessage.getSpeaker({ actor: this.actor }),
          flavor: `<b>${item.name}</b>`,
          content
        });
      });

			       // -------------------------------
      //  WEAPON ATTACK (DSY + actor bonus)
      // -------------------------------
      html.find(".mc-weapon-attack").on("click", async (ev) => {
        ev.preventDefault();

        const weaponId = ev.currentTarget.dataset.weaponId;
        const wpn = this.actor.items.get(weaponId);
        if (!wpn) return;

        const range = String(wpn.system?.stats?.range ?? "").toUpperCase();
        const isMelee = (range === "REACH");

        const bonus = Number(
          isMelee
            ? (this.actor.system?.damage_bonus?.melee?.value ?? 0)
            : (this.actor.system?.damage_bonus?.ranged?.value ?? 0)
        );

        const dmgStr = wpn.system?.stats?.damage ?? "1+DSY";
        const parsed = this._parseDamageFormula(dmgStr);

        if (!parsed) {
          ui.notifications.warn('Damage must be in the format "X+DSY" or "X+2DSY" (e.g. 3+DSY, 3+3DSY).');
          return;
        }

        const { base, dsyCount } = parsed;
        const totalDSY = Math.max(0, dsyCount + bonus);

const roll = await new Roll(`${totalDSY}d6 + 1d20`).evaluate();

if (game.dice3d) {
  await game.dice3d.showForRoll(roll, game.user, true);
}

const dieTerms = roll.terms.filter(t => typeof t?.faces === "number" && Array.isArray(t?.results));
const d6Term  = dieTerms.find(t => t.faces === 6);
const d20Term = dieTerms.find(t => t.faces === 20);

const faces = d6Term?.results?.map(r => r.result) ?? [];

const locValue = d20Term?.results?.[0]?.result ?? 0;
const loc = _mcHitLocation(locValue);

// ---- PJ ATTACK: build display data (MISSING BEFORE) ----
const weaponName = wpn.name ?? "Weapon";
const bonusLabel = isMelee ? "MELEE BONUS" : "RANGED BONUS";
// --- Weapon Qualities (resolved) ---
const quuids = Array.isArray(wpn.system?.qualities) ? wpn.system.qualities : [];
const qdocs = await Promise.all(quuids.map(u => fromUuid(u).catch(() => null)));
const attackQualities = qdocs.filter(Boolean).map(d => ({ uuid: d.uuid, name: d.name }));

let dsySuccess = 0;
let effects = 0;

const parts = faces.map((f, i) => {
  const out = this._mapDSY(f);
  dsySuccess += out.s;
  effects += out.e;

  let color = "#777";
  if (f === 1) color = "#ff6600";
  if (f === 2) color = "#00ffcc";
  if (f === 6) color = "#66ff66";

  return `<span class="mc-die" data-die="d6" data-index="${i}" style="cursor:pointer; color:${color}; font-weight:900; font-size:16px;">${f}</span>`;
}).join(" | ");

const total = base + dsySuccess;


                const scope = game.system.id;

        await ChatMessage.create({
          speaker: ChatMessage.getSpeaker({ actor: this.actor }),
          flavor: `<b style="text-transform:uppercase;">${weaponName} — ATTACK</b>`,
          content: `
<div style="background:#1a1a1a;color:white;padding:8px;border:1px solid #ff6600">
  <small>Range: ${range || "-"}. Bonus used: ${bonusLabel} = ${bonus} DSY</small>

  <div style="
    font-size:16px;
    font-weight:900;
    text-decoration:underline;
    text-align:right;
    margin-top:4px;
    color:#ff6600;
  ">
    Hit Location: <span class="mc-die" data-die="d20" data-index="0" style="cursor:pointer;">${loc}</span>
    <span style="opacity:0.75">(${locValue})</span>
  </div>

  <hr style="border-color:#333">
  <div style="margin:6px 0; font-size:16px;">DSY Rolls (${totalDSY}): ${parts || "<span style='color:#777'>none</span>"}</div>

  <div>
    <b>Base:</b> ${base}
    &nbsp; <b>Success:</b> ${dsySuccess}
  </div>

  <div style="font-size:16px; font-weight:900; text-decoration:underline; text-align:right; margin-top:4px; color:#ff6600;">
    Total: ${total}
  </div>

  <button type="button" class="mc-reroll-btn"
    style="display:none; margin-top:8px; background:#ff6600; color:black; border:none; padding:6px 10px; border-radius:6px; font-weight:900; cursor:pointer;">
    REROLL
  </button>

  ${effects > 0 ? `<div style="margin-top:6px;"><b style="color:#66ff66">EFFECT:</b> ${effects}</div>` : ""}
  ${attackQualities?.length ? `
    <div style="margin-top:6px;">
      <b style="color:#ff6600">QUALITIES:</b>
      ${attackQualities.map(q => `
        <a class="mc-quality-tag" data-uuid="${q.uuid}"
           style="display:inline-block; padding:2px 8px; margin:0 4px 4px 0;
                  border:1px solid #ff6600; border-radius:999px; background:#111;
                  color:#ff6600; font-weight:700; font-size:11px; text-decoration:none; cursor:pointer;">
          ${q.name}
        </a>`).join("")}
    </div>` : ""}
</div>`,
          flags: {
            [scope]: {
              mcRoll: {
                kind: "attack",
                weaponName,  // optionnel; pas nécessaire si tu n’affiches pas le nom dans content
                range,
                base,
                bonus,
                bonusLabel,
                totalDSY,
                loc,
                d20: [locValue],
                d6: faces,
                qualities: attackQualities
              }
            }
          }
        });
      });

	}

    // ===============================
    //  SKILL TEST POPUP (d20 count + auto-success via Chronicle Point)
    // ===============================
    async _onRollSkill(event) {
      event.preventDefault();

      const skillKey = event.currentTarget.dataset.skill;
      const skill = this.actor.system.skills[skillKey];

      const tn = (this.actor.system.attributes?.[skill.attribute]?.value || 0) + (skill.expertise || 0);
      const focus = Number(skill.focus || 0);

      const dreadEffect = this.calculatedDreadEffect || 0;
      const compLimit = 20 - dreadEffect;

      const cpPath = "system.chronicle_points.value";
      const cpCurrent = Number(foundry.utils.getProperty(this.actor, cpPath) ?? 0);
      const canUseChronicle = cpCurrent > 0;

      const content = `
      <form>
        <div class="form-group">
          <label>Number of d20s</label>
          <input type="number" name="d20count" value="2" min="1" max="5" step="1" style="width:80px"/>
          <p class="notes">Default is 2. Min 1, max 5.</p>
        </div>

        <hr/>

        <div class="form-group">
          <label style="display:flex; gap:10px; align-items:center;">
            <input type="checkbox" name="autoSuccess" ${canUseChronicle ? "" : "disabled"} />
            Add an Auto-Success d20 with a Chronicle Point
          </label>
          <p class="notes">
            Adds one extra d20 that is always <b>1</b> and spends <b>1</b> Chronicle Point.
            ${canUseChronicle ? "" : "<br/><b style='color:#ff6600'>No Chronicle Points available.</b>"}
          </p>
        </div>
      </form>`;

      const { d20count, autoSuccess } = await new Promise((resolve) => {
        new Dialog({
          title: `Test: ${skillKey.replace(/_/g, " ")}`,
          content,
          buttons: {
            roll: {
              icon: '<i class="fas fa-dice-d20"></i>',
              label: "Roll",
              callback: (html) => {
                const raw = Number(html.find('input[name="d20count"]').val() ?? 2);
                const d20count = Math.clamp(raw, 1, 5);
                const autoSuccess = Boolean(html.find('input[name="autoSuccess"]')[0]?.checked);
                resolve({ d20count, autoSuccess });
              }
            },
            cancel: {
              label: "Cancel",
              callback: () => resolve({ d20count: null, autoSuccess: false })
            }
          },
          default: "roll",
          close: () => resolve({ d20count: null, autoSuccess: false })
        }).render(true);
      });

      if (!d20count) return;

      const dsp = Math.max(0, d20count - 2);
      const useAuto = autoSuccess && canUseChronicle;

      if (useAuto) {
        await this.actor.update({ [cpPath]: Math.max(0, cpCurrent - 1) });
      }

       const roll = await new Roll(`${d20count}d20`).evaluate();
      if (game.dice3d) {
        await game.dice3d.showForRoll(roll, game.user, true);
      }

      let totalS = 0;
      let totalC = 0;

      const d20Faces = roll.terms[0].results.map(r => r.result);

      const rolledDiceHtml = roll.terms[0].results.map((r, i) => {
        let s = 0;
        if (r.result <= tn) s++;
        if (r.result <= focus) s++;
        totalS += s;

        if (r.result >= compLimit) totalC++;

        let color =
          (r.result >= compLimit) ? "red" :
          (s >= 2) ? "#00ffcc" :
          (s === 1) ? "#ff6600" : "white";

        return `<span class="mc-die" data-die="d20" data-index="${i}" style="cursor:pointer; color:${color}; font-weight:900; font-size:16px;">${r.result}</span>`;
      }).join(" | ");

      let autoHtml = "";
      if (useAuto) {
        const fixed = 1;
        let s = 0;
        if (fixed <= tn) s++;
        if (fixed <= focus) s++;
        totalS += s;

        const color = (s >= 2) ? "#00ffcc" : "#ff6600";
        autoHtml = ` | <span style="color:${color}; font-weight:bold">1</span> <span style="color:#999;font-size:11px;">(auto)</span>`;
      }

      const skillLabel = skillKey.replace(/_/g, " ");

const scope = game.system.id;

await ChatMessage.create({
  speaker: ChatMessage.getSpeaker({ actor: this.actor }),
  flavor: `<b>${this.actor.name}</b> — ${skillLabel.toUpperCase()}`,
  content: `
<div style="background:#1a1a1a;color:white;padding:8px;border:1px solid #ff6600">
  <div style="font-size:11px; color:#888;">
    <b>TN:</b> ${tn} &nbsp; <b>Focus:</b> ${focus} &nbsp; <b>Comp:</b> ${compLimit}+
  </div>
  <hr style="border-color:#333">
  <div style="font-size:16px; margin:6px 0;">
    ${rolledDiceHtml}${autoHtml}
  </div>
  <div style="
    font-size:16px;
    font-weight:900;
    text-decoration:underline;
    text-align:right;
    margin-top:4px;
    color:#ff6600;
  ">
    Successes: ${totalS}
  </div>
  ${totalC ? `<div style="margin-top:4px; color:red;"><b>Complications:</b> ${totalC}</div>` : ""}

  <button type="button" class="mc-reroll-btn"
    style="display:none; margin-top:8px; background:#ff6600; color:black; border:none; padding:6px 10px; border-radius:6px; font-weight:900; cursor:pointer;">
    REROLL
  </button>
</div>`,
  flags: {
    [scope]: {
      mcRoll: {
        kind: "skill",
        tn,
        focus,
        compLimit,
        auto: useAuto,      // pour ré-afficher le d20 auto (1) après reroll
        d20: d20Faces
      }
    }
  }
});

    } // end _onRollSkill
  }   // end MutantActorSheet

  //  NPC ACTOR SHEET
  // -------------------------------
  class NpcActorSheet extends ActorSheet {
    static get defaultOptions() {
       return foundry.utils.mergeObject(super.defaultOptions, {
         classes: ["mutant-chronicles-3e", "sheet", "actor", "npc"],
         template: "systems/mutant-chronicles-3e/templates/npc-sheet.html",
         width: 900,
         height: 980,

         
        // Foundry-native tabs
        tabs: [{ navSelector: ".sheet-tabs", contentSelector: ".sheet-body", initial: "stats" }],
         submitOnChange: true,
         closeOnSubmit: false
       });
     }

    // DSY helpers (same as character)
    _mapDSY(face) {
      if (face === 1) return { s: 1, e: 0 };
      if (face === 2) return { s: 2, e: 0 };
      if (face === 6) return { s: 0, e: 1 };
      return { s: 0, e: 0 };
    }

    _parseDamageFormula(str) {
      const s = String(str ?? "").replace(/\s+/g, "").toUpperCase();
      const m = s.match(/^(\d+)\+(\d*)DSY$/);
      if (!m) return null;
      const base = Number(m[1] ?? 0);
      const dsyCount = m[2] === "" ? 1 : Number(m[2]);
      return { base, dsyCount };
    }

     // -------------------------------
     //  NPC SKILL ROLL (2d20-style)
     //  TN = Attribute.value + Expertise
     //  Focus = skill.focus
     //  <= Focus => 2 successes, <= TN => 1 success
     // -------------------------------
     async _rollNpcSkill({ skillKey, attributeKey, diceCount }) {
       const system = this.actor.system;
 
       const attrValue = Number(system.attributes?.[attributeKey]?.value ?? 0);
       const skill = system.skills?.[skillKey];
       if (!skill) return;
 
       const expertise = Number(skill.expertise ?? 0);
       const focus = Number(skill.focus ?? 0);
       const TN = attrValue + expertise;
 
       const dice = Math.max(2, Number(diceCount || 2));
       const roll = await new Roll(`${dice}d20`).evaluate();

if (game.dice3d) {
   await game.dice3d.showForRoll(roll, game.user, true);
 }
 
       let successes = 0;
       const parts = roll.terms[0]?.results?.map(r => {
         const v = r.result;
         let s = 0;
         let color = "#777";
 
         if (v <= focus) { s = 2; color = "#00ffcc"; }
         else if (v <= TN) { s = 1; color = "#ff6600"; }
 
         successes += s;
         return `<span style="color:${color}; font-weight:900">${v}</span>`;
       }).join(" | ") ?? "";
 
       await ChatMessage.create({
         speaker: ChatMessage.getSpeaker({ actor: this.actor }),
         flavor: `<b>${this.actor.name}</b> — ${String(skillKey).toUpperCase()}`,
         content: `
 <div style="background:#1a1a1a;color:white;padding:8px;border:1px solid #ff6600">
   <div><b>Attribute:</b> ${attributeKey} (${attrValue})</div>
   <div><b>Expertise:</b> ${expertise} &nbsp; <b>Focus:</b> ${focus}</div>
   <div><b>TN:</b> ${TN} &nbsp; <b>Dice:</b> ${dice}d20</div>
   <hr style="border-color:#333">
   <div style="font-size:16px; margin:6px 0;">${parts}</div>
   <div><b>Successes:</b> ${successes}</div>
 </div>`
       });
     }

    async getData() {
      const context = super.getData();
      const system = this.actor.system;

      // Grade dropdown
      context.gradeOptions = ["TROOPER", "ELITE", "HORDES & SQUADS", "NEMESIS"];

      // Damage bonus (reuse the same Symmetry logic as character)
      const getSym = (v) => v <= 8 ? 0 : v === 9 ? 1 : v <= 11 ? 2 : v <= 13 ? 3 : v <= 15 ? 4 : 5;
      system.damage_bonus ??= { ranged: { value: 0 }, melee: { value: 0 } };
      if (system.attributes) {
        system.damage_bonus.ranged.value = getSym(system.attributes.awareness?.value ?? 0);
        system.damage_bonus.melee.value  = getSym(system.attributes.strength?.value ?? 0);
      }

      // Qualities (traits) as UUIDs
      const traitUuids = Array.isArray(system.traits) ? system.traits : [];
      const traitDocs = await Promise.all(traitUuids.map(u => fromUuid(u).catch(() => null)));
      context.traitQualities = traitDocs.filter(Boolean).map(d => ({ uuid: d.uuid, name: d.name }));

      // Wounds
      system.wounds ??= { current: 0, total: 1 };

      // Attacks (weapons embedded on actor)
      context.npcWeapons = this.actor.items
        .filter(i => i.type === "weapon")
        .map(w => ({
          id: w.id,
          uuid: w.uuid,
          name: w.name,
          stats: {
            range: w.system?.stats?.range ?? "",
            damage: w.system?.stats?.damage ?? "1+DSY"
          }
        }));

      // Special abilities (talents embedded on actor)
      context.npcTalents = this.actor.items
        .filter(i => i.type === "talent")
        .map(t => ({
          id: t.id,
          uuid: t.uuid,
          name: t.name,
          talentTree: t.system?.talentTree ?? "",
          prerequisite: t.system?.prerequisite ?? "",
          description: t.system?.description ?? ""
        }));

      context.system = system;
      return context;
    }

    activateListeners(html) {
      super.activateListeners(html);

      // Qualities dropzone (head)
      const dzTraits = html.find(".mc-npc-traits-dropzone")[0];
      if (dzTraits) {
        dzTraits.addEventListener("dragover", (ev) => ev.preventDefault());
        dzTraits.addEventListener("drop", async (ev) => {
          ev.preventDefault();

          let data;
          try { data = JSON.parse(ev.dataTransfer.getData("text/plain")); }
          catch (_) { return; }

          const uuid = data?.uuid;
          if (!uuid || data?.type !== "Item") return;

          const doc = await fromUuid(uuid).catch(() => null);
          if (!doc || doc.type !== "quality") {
            ui.notifications.warn("Only Quality items can be added as Tags.");
            return;
          }

          const current = Array.isArray(this.actor.system.traits) ? this.actor.system.traits : [];
          if (current.includes(doc.uuid)) return;
          await this.actor.update({ "system.traits": [...current, doc.uuid] });
        });
      }

      html.find(".mc-trait-pill").on("click", async (ev) => {
        ev.preventDefault();
        const uuid = ev.currentTarget.dataset.uuid;
        const doc = await fromUuid(uuid);
        doc?.sheet?.render(true);
      });

      // Drop WEAPON into ATTACKS
      const dzAttacks = html.find(".mc-npc-attacks-dropzone")[0];
      if (dzAttacks) {
        dzAttacks.addEventListener("dragover", ev => ev.preventDefault());
        dzAttacks.addEventListener("drop", async (ev) => {
          ev.preventDefault();
          ev.stopPropagation();

          let data;
          try { data = JSON.parse(ev.dataTransfer.getData("text/plain")); }
          catch (_) { return; }

          if (data.type !== "Item" || !data.uuid) return;
          const doc = await fromUuid(data.uuid).catch(() => null);
          if (!doc || doc.type !== "weapon") {
            ui.notifications.warn("Only WEAPON can be dropped in ATTACKS.");
            return;
          }
          if (doc.parent?.uuid === this.actor.uuid) return;
          await this.actor.createEmbeddedDocuments("Item", [doc.toObject()]);
        });
      }

      // Drop TALENT into SPECIAL ABILITIES
      const dzAbilities = html.find(".mc-npc-abilities-dropzone")[0];
      if (dzAbilities) {
        dzAbilities.addEventListener("dragover", ev => ev.preventDefault());
        dzAbilities.addEventListener("drop", async (ev) => {
          ev.preventDefault();
          ev.stopPropagation();

          let data;
          try { data = JSON.parse(ev.dataTransfer.getData("text/plain")); }
          catch (_) { return; }

          if (data.type !== "Item" || !data.uuid) return;
          const doc = await fromUuid(data.uuid).catch(() => null);
          if (!doc || doc.type !== "talent") {
            ui.notifications.warn("Only TALENT can be dropped in SPECIAL ABILITIES.");
            return;
          }
          if (doc.parent?.uuid === this.actor.uuid) return;
          await this.actor.createEmbeddedDocuments("Item", [doc.toObject()]);
        });
      }

      // Standard buttons (edit / delete / chat)
      html.find(".mc-item-edit").on("click", (ev) => {
        ev.preventDefault();
        const id = ev.currentTarget.dataset.itemId;
        this.actor.items.get(id)?.sheet?.render(true);
      });

      html.find(".mc-item-delete").on("click", async (ev) => {
        ev.preventDefault();
        const id = ev.currentTarget.dataset.itemId;
        if (!id) return;
        await this.actor.deleteEmbeddedDocuments("Item", [id]);
      });

      html.find(".mc-item-chat").on("click", async (ev) => {
        ev.preventDefault();
        const id = ev.currentTarget.dataset.itemId;
        const item = this.actor.items.get(id);
        if (!item) return;
        const content = await TextEditor.enrichHTML(item.system?.description ?? "", { async: true });
        await ChatMessage.create({
          speaker: ChatMessage.getSpeaker({ actor: this.actor }),
          flavor: `<b>${item.name}</b>`,
          content
        });
      });

      // ATTACK! (same logic as character weapon attack)
      html.find(".mc-weapon-attack").on("click", async (ev) => {
        ev.preventDefault();
        const weaponId = ev.currentTarget.dataset.weaponId;
        const wpn = this.actor.items.get(weaponId);
        if (!wpn) return;

        const range = String(wpn.system?.stats?.range ?? "").toUpperCase();
        const isMelee = (range === "REACH");

        const bonus = Number(
          isMelee
            ? (this.actor.system?.damage_bonus?.melee?.value ?? 0)
            : (this.actor.system?.damage_bonus?.ranged?.value ?? 0)
        );

        const dmgStr = wpn.system?.stats?.damage ?? "1+DSY";
        const parsed = this._parseDamageFormula(dmgStr);
        if (!parsed) {
          ui.notifications.warn('Damage must be in the format "X+DSY" or "X+2DSY".');
          return;
        }

        const { base, dsyCount } = parsed;
        const totalDSY = Math.max(0, dsyCount + bonus);
 // DSY + Hit Location in ONE roll so Dice So Nice shows them together
        const roll = await new Roll(`${totalDSY}d6 + 1d20`).evaluate();
        if (game.dice3d) {
          await game.dice3d.showForRoll(roll, game.user, true);
        }

 // Extract dice results
        const dieTerms = roll.terms.filter(t => typeof t?.faces === "number" && Array.isArray(t?.results));
        const d6Term  = dieTerms.find(t => t.faces === 6);
        const d20Term = dieTerms.find(t => t.faces === 20);

        const faces = d6Term?.results?.map(r => r.result) ?? [];
        let dsySuccess = 0;
        let effects = 0;

const parts = faces.map((f, i) => {
  const out = this._mapDSY(f);
  dsySuccess += out.s;
  effects += out.e;

  let color = "#777";
  if (f === 1) color = "#ff6600";
  if (f === 2) color = "#00ffcc";
  if (f === 6) color = "#66ff66";

  return `<span class="mc-die" data-die="d6" data-index="${i}" style="cursor:pointer; color:${color}; font-weight:900; font-size:16px;">${f}</span>`;
}).join(" | ");


        const total = base + dsySuccess;
        const weaponName = wpn.name ?? "Weapon";
        const bonusLabel = isMelee ? "MELEE BONUS" : "RANGED BONUS";
        // --- Weapon Qualities (resolved) ---
        const quuids = Array.isArray(wpn.system?.qualities) ? wpn.system.qualities : [];
        const qdocs = await Promise.all(quuids.map(u => fromUuid(u).catch(() => null)));
        const attackQualities = qdocs.filter(Boolean).map(d => ({ uuid: d.uuid, name: d.name }));
		
// Hit Location (from the 1d20 term of the combined roll)
const locValue = d20Term?.results?.[0]?.result ?? 0;
const loc = _mcHitLocation(locValue);


        const scope = game.system.id;

        await ChatMessage.create({
          speaker: ChatMessage.getSpeaker({ actor: this.actor }),
          flavor: `<b style="text-transform:uppercase;">${weaponName} — ATTACK</b>`,
          content: `
<div style="background:#1a1a1a;color:white;padding:8px;border:1px solid #ff6600">
  <small>Range: ${range || "-"}. Bonus used: ${bonusLabel} = ${bonus} DSY</small>
  <div style="
    font-size:16px;
    font-weight:900;
    text-decoration:underline;
    text-align:right;
    margin-top:4px;
    color:#ff6600;
  ">
    Hit Location: <span class="mc-die" data-die="d20" data-index="0" style="cursor:pointer;">${loc}</span>
    <span style="opacity:0.75">(${locValue})</span>
  </div>

  <hr style="border-color:#333">
  <div style="margin:6px 0; font-size:16px;">DSY Rolls (${totalDSY}): ${parts || "<span style='color:#777'>none</span>"}</div>
  <div><b>Base:</b> ${base} &nbsp; <b>Success:</b> ${dsySuccess}</div>

  <div style="font-size:16px; font-weight:900; text-decoration:underline; text-align:right; margin-top:4px; color:#ff6600;">
    Total: ${total}
  </div>

  <button type="button" class="mc-reroll-btn"
    style="display:none; margin-top:8px; background:#ff6600; color:black; border:none; padding:6px 10px; border-radius:6px; font-weight:900; cursor:pointer;">
    REROLL
  </button>

  ${effects > 0 ? `<div style="margin-top:6px;"><b style="color:#66ff66">EFFECT:</b> ${effects}</div>` : ""}
  ${attackQualities?.length ? `
    <div style="margin-top:6px;">
      <b style="color:#ff6600">QUALITIES:</b>
      ${attackQualities.map(q => `
        <a class="mc-quality-tag" data-uuid="${q.uuid}"
           style="display:inline-block; padding:2px 8px; margin:0 4px 4px 0;
                  border:1px solid #ff6600; border-radius:999px; background:#111;
                  color:#ff6600; font-weight:700; font-size:11px; text-decoration:none; cursor:pointer;">
          ${q.name}
        </a>`).join("")}
    </div>` : ""}
</div>`,
          flags: {
            [scope]: {
              mcRoll: {
                kind: "attack",
                weaponName,
                range,
                base,
                bonus,
                bonusLabel,
                totalDSY,
                loc,
                d20: [locValue],
                d6: faces,
                qualities: attackQualities
              }
            }
          }
        });
      });
	  
       // -------------------------------
       //  NPC SKILL ROLLS (click field -> choose attribute + d20)
       // -------------------------------
       html.find(".mc-npc-skill-roll").on("click", async (ev) => {
         ev.preventDefault();
 
         const skillKey = ev.currentTarget.dataset.skill;
         const attributes = Object.keys(this.actor.system.attributes ?? {});
 
         const content = `
 <form>
   <div class="form-group">
     <label>Attribute</label>
     <select name="attribute" style="width:100%;">
       ${attributes.map(a => `<option value="${a}">${a}</option>`).join("")}
     </select>
   </div>
   <div class="form-group">
     <label>Number of d20</label>
     <input name="dice" type="number" value="2" min="2" style="width:100%;">
   </div>
 </form>`;
 
         new Dialog({
           title: `Roll ${String(skillKey).toUpperCase()}`,
           content,
           buttons: {
             roll: {
               label: "Roll",
               callback: (dlgHtml) => {
                 const attributeKey = dlgHtml.find('[name="attribute"]').val();
                 const diceCount = dlgHtml.find('[name="dice"]').val();
                 this._rollNpcSkill({ skillKey, attributeKey, diceCount });
               }
             },
             cancel: { label: "Cancel" }
           },
           default: "roll"
         }).render(true);
       });
    }
  }

  Actors.unregisterSheet("core", ActorSheet);
  Actors.registerSheet("mutant", MutantActorSheet, { types: ["character"], makeDefault: true });
  Actors.registerSheet("mutant", NpcActorSheet,   { types: ["npc"],       makeDefault: true });
});
// ===============================
//  DICE SO NICE – Dark Symmetry Dice (D6)
// ===============================
Hooks.once("diceSoNiceReady", (dice3d) => {

  dice3d.addSystem(
    { id: "mutant-chronicles-3e", name: "Mutant Chronicles 3e" },
    true
  );

  const base = "systems/mutant-chronicles-3e/assets/dice/dsy";

  dice3d.addDicePreset({
    type: "d6",
    labels: [
      `${base}/MCDice1.jpg`,      // face 1
      `${base}/MCDice2.jpg`,      // face 2
      `${base}/MCDiceBlank.jpg`,  // face 3
      `${base}/MCDiceBlank.jpg`,  // face 4
      `${base}/MCDiceBlank.jpg`,  // face 5
      `${base}/MCDice6.jpg`       // face 6
    ],
    system: "mutant-chronicles-3e"
  });

});

// --------------------------------------------
// Interactive reroll on our custom roll cards
// --------------------------------------------
Hooks.on("renderChatMessage", (message, html) => {
  const scope = game.system.id;
  const data = message.getFlag(scope, "mcRoll");
  if (!data) return;

  // Only bind once per render
  const $root = html;

  // Click die => toggle selection
  $root.find(".mc-die").on("click", (ev) => {
    const el = ev.currentTarget;
    el.classList.toggle("mc-selected");

    const any = $root.find(".mc-die.mc-selected").length > 0;
    $root.find(".mc-reroll-btn").toggle(any);
  });
  // Click QUALITY tag => open its sheet
  $root.find(".mc-quality-tag").on("click", async (ev) => {
    ev.preventDefault();
    const uuid = ev.currentTarget?.dataset?.uuid;
    if (!uuid) return;
    const doc = await fromUuid(uuid).catch(() => null);
    doc?.sheet?.render(true);
  });

  // Reroll selected
  $root.find(".mc-reroll-btn").on("click", async (ev) => {
    ev.preventDefault();

    const selected = $root.find(".mc-die.mc-selected").toArray().map(el => ({
      die: el.dataset.die,               // "d20" or "d6"
      index: Number(el.dataset.index)    // 0-based
    }));

    if (!selected.length) return;

    // Split by die type
    const sel20 = selected.filter(s => s.die === "d20").sort((a,b)=>a.index-b.index);
    const sel6  = selected.filter(s => s.die === "d6").sort((a,b)=>a.index-b.index);

    // Build reroll results
    let newD20 = [];
    let newD6 = [];

    if (sel20.length) {
      const r20 = await new Roll(`${sel20.length}d20`).evaluate();
      if (game.dice3d) await game.dice3d.showForRoll(r20, game.user, true);
      const t20 = r20.terms.find(t => t?.faces === 20);
      newD20 = (t20?.results ?? []).map(r => r.result);
    }

    if (sel6.length) {
      const r6 = await new Roll(`${sel6.length}d6`).evaluate();
      if (game.dice3d) await game.dice3d.showForRoll(r6, game.user, true);
      const t6 = r6.terms.find(t => t?.faces === 6);
      newD6 = (t6?.results ?? []).map(r => r.result);
    }

    // Apply to stored roll data
const updated = foundry.utils.duplicate(data);

// 1) Push previous snapshot into history
updated.history = Array.isArray(updated.history) ? updated.history : [];
updated.history.unshift({
  at: Date.now(),
  d20: Array.isArray(updated.d20) ? [...updated.d20] : [],
  d6:  Array.isArray(updated.d6)  ? [...updated.d6]  : [],
  note: "Rerolled"
});

// (optionnel) limiter la taille de l’historique
updated.history = updated.history.slice(0, 10);

// 2) Apply replacements to current values
for (let i = 0; i < sel20.length; i++) {
  const idx = sel20[i].index;
  if (updated.d20 && idx >= 0 && idx < updated.d20.length) updated.d20[idx] = newD20[i];
}
for (let i = 0; i < sel6.length; i++) {
  const idx = sel6[i].index;
  if (updated.d6 && idx >= 0 && idx < updated.d6.length) updated.d6[idx] = newD6[i];
}

// 3) Re-render
const newContent = _mcRenderRollCard(updated);
await message.update({
  content: newContent,
  [`flags.${scope}.mcRoll`]: updated
});

  });
});

// Helper: render HTML from stored roll data
function _mcRenderRollCard(d) {
  // d.kind: "skill" | "attack"
  // d.d20: number[] (optional)
  // d.d6: number[] (optional)
  // d.tn, d.focus, etc depending on kind
  // IMPORTANT: keep this in sync with your existing card layout.

if (d.kind === "skill") {
  const tn = d.tn ?? 0;
  const focus = d.focus ?? 0;
  const compLimit = d.compLimit ?? 20;

  let totalS = 0;
  let totalC = 0;

  const rolledDiceHtml = (d.d20 ?? []).map((v, i) => {
    let s = 0;
    if (v <= tn) s++;
    if (v <= focus) s++;
    totalS += s;

    if (v >= compLimit) totalC++;

    let color =
      (v >= compLimit) ? "red" :
      (s >= 2) ? "#00ffcc" :
      (s === 1) ? "#ff6600" :
      "white";

    return `<span class="mc-die" data-die="d20" data-index="${i}" style="cursor:pointer; color:${color}; font-weight:900; font-size:16px;">${v}</span>`;
  }).join(" | ");

  // Auto die (always 1) — re-added after reroll if used
  let autoHtml = "";
  if (d.auto) {
    const fixed = 1;
    let s = 0;
    if (fixed <= tn) s++;
    if (fixed <= focus) s++;
    totalS += s;

    const color = (s >= 2) ? "#00ffcc" : "#ff6600";
    autoHtml = ` | <span style="color:${color}; font-weight:bold">1</span> <span style="color:#999;font-size:11px;">(auto)</span>`;
  }

  // History
  const history = Array.isArray(d.history) ? d.history : [];
  const historyHtml = history.length ? `
    <div style="margin-top:10px; padding-top:8px; border-top:1px solid #333;">
      ${history.map(h => {
        const diceLine = (h.d20 ?? []).map(v => {
          let s = 0;
          if (v <= tn) s++;
          if (v <= focus) s++;

          let color =
            (v >= compLimit) ? "red" :
            (s >= 2) ? "#00ffcc" :
            (s === 1) ? "#ff6600" :
            "#aaa";

          return `<span style="color:${color}; font-weight:900; font-size:12px;">${v}</span>`;
        }).join(" | ");

        const note = h.note ?? "Rerolled";
        return `
          <div style="margin-bottom:6px;">
            <div style="font-size:12px; color:#aaa;">${diceLine}</div>
            <div style="font-size:10px; color:#666;">${note}</div>
          </div>`;
      }).join("")}
    </div>
  ` : "";

  return `
<div style="background:#1a1a1a;color:white;padding:8px;border:1px solid #ff6600">
  <div style="font-size:11px; color:#888;">
    <b>TN:</b> ${tn} &nbsp; <b>Focus:</b> ${focus} &nbsp; <b>Comp:</b> ${compLimit}+
  </div>
  <hr style="border-color:#333">
  <div style="font-size:16px; margin:6px 0;">
    ${rolledDiceHtml}${autoHtml}
  </div>
  <div style="
    font-size:16px;
    font-weight:900;
    text-decoration:underline;
    text-align:right;
    margin-top:4px;
    color:#ff6600;
  ">
    Successes: ${totalS}
  </div>
  ${totalC ? `<div style="margin-top:4px; color:red;"><b>Complications:</b> ${totalC}</div>` : ""}

  ${historyHtml}

  <button type="button" class="mc-reroll-btn"
    style="display:none; margin-top:8px; background:#ff6600; color:black; border:none; padding:6px 10px; border-radius:6px; font-weight:900; cursor:pointer;">
    REROLL
  </button>
</div>`;
}

  // Attack: you already have base, bonus, range, loc, etc.
  // Here we only show a minimal example; you’ll map your existing fields.
if (d.kind === "attack") {
  const d6 = Array.isArray(d.d6) ? d.d6 : [];
  const d20 = Array.isArray(d.d20) ? d.d20 : [];

  const range = d.range ?? "";
  const base = Number(d.base ?? 0);
  const bonusLabel = d.bonusLabel ?? "";
  const bonus = Number(d.bonus ?? 0);
  const totalDSY = Number(d.totalDSY ?? d6.length);

  const locValue = d20[0] ?? 0;
  const loc = d.loc ?? "";

  // Qualities (stored as [{uuid,name}] in flags)
  const qualities = Array.isArray(d.qualities) ? d.qualities : [];
  const qualitiesHtml = qualities.length
    ? `<div style="margin-top:6px;">
         <b style="color:#ff6600">QUALITIES:</b>
         ${qualities.map(q => `
           <a class="mc-quality-tag" data-uuid="${q.uuid}"
              style="display:inline-block; padding:2px 8px; margin:0 4px 4px 0;
                     border:1px solid #ff6600; border-radius:999px; background:#111;
                     color:#ff6600; font-weight:700; font-size:11px; text-decoration:none; cursor:pointer;">
             ${q.name}
           </a>`).join("")}
       </div>`
    : "";

  // DSY mapping (same as your system)
  const mapDSY = (face) => {
    if (face === 1) return { s: 1, e: 0 };
    if (face === 2) return { s: 2, e: 0 };
    if (face === 6) return { s: 0, e: 1 };
    return { s: 0, e: 0 };
  };

  let dsySuccess = 0;
  let effects = 0;

  const parts = d6.map((f, i) => {
    const out = mapDSY(f);
    dsySuccess += out.s;
    effects += out.e;

    let color = "#777";
    if (f === 1) color = "#ff6600";
    if (f === 2) color = "#00ffcc";
    if (f === 6) color = "#66ff66";

    return `<span class="mc-die" data-die="d6" data-index="${i}" style="cursor:pointer; color:${color}; font-weight:900; font-size:16px;">${f}</span>`;
  }).join(" | ");

  const total = base + dsySuccess;

  // History
  const history = Array.isArray(d.history) ? d.history : [];
  const historyHtml = history.length ? `
    <div style="margin-top:10px; padding-top:8px; border-top:1px solid #333;">
      ${history.map(h => {
        const diceLine = (h.d6 ?? []).map(v => {
          let color = "#aaa";
          if (v === 1) color = "#ff6600";
          if (v === 2) color = "#00ffcc";
          if (v === 6) color = "#66ff66";
          return `<span style="color:${color}; font-weight:900; font-size:12px;">${v}</span>`;
        }).join(" | ");

        const hLoc = (Array.isArray(h.d20) ? h.d20[0] : 0) ?? 0;
        const note = h.note ?? "Rerolled";

        return `
          <div style="margin-bottom:6px;">
            <div style="font-size:12px; color:#aaa;">${diceLine}</div>
            <div style="font-size:10px; color:#666;">${note} (loc ${hLoc})</div>
          </div>`;
      }).join("")}
    </div>
  ` : "";

  return `
<div style="background:#1a1a1a;color:white;padding:8px;border:1px solid #ff6600">
  <small>Range: ${range || "-"}. Bonus used: ${bonusLabel} = ${bonus} DSY</small>

  <div style="
    font-size:16px;
    font-weight:900;
    text-decoration:underline;
    text-align:right;
    margin-top:4px;
    color:#ff6600;
  ">
    Hit Location: <span class="mc-die" data-die="d20" data-index="0" style="cursor:pointer;">${loc}</span>
    <span style="opacity:0.75">(${locValue})</span>
  </div>

  <hr style="border-color:#333">
  <div style="margin:6px 0; font-size:16px;">DSY Rolls (${totalDSY}): ${parts || "<span style='color:#777'>none</span>"}</div>

  <div>
    <b>Base:</b> ${base}
    &nbsp; <b>Success:</b> ${dsySuccess}
  </div>

  <div style="font-size:16px; font-weight:900; text-decoration:underline; text-align:right; margin-top:4px; color:#ff6600;">
    Total: ${total}
  </div>

  ${effects > 0 ? `<div style="margin-top:6px;"><b style="color:#66ff66">EFFECT:</b> ${effects}</div>` : ""}
  ${qualitiesHtml}

  ${historyHtml}

  <button type="button" class="mc-reroll-btn"
    style="display:none; margin-top:8px; background:#ff6600; color:black; border:none; padding:6px 10px; border-radius:6px; font-weight:900; cursor:pointer;">
    REROLL
  </button>
</div>`;
}

  return `<div>Unknown roll card</div>`;
}


