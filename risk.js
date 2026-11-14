/* Fire risk check: location → atmosphere, material → family/state, then a data-based risk assessment */
(() => {
const D = window.DATA, $ = s => document.querySelector(s);
const esc = s => String(s ?? '').replace(/[&<>"]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));
const PSI_PER_ATM = 14.696;
const LEVELS = ['Low', 'Medium', 'High'];

/* ---------- step 1: location ---------- */
const opt = l => `<option value="${l.id}">${esc(l.name.replace(/^Earth – /, ''))}</option>`;
$('#loc').innerHTML = '<option value="">Select your location…</option>' +
  `<optgroup label="Space">${D.locations.filter(l => l.gravity !== 'earth' && l.id !== 'custom').map(opt).join('')}</optgroup>` +
  `<optgroup label="Earth (oxygen-enriched or sealed spaces)">${D.locations.filter(l => l.gravity === 'earth').map(opt).join('')}</optgroup>` +
  `<optgroup label="Other">${D.locations.filter(l => l.id === 'custom').map(opt).join('')}</optgroup>`;
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
    const map = {spreads: [0.2, 'Medium'], slow: [0.35, 'Medium'], nospread: [0.85, 'Low'], smoke: [0.6, 'Low'], unknown: [0.3, 'Medium'], battery: [0.05, 'High']};
    pExt = map[cls][0];
    base = map[cls][1];
    if (m) evidence.push(`${m.name}: ${m.note} (${m.source})`); else reasons.push('Unknown solid: not tested by NASA, assumed to spread like cotton fabric.');
    evidence.push('All NASA solid-material fire tests were run at ~21–22% O₂ and ~1 atm (Saffire, BASS, BASS-II).');
    time = cls === 'spreads' ? 'Saffire: a 29 cm strip burned out in 115–145 s; a 94 cm sheet burned 70 s (air against the flame) to 420 s (air with the flame).'
      : cls === 'slow' ? 'Saffire-II: PMMA kept burning slowly for 600–900 s, flame anchored at its base.'
      : cls === 'nospread' ? 'Saffire-II: did not spread after ignition at ~22% O₂.'
      : cls === 'smoke' ? 'Tested by overheating (smoke), not by open flame.'
      : cls === 'battery' ? 'Thermal runaway can continue for minutes and cells can reignite after the flame is out; no PSI timing data.' : 'No NASA timing data.';
    if (cls === 'battery') reasons.push('No NASA PSI fire data for batteries: rated High by rule, because a battery fire heats itself and does not need cabin oxygen to continue.');
    if (cls !== 'battery' && (o2 > 0.23 || atm < 0.9)) flags.push('No NASA solid-material fire data at this oxygen level or pressure; FLEX and CFI-G show flames persist longer at higher O₂.');
    if (cls === 'smoke') reasons.push('Main hazard is smoke and toxic gases from overheating (SAME/SAME-R).');
  }

  // 4) how well NASA data covers this case (0–100)
  let cov;
  if (st === 'liquid') { const md = knnFlex(o2, atm, m && m.model === 'Methanol' ? 'Methanol' : 'Heptane', 'N2 only').meanDist; cov = md < 0.5 ? 100 : md < 1 ? 80 : md < 2 ? 55 : 30; if (!m) cov -= 20; }
  else if (st === 'gas') cov = (o2 >= 0.18 && o2 <= 0.40 && bar >= 0.4 && bar <= 3.3) ? 70 : 30;
  else cov = !m ? 10 : m.solid === 'battery' ? 0 : (o2 <= 0.23 && atm >= 0.9) ? 60 : 25;
  if (flags.some(f => f.startsWith('Outside'))) cov -= 25;
  if (e.gravity === 'partial') cov -= 20;
  if (e.gravity === 'earth') cov -= 30;
  if (m && m.nodata) cov = Math.min(cov - 30, 35);
  cov = Math.max(0, Math.min(100, cov));

  if (base == null) base = pExt >= 0.7 ? 'Low' : pExt >= 0.3 ? 'Medium' : 'High';
  reasons.unshift(`Predicted chance the fire goes out by itself: ${Math.round(pExt * 100)}% → base risk ${base}.`);
  if (m && m.nodata) { reasons.push(m.nodata); }
  if (e.gravity === 'earth') flags.push('Earth gravity (1 g): the NASA tests ran in microgravity. On Earth hot gas rises and feeds the flame, so fires usually grow faster; the data shows the oxygen trend, not Earth burn rates.');
  if (e.gravity === 'partial') flags.push(`Partial gravity (${e.g}): NASA has no fire data yet (LUCI and FM2 planned). Partial gravity may feed a flame more than microgravity.`);
  if (e.o2 >= 0.99) flags.push('Pure oxygen (spacesuit / Apollo 1 conditions): no microgravity data; most materials burn readily.');
  let level = LEVELS.indexOf(base);
  if (flags.length) { level = Math.min(2, level + 1); reasons.push('Raised one level because the conditions are not covered by NASA data (precaution).'); }
  if (e.o2 >= 0.99) level = 2;
  return {e, m, typed, st, pExt, cov, basis: (m && m.solid === 'battery') ? 'rule-based (no NASA test data)' : st === 'solid' ? 'estimate from how this material class behaved in Saffire' : 'from similar NASA tests', level: LEVELS[level], reasons, flags, evidence, time, gasAdvice, o2, atm};
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
  const isBatt = r.m && r.m.solid === 'battery';
  const enclosed = r.st !== 'solid' || (r.m && ['smoke', 'unknown'].includes(r.m.solid));
  const agent = 'CO₂ extinguisher for fires inside a rack or equipment (wear the breathing apparatus while discharging CO₂); water-mist extinguisher for open-cabin fires and lithium-battery fires (ISS practice).' +
    (lowO2 ? (r.gasAdvice && r.gasAdvice.length ? ` FLEX at this O₂: ${r.gasAdvice.map(g => `${g.gas} ${Math.round(g.p * 100)}% self-extinction`).join(', ')} vs ${Math.round(r.pExt * 100)}% in plain air.` : ' FLEX: CO₂ improved self-extinction up to 24% O₂.')
           : ' Above 25% O₂, CO₂ alone stopped 0 of 6 FLEX flames: always combine it with oxygen and air-flow isolation.');
  const srcB = isBatt ? 'Stop charging and remove power; do not touch or open the hot pack; keep it away from other materials.' : src;
  const agentB = isBatt ? 'Water-mist extinguisher: it cools the cells (ISS practice for lithium-battery fires). CO₂ alone does not cool the battery, so it can reignite.' : agent;
  if (e.gravity === 'earth') {
    const E = [];
    E.push(['1 · Raise the alarm', 'Activate the fire alarm and call the fire service / emergency team.']);
    E.push(['2 · Shut off the oxygen', e.id.startsWith('hbo') ? 'Stop oxygen flow to the chamber and start the emergency fire-suppression (deluge / water) system if fitted.' : e.id === 'hosp' ? 'Close the zone oxygen valve or turn off the patient oxygen supply; remove the mask or cannula if it is burning.' : 'Shut off any oxygen or fuel supply feeding the fire.']);
    E.push(['3 · Remove people from danger', e.id === 'sub' ? 'A submarine cannot be left at depth: isolate the compartment, put on emergency breathing masks and fight the fire from outside the hot zone.' : e.id === 'aircraft' ? 'Move passengers away from the fire; cabin crew fight it while the flight crew prepare to divert and land.' : 'Move patients and staff out of the room or chamber and close the door.']);
    E.push(['4 · Extinguish', srcB + ' ' + (isBatt ? 'Use water or water mist to cool a battery.' : 'Use the extinguisher type approved for the area (water mist or CO₂ for electrical equipment).')]);
    E.push(['5 · Ventilate only after the fire is out', 'Opening doors or turning on fans earlier feeds the fire with fresh oxygen (Saffire-I: air flow with the flame made it burn 6× longer).']);
    if (r.o2 > 0.235) E.push(['Oxygen-enriched area rule', `At ${(r.o2 * 100).toFixed(0)}% O₂, FLEX shows flames rarely go out by themselves: no open flames, sparks or petroleum products; fire-retardant bedding and clothing only.`]);
    return {steps: E, ideas: [['Same tool, Earth use', 'Hospitals, hyperbaric centres, submarines and aircraft can use the same check to rate materials before they enter an oxygen-enriched space.']]};
  }
  if (e.id === 'suit') {
    return {steps: [['Prevention is the only defence', 'Inside a 100% O₂ suit there is no way to fight a fire: no ignition sources, no unapproved materials, no grease or oil near O₂ fittings.'],
      ['Approve every material at 100% O₂', 'NASA has no microgravity fire data at suit conditions; treat any flammable material as High risk.']], ideas: []};
  }
  S.push(['1 · WARN: raise the fire alarm', 'Press the alarm or call it out; on the ISS a smoke alarm also stops the fans, the gas feeds and oxygen generation automatically.']);
  S.push(['2 · Confirm air flow is stopped', `Ventilation fans and O₂ supply OFF in this module. Saffire-I: air flowing with the flame made it burn 6× longer (420 s vs 70 s).`]);
  if (r.level !== 'Low') S.push(['3 · GATHER at the safe point', `Crew meet at ${refuge(e)}. Bring the handheld combustion-products analyser to monitor the air.`]);
  S.push([`${r.level === 'Low' ? '3' : '4'} · WORK step 1: isolate the source`, srcB]);
  if (r.level !== 'Low') {
    S.push(['5 · Protect breathing', 'Respirator with fire cartridge for work near the fire; the oxygen breathing apparatus only to move away or when using CO₂ (it adds O₂ near the fire).']);
    S.push(['6 · WORK step 2: extinguish', agentB]);
  } else S.push(['4 · Keep an extinguisher in hand', agentB]);
  if (isBatt) S.push(['Watch for reignition', 'Keep cooling and watching the battery for at least several minutes; cells can flare up again after the flame is out.']);
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
function covLabel(c) { return c >= 70 ? 'High' : c >= 40 ? 'Medium' : 'Low'; }
let lastR = null, whatIfChart = null;
function renderResult(r) {
  lastR = r;
  const p = Math.round(r.pExt * 100), AC = actions(r), A = AC.steps, cls = r.level.toLowerCase();
  const showWhatIf = r.e.id !== 'suit';
  $('#result').innerHTML = `
  <div class="riskhead ${cls}">
    <div><span class="lbl">Risk level</span><b>${r.level}</b></div>
    <div><span class="lbl">Will the fire go out by itself?</span><b>${p >= 70 ? 'Likely' : p >= 30 ? 'Uncertain' : 'Unlikely'}</b><span class="sub">${p}% chance, ${esc(r.basis)}</span></div>
    <div><span class="lbl">How long can it burn?</span><span class="sub2">${esc(r.time)}</span>
      <div class="cov"><span class="lbl">NASA data coverage: <b class="covtxt">${covLabel(r.cov)}</b></span><div class="covbar"><div style="width:${r.cov}%"></div></div>
      <span class="sub">How close your case is to real NASA tests (${r.cov}/100)</span></div></div>
  </div>
  <div class="toolbar">
    <button class="secondary" id="btnCompare">Compare all habitats</button>
    <button class="secondary" id="btnPrint">Print emergency card</button>
  </div>
  <div id="compareBox" hidden></div>
  ${showWhatIf ? `<div class="card whatif"><h3>What if the oxygen level changed?</h3>
    <p class="sm">Move the slider to see how the risk for <b>${esc(r.m ? r.m.name : r.typed)}</b> changes at ${r.e.psi.toFixed(1)} psi. The dashed lines are the risk limits (30% and 70%).</p>
    <label class="wl">Oxygen <output id="wiOut"></output><input id="wiO2" type="range" min="12" max="40" step="1" value="${Math.min(40, Math.max(12, Math.round(r.o2 * 100)))}"></label>
    <div class="wires" id="wiRes"></div>
    <div class="wichart"><canvas id="wiChart" height="200"></canvas></div></div>` : ''}
  <div class="grid2">
    <div class="card"><h3>Response: Warn · Gather · Work</h3><p class="sm">Follows the ISS fire response order (NASA). You cannot leave a spacecraft: the last resort is to seal the module and move to the safe point.</p><ul class="actions plain">${A.map(([t, w]) => `<li><b>${esc(t)}</b><span>${esc(w)}</span></li>`).join('')}</ul>${AC.ideas.length ? `<h4>New ideas for this habitat (concepts, not current procedure)</h4><ul class="actions plain idea">${AC.ideas.map(([t, w]) => `<li><b>${esc(t)}</b><span>${esc(w)}</span></li>`).join('')}</ul>` : ''}</div>
    <div class="card"><h3>Why this result</h3>
      <ul class="why">${r.reasons.map(x => `<li>${esc(x)}</li>`).join('')}</ul>
      ${r.flags.length ? `<h4>Data warnings</h4><ul class="why warnl">${r.flags.map(x => `<li>${esc(x)}</li>`).join('')}</ul>` : ''}
      <h4>NASA evidence used</h4><ul class="why">${r.evidence.map(x => `<li>${esc(x)}</li>`).join('')}</ul>
    </div>
  </div>`;
  $('#result').hidden = false;
  $('#btnCompare').addEventListener('click', () => renderCompare(r));
  $('#btnPrint').addEventListener('click', () => printCard(r, A));
  if (showWhatIf) setupWhatIf(r);
  $('#result').scrollIntoView({behavior: 'smooth', block: 'start'});
}

/* 2) same material in every habitat */
function renderCompare(r) {
  const rows = D.locations.filter(l => l.id !== 'custom').map(l => ({l, a: assess(l, r.m, r.typed, r.st)}));
  const box = $('#compareBox');
  box.innerHTML = `<div class="card"><h3>${esc(r.m ? r.m.name : r.typed)} (${r.st}) in every habitat</h3>
    <div class="tablewrap"><table><thead><tr><th>Habitat</th><th>Pressure</th><th>O₂</th><th>Gravity</th><th>Chance it goes out by itself</th><th>Data coverage</th><th>Risk</th></tr></thead><tbody>
    ${rows.map(({l, a}) => `<tr${l.id === r.e.id ? ' class="cur"' : ''}><td>${esc(l.name)}</td><td>${l.psi} psi</td><td>${Math.round(l.o2 * 1000) / 10}%</td><td>${esc(l.g)}</td><td>${Math.round(a.pExt * 100)}%</td><td>${covLabel(a.cov)}</td><td><span class="rk ${a.level.toLowerCase()}">${a.level}</span></td></tr>`).join('')}
    </tbody></table></div><p class="note">Same rules as above for every row. Rover and Mars use the Moon-base atmosphere (assumed).</p></div>`;
  box.hidden = false;
  box.scrollIntoView({behavior: 'smooth', block: 'start'});
}

/* 3) what-if oxygen slider */
function setupWhatIf(r) {
  const at = o2 => assess({...r.e, o2, n2: Math.max(0, 1 - o2)}, r.m, r.typed, r.st);
  const xs = []; for (let x = 12; x <= 40; x++) xs.push(x);
  const ys = xs.map(x => Math.round(at(x / 100).pExt * 100));
  if (whatIfChart) whatIfChart.destroy();
  const cur = {id: 'cur', afterDatasetsDraw(c) { const v = +$('#wiO2').value, xs2 = c.scales.x, ys2 = c.scales.y, ctx = c.ctx, px = xs2.getPixelForValue(String(v));
    ctx.save(); ctx.strokeStyle = '#1A1A2E'; ctx.lineWidth = 2; ctx.beginPath(); ctx.moveTo(px, ys2.top); ctx.lineTo(px, ys2.bottom); ctx.stroke();
    ctx.setLineDash([5, 4]); ctx.strokeStyle = '#9AA0A6'; ctx.lineWidth = 1; [30, 70].forEach(t => { const py = ys2.getPixelForValue(t); ctx.beginPath(); ctx.moveTo(xs2.left, py); ctx.lineTo(xs2.right, py); ctx.stroke(); }); ctx.restore(); }};
  whatIfChart = new Chart($('#wiChart'), {type: 'line', plugins: [cur],
    data: {labels: xs.map(String), datasets: [{data: ys, borderColor: '#2F6FB2', backgroundColor: '#2F6FB2', pointRadius: 0, borderWidth: 2.5, tension: 0.25}]},
    options: {animation: false, plugins: {legend: {display: false}, tooltip: {callbacks: {title: i => `${i[0].label}% O₂`, label: i => `${i.raw}% chance it goes out by itself`}}},
      scales: {y: {min: 0, max: 100, title: {display: true, text: '% chance it goes out by itself'}}, x: {title: {display: true, text: 'Oxygen (%)'}, ticks: {maxTicksLimit: 8}}}}});
  const upd = () => { const v = +$('#wiO2').value, a = at(v / 100);
    $('#wiOut').textContent = v + '%';
    const knock = r.o2 > 0.245 && v <= 21 ? `<span class="sm">Nitrogen knock-down to ${v}% O₂ needs about +${(r.e.psi * (r.o2 / (v / 100) - 1)).toFixed(1)} psi of N₂.</span>` : '';
    $('#wiRes').innerHTML = `<span class="rk ${a.level.toLowerCase()}">${a.level}</span> <b>${Math.round(a.pExt * 100)}%</b> chance it goes out by itself at ${v}% O₂ ${knock}`;
    whatIfChart.update('none'); };
  $('#wiO2').addEventListener('input', upd); upd();
}

/* 5) printable emergency card */
function printCard(r, A) {
  const w = window.open('', '_blank');
  if (!w) { alert('Please allow pop-ups to print the card.'); return; }
  const col = {High: '#C62828', Medium: '#B26B00', Low: '#2E7D4F'}[r.level];
  w.document.write(`<!doctype html><html><head><meta charset="utf-8"><title>Fire emergency card</title><style>
    body{font-family:Arial,sans-serif;margin:24px;color:#111}h1{font-size:20px;margin:0}.risk{border:4px solid ${col};color:${col};font-size:28px;font-weight:700;padding:8px 14px;display:inline-block;margin:10px 0}
    .meta{font-size:13px;color:#333}ol{padding-left:20px}li{margin-bottom:8px;font-size:14px}li span{display:block;color:#444;font-size:12.5px}.foot{font-size:11px;color:#666;margin-top:14px;border-top:1px solid #ccc;padding-top:6px}</style></head><body>
    <h1>FIRE EMERGENCY CARD</h1>
    <div class="meta">${esc(r.e.name)} · ${r.e.psi.toFixed(1)} psi · ${(r.o2 * 100).toFixed(1)}% O₂ · ${esc(r.e.g)}<br>Material: <b>${esc(r.m ? r.m.name : r.typed)}</b> (${esc(r.st)}${r.m ? ', ' + esc(r.m.family) : ''})</div>
    <div class="risk">RISK: ${r.level.toUpperCase()}</div>
    <div class="meta">Chance the fire goes out by itself: ${Math.round(r.pExt * 100)}% (${esc(r.basis)}) · Data coverage: ${covLabel(r.cov)}</div>
    <ol>${A.map(([t, x]) => `<li><b>${esc(t)}</b><span>${esc(x)}</span></li>`).join('')}</ol>
    <div class="foot">Flame in Freefall · NASA Space Apps 2026 · Based on NASA PSI data (FLEX, CFI-G, Saffire) and the ISS Warn–Gather–Work response. Screening tool, not a certified flight procedure. Printed ${new Date().toISOString().slice(0, 10)}.</div>
    <script>window.onload=()=>window.print()<\/script></body></html>`);
  w.document.close();
}
})();
