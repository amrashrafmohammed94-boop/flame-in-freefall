/* Fire risk check: location → atmosphere, material → family/state, then a data-based risk assessment */
(() => {
const D = window.DATA, $ = s => document.querySelector(s);
const esc = s => String(s ?? '').replace(/[&<>"]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));
const PSI_PER_ATM = 14.696;
const LEVELS = ['Low', 'Medium', 'High'];

/* ---------- step 1: location ---------- */
$('#loc').innerHTML = '<option value="">Select your location…</option>' + D.locations.map(l => `<option value="${l.id}">${esc(l.name)}</option>`).join('');
function currentEnv() {
  const l = D.locations.find(x => x.id === $('#loc').value);
  if (!l) return null;
  if (l.id === 'custom') {
    const psi = +$('#cPsi').value, o2 = Math.min(1, Math.max(0, +$('#cO2').value / 100));
    return {...l, psi, o2, n2: Math.max(0, 1 - o2), gravity: $('#cG').value, g: $('#cG').value === 'micro' ? '≈0 g' : 'partial'};
  }
  return l;
}
function renderEnv() {
  const e = currentEnv();
  $('#customBox').hidden = $('#loc').value !== 'custom';
  if (!e) { $('#locAtm').innerHTML = ''; return update(); }
  const atm = e.psi / PSI_PER_ATM;
  $('#locAtm').innerHTML = `
    <div><span>Pressure</span><b>${e.psi.toFixed(1)}</b> psi<small>${atm.toFixed(2)} atm</small></div>
    <div><span>Oxygen</span><b>${(e.o2 * 100).toFixed(1)}%</b><small>${(e.psi * e.o2).toFixed(1)} psi to breathe</small></div>
    <div><span>Nitrogen</span><b>${(e.n2 * 100).toFixed(1)}%</b><small>${(e.psi * e.n2).toFixed(1)} psi around a flame</small></div>
    <div><span>Gravity</span><b>${esc(e.g)}</b><small>${esc(e.status)}</small></div>`;
  update();
}
['#loc', '#cPsi', '#cO2', '#cG'].forEach(s => $(s).addEventListener('input', renderEnv));

/* ---------- step 2: material ---------- */
$('#matList').innerHTML = D.materials.map(m => `<option value="${esc(m.name)}">${esc(m.family)}</option>`).join('') +
  D.materials.flatMap(m => m.aliases.map(a => `<option value="${esc(a)}">${esc(m.name)} · ${esc(m.family)}</option>`)).join('');
function findMaterial(q) {
  q = q.trim().toLowerCase();
  if (!q) return null;
  return D.materials.find(m => m.name.toLowerCase() === q || m.aliases.some(a => a.toLowerCase() === q)) ||
         D.materials.find(m => m.name.toLowerCase().includes(q) || m.aliases.some(a => a.toLowerCase().includes(q))) || null;
}
let lastMat = null;
$('#mat').addEventListener('input', () => {
  const m = findMaterial($('#mat').value);
  if (m) {
    $('#matFamily').innerHTML = `<span class="pill">${esc(m.family)}</span> matched <b>${esc(m.name)}</b> · NASA data: ${esc(m.source)}`;
    if (m !== lastMat) { const r = document.querySelector(`input[name=state][value=${m.state}]`); if (r) r.checked = true; }
  } else {
    $('#matFamily').innerHTML = $('#mat').value.trim() ? '<span class="pill gap">Unknown family</span> Not in the NASA test list – the assessment will be conservative.' : '';
  }
  lastMat = m;
  update();
});
document.querySelectorAll('input[name=state]').forEach(r => r.addEventListener('change', update));
const state = () => (document.querySelector('input[name=state]:checked') || {}).value;

/* ---------- step 3: confirm ---------- */
function update() {
  const e = currentEnv(), name = $('#mat').value.trim(), st = state();
  const ok = e && name && st;
  $('#go').disabled = !ok;
  $('#confirmText').innerHTML = ok
    ? `<b>${esc(name)}</b> (${st}) in the <b>${esc(e.name)}</b>: ${e.psi.toFixed(1)} psi, ${(e.o2 * 100).toFixed(1)}% O₂, ${esc(e.g)}. Is this correct?`
    : 'Choose a location, a material and its state.';
  $('#result').hidden = true;
}
$('#go').addEventListener('click', () => {
  const r = assess(currentEnv(), findMaterial($('#mat').value), $('#mat').value.trim(), state());
  renderResult(r);
});

/* ---------- prediction engines ---------- */
// Liquids: nearest NASA FLEX tests (same fuel class, same diluent) by oxygen and pressure
function knnFlex(o2, atm, fuel, diluent, k = 15) {
  const pool = D.flex.filter(t => t.Fuel === fuel && t.Diluent === diluent && t.Pressure_atm > 0);
  if (!pool.length) return null;
  const near = pool.map(t => ({t, d: Math.hypot((t.O2_frac - o2) / 0.03, (t.Pressure_atm - atm) / 0.3)}))
    .sort((a, b) => a.d - b.d).slice(0, Math.min(k, pool.length));
  const ext = near.filter(x => x.t.Test_end === 'Extinction').length;
  const times = near.map(x => x.t.Burn_time_s).filter(v => v != null).sort((a, b) => a - b);
  return {n: near.length, ext, p: ext / near.length, medTime: times.length ? times[Math.floor(times.length / 2)] : null,
    maxTime: times.length ? times.at(-1) : null, meanDist: near.reduce((s, x) => s + x.d, 0) / near.length,
    o2Range: [Math.min(...near.map(x => x.t.O2_frac)), Math.max(...near.map(x => x.t.O2_frac))],
    pRange: [Math.min(...near.map(x => x.t.Pressure_atm)), Math.max(...near.map(x => x.t.Pressure_atm))]};
}
// Gases: CFI-G normal-flame results, interpolated in oxygen, nearest pressure band
function gasModel(o2, bar) {
  const rows = D.gasbins.rows, pb = bar < 0.75 ? 0.5 : bar < 1.75 ? 1.0 : 2.5;
  const lo = rows.find(r => r.o2 === 0.21 && r.p === pb), hi = rows.find(r => r.o2 === 0.365 && r.p === pb);
  const f = Math.min(1, Math.max(0, (o2 - 0.21) / (0.365 - 0.21)));
  const pLo = lo.se / (lo.se + lo.ft), pHi = hi.se / (hi.se + hi.ft);
  return {p: pLo + f * (pHi - pLo), med: Math.round(lo.med + f * (hi.med - lo.med)), max: Math.round(lo.max + f * (hi.max - lo.max)),
    n: f < 0.5 ? lo.ign : hi.ign, band: pb};
}

/* ---------- assessment ---------- */
function assess(e, m, typed, st) {
  const atm = e.psi / PSI_PER_ATM, bar = atm * 1.01325, o2 = e.o2;
  const reasons = [], evidence = [], flags = [];
  let base, pExt = null, time = '', gasAdvice = null;

  if (st === 'liquid') {
    const fuel = m && m.model === 'Methanol' ? 'Methanol' : 'Heptane';
    if (!m) reasons.push('Unknown liquid: assessed as a hydrocarbon fuel (heptane), the more persistent of the two FLEX fuels.');
    const r = knnFlex(o2, atm, fuel, 'N2 only');
    pExt = r.p;
    evidence.push(`${r.n} most similar NASA FLEX droplet tests (${fuel}, N₂ air, O₂ ${(r.o2Range[0]*100).toFixed(0)}–${(r.o2Range[1]*100).toFixed(0)}%, ${r.pRange[0].toFixed(1)}–${r.pRange[1].toFixed(1)} atm): ${r.ext} of ${r.n} went out by themselves.`);
    time = r.medTime != null ? `Median ${r.medTime.toFixed(1)} s, up to ${r.maxTime.toFixed(1)} s, for a ~2–4 mm droplet. A spill burns much longer.` : '';
    if (o2 < 0.12 || o2 > 0.34 || atm < 0.69 || atm > 3.05) flags.push(`Outside the FLEX test range (O₂ 12–34%, 0.7–3 atm).`);
    // which extinguishing gas worked best in similar tests
    gasAdvice = ['CO2', 'He'].map(dl => ({dl, r: knnFlex(o2, atm, fuel, dl, 10)})).filter(x => x.r && x.r.meanDist < 1.5)
      .map(x => ({gas: x.dl === 'CO2' ? 'CO₂' : 'Helium', p: x.r.p, n: x.r.n}));
  } else if (st === 'gas') {
    const r = gasModel(o2, bar);
    pExt = r.p;
    evidence.push(`NASA CFI-G gas-flame tests at ~${r.band} bar, interpolated to ${(o2*100).toFixed(0)}% O₂: about ${Math.round(r.p*100)}% of ignited flames went out by themselves; the rest were still burning when the gas supply was cut.`);
    time = `Median ${r.med} s, up to ${r.max} s, while gas keeps flowing. A gas fire lasts until the leak is stopped.`;
    if (o2 > 0.40 || o2 < 0.18) flags.push('Outside the CFI-G normal-flame range (O₂ 18–40%).');
    if (o2 > 0.6 && bar < 0.8) evidence.push(D.gasbins.inverse_note);
    if (!m) reasons.push('Unknown gas: assessed with the hydrocarbon gas results (ethane, propane, butane).');
  } else {
    const cls = m ? m.solid : 'unknown';
    const map = {spreads: [0.2, 'Medium'], slow: [0.35, 'Medium'], nospread: [0.85, 'Low'], smoke: [0.6, 'Low'], unknown: [0.3, 'Medium']};
    pExt = map[cls][0];
    base = map[cls][1];
    if (m) evidence.push(`${m.name}: ${m.note} (${m.source})`); else reasons.push('Unknown solid: not tested by NASA, assumed to spread like cotton fabric.');
    evidence.push('All NASA solid-material fire tests were run at ~21–22% O₂ and ~1 atm (Saffire, BASS, BASS-II).');
    time = cls === 'spreads' ? 'Saffire: a 29 cm strip burned out in 115–145 s; a 94 cm sheet burned 70 s (air against the flame) to 420 s (air with the flame).'
      : cls === 'slow' ? 'Saffire-II: PMMA kept burning slowly for 600–900 s, flame anchored at its base.'
      : cls === 'nospread' ? 'Saffire-II: did not spread after ignition at ~22% O₂.'
      : cls === 'smoke' ? 'Tested by overheating (smoke), not by open flame.' : 'No NASA timing data.';
    if (o2 > 0.23 || atm < 0.9) flags.push('No NASA solid-material fire data at this oxygen level or pressure; FLEX and CFI-G show flames persist longer at higher O₂.');
    if (cls === 'smoke') reasons.push('Main hazard is smoke and toxic gases from overheating (SAME/SAME-R).');
  }

  if (base == null) base = pExt >= 0.7 ? 'Low' : pExt >= 0.3 ? 'Medium' : 'High';
  reasons.unshift(`Predicted chance the fire goes out by itself: ${Math.round(pExt * 100)}% → base risk ${base}.`);
  if (e.gravity === 'partial') flags.push(`Partial gravity (${e.g}): NASA has no fire data yet (LUCI and FM2 planned). Partial gravity may feed a flame more than microgravity.`);
  if (e.o2 >= 0.99) flags.push('Pure oxygen (spacesuit / Apollo 1 conditions): no microgravity data; most materials burn readily.');
  let level = LEVELS.indexOf(base);
  if (flags.length) { level = Math.min(2, level + 1); reasons.push('Raised one level because the conditions are not covered by NASA data (precaution).'); }
  if (e.o2 >= 0.99) level = 2;
  return {e, m, typed, st, pExt, basis: st === 'solid' ? 'estimate from how this material class behaved in Saffire' : 'from similar NASA tests', level: LEVELS[level], reasons, flags, evidence, time, gasAdvice, o2, atm};
}

/* ---------- safety actions linked to the risk level ----------
   Based on the ISS fire response "Warn – Gather – Work" (NASA, Emergency Ops History, SpaceOps 2023)
   plus what the PSI data shows. Nobody can simply "leave" a spacecraft: the last resort is to
   isolate the module and retreat towards the safe haven / return vehicle. */
function refuge(e) {
  return {iss: 'the modules next to your docked return vehicle (Soyuz / Crew Dragon); never close a hatch between you and it',
    cygnus: 'the ISS side of the hatch; keep the path to your return vehicle open',
    lander: 'the lander ascent cabin or the base safe-haven module',
    moon: 'the base safe-haven module (separate air supply) or the docked lander',
    rover: 'your spacesuit: suit up first, the suit is the safe haven inside a rover',
    mars: 'the habitat safe-haven module (separate air supply)',
    suit: 'n/a', custom: 'the nearest module you can seal off, with the path to your return vehicle open'}[e.id] || 'the nearest sealed safe module';
}
function actions(r) {
  const e = r.e, lowO2 = r.o2 <= 0.245, S = [];
  const src = r.st === 'gas' ? 'Close the gas valve / isolate the line: in CFI-G every persistent flame burned until the gas flow was cut.'
    : r.st === 'liquid' ? 'Cap the container and remove power from nearby heaters; free droplets keep burning as floating spheres.'
    : 'Remove power from the item or rack: heat source off is the first ISS response step.';
  const enclosed = r.st !== 'solid' || (r.m && ['smoke', 'unknown'].includes(r.m.solid));
  const agent = 'CO₂ extinguisher for fires inside a rack or equipment (wear the breathing apparatus while discharging CO₂); water-mist extinguisher for open-cabin fires and lithium-battery fires (ISS practice).' +
    (lowO2 ? (r.gasAdvice && r.gasAdvice.length ? ` FLEX at this O₂: ${r.gasAdvice.map(g => `${g.gas} ${Math.round(g.p * 100)}% self-extinction`).join(', ')} vs ${Math.round(r.pExt * 100)}% in plain air.` : ' FLEX: CO₂ improved self-extinction up to 24% O₂.')
           : ' Above 25% O₂, CO₂ alone stopped 0 of 6 FLEX flames: always combine it with oxygen and air-flow isolation.');
  if (e.id === 'suit') {
    return {steps: [['Prevention is the only defence', 'Inside a 100% O₂ suit there is no way to fight a fire: no ignition sources, no unapproved materials, no grease or oil near O₂ fittings.'],
      ['Approve every material at 100% O₂', 'NASA has no microgravity fire data at suit conditions; treat any flammable material as High risk.']], ideas: []};
  }
  S.push(['1 · WARN: raise the fire alarm', 'Press the alarm or call it out; on the ISS a smoke alarm also stops the fans, the gas feeds and oxygen generation automatically.']);
  S.push(['2 · Confirm air flow is stopped', `Ventilation fans and O₂ supply OFF in this module. Saffire-I: air flowing with the flame made it burn 6× longer (420 s vs 70 s).`]);
  if (r.level !== 'Low') S.push(['3 · GATHER at the safe point', `Crew meet at ${refuge(e)}. Bring the handheld combustion-products analyser to monitor the air.`]);
  S.push([`${r.level === 'Low' ? '3' : '4'} · WORK step 1: isolate the source`, src]);
  if (r.level !== 'Low') {
    S.push(['5 · Protect breathing', 'Respirator with fire cartridge for work near the fire; the oxygen breathing apparatus only to move away or when using CO₂ (it adds O₂ near the fire).']);
    S.push(['6 · WORK step 2: extinguish', agent]);
  } else S.push(['4 · Keep an extinguisher in hand', agent]);
  if (r.level === 'High') {
    S.push(['7 · WORK step 3: power down the module', 'Partial, then full power-down of the module if the fire continues (ISS escalation order).']);
    S.push(['8 · Last resort: isolate and retreat', `Leave the module, close its hatch, and stay at ${refuge(e)}. The module is sealed off and its air is cleaned later.`]);
  }
  S.push([r.level === 'High' ? '9 · After the fire: clean and check the air' : `${S.length + 1} · After: check the air`, 'Measure CO and CO₂ with the analyser before working without protection; run scrubber cartridges and portable fans in the isolated volume.']);
  if (r.st === 'solid' && r.m && r.m.solid === 'smoke') S.push(['Toxic smoke', `${r.m.name} gives off harmful smoke when overheated: respirator on before approaching.`]);

  // New ideas (concepts for high-O2 habitats; not current NASA procedure)
  const I = [];
  if (r.o2 > 0.245) {
    const dP = e.psi * (r.o2 / 0.21 - 1), pf = e.psi + dP;
    I.push(['Nitrogen "knock-down" of the fire zone', `On alarm, flood the sealed module with stored N₂ to bring O₂ from ${(r.o2 * 100).toFixed(0)}% to 21%. FLEX: self-extinction rises from ~7% (25–34% O₂) to ~57% (21–24%). Needed: +${dP.toFixed(1)} psi of N₂ (O₂ fraction = ${(r.o2 * 100).toFixed(0)}% × ${e.psi.toFixed(1)} / (${e.psi.toFixed(1)} + ΔP) = 21%), final ${pf.toFixed(1)} psi: the module must be rated for it (ISS modules operate at 14.7 psi). Crew must not stay in the zone (lower O₂ to breathe).`]);
  }
  if (e.gravity === 'partial') I.push(['Controlled vent-to-vacuum of an empty module', 'A sealed, evacuated module on the Moon or Mars can be vented to space: no oxygen, no fire. Only after every crew member is out and the hatch is closed; re-pressurise later from stores.']);
  I.push(['Auto risk check from the sensors', 'Detectors that also read O₂ and pressure feed this tool automatically, so the crew sees the risk level and the right extinguisher the moment an alarm sounds.']);
  I.push(['Pre-flight material screening', 'Every item planned for a habitat is run through this check at that habitat\'s air; High-risk materials are swapped or stored in sealed bags before launch.']);
  if (e.gravity === 'partial') I.push(['Gravity-aware detector layout', 'On the Moon smoke rises slowly: detectors both near the ceiling and in the return-air ducts, plus a check of the reading with fans off.']);
  return {steps: S, ideas: I};
}

/* ---------- result view ---------- */
function renderResult(r) {
  const p = Math.round(r.pExt * 100), AC = actions(r), A = AC.steps, cls = r.level.toLowerCase();
  $('#result').innerHTML = `
  <div class="riskhead ${cls}">
    <div><span class="lbl">Risk level</span><b>${r.level}</b></div>
    <div><span class="lbl">Will the fire go out by itself?</span><b>${p >= 70 ? 'Likely' : p >= 30 ? 'Uncertain' : 'Unlikely'}</b><span class="sub">${p}% chance, ${esc(r.basis)}</span></div>
    <div><span class="lbl">How long can it burn?</span><span class="sub2">${esc(r.time)}</span></div>
  </div>
  <div class="grid2">
    <div class="card"><h3>Response: Warn · Gather · Work</h3><p class="sm">Follows the ISS fire response order (NASA). You cannot leave a spacecraft: the last resort is to seal the module and move to the safe point.</p><ul class="actions plain">${A.map(([t, w]) => `<li><b>${esc(t)}</b><span>${esc(w)}</span></li>`).join('')}</ul>${AC.ideas.length ? `<h4>New ideas for this habitat (concepts, not current procedure)</h4><ul class="actions plain idea">${AC.ideas.map(([t, w]) => `<li><b>${esc(t)}</b><span>${esc(w)}</span></li>`).join('')}</ul>` : ''}</div>
    <div class="card"><h3>Why this result</h3>
      <ul class="why">${r.reasons.map(x => `<li>${esc(x)}</li>`).join('')}</ul>
      ${r.flags.length ? `<h4>Data warnings</h4><ul class="why warnl">${r.flags.map(x => `<li>${esc(x)}</li>`).join('')}</ul>` : ''}
      <h4>NASA evidence used</h4><ul class="why">${r.evidence.map(x => `<li>${esc(x)}</li>`).join('')}</ul>
    </div>
  </div>`;
  $('#result').hidden = false;
  $('#result').scrollIntoView({behavior: 'smooth', block: 'start'});
}
})();
