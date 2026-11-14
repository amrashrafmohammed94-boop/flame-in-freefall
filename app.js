/* Flame in Freefall dashboard – plain JS, data from data/data.js (window.DATA) */
const D = window.DATA;
const C = { accent:'#FF6B2C', blue:'#5AA9FF', green:'#3DDC97', gray:'#5E6A8E', ink:'#E8ECF8', muted:'#9AA6C7' };
Chart.defaults.font.family = 'Inter, system-ui, sans-serif';
Chart.defaults.color = C.muted;
Chart.defaults.borderColor = 'rgba(140,165,230,.15)';
const $ = s => document.querySelector(s);
const esc = s => String(s ?? '').replace(/[&<>"]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));

/* ---------- tabs ---------- */
document.querySelectorAll('.tabs button').forEach(b => b.addEventListener('click', () => {
  document.querySelectorAll('.tabs button').forEach(x => x.setAttribute('aria-selected', x === b));
  document.querySelectorAll('.panel').forEach(p => p.classList.toggle('active', p.id === b.dataset.tab));
}));

/* ---------- 1 explorer ---------- */
function dsClass(d){ return d.startsWith('In dashboard') ? 'in' : d.startsWith('Not yet') ? 'future' : 'check'; }
function renderCatalog(){
  const q = $('#q').value.toLowerCase(), area = $('#fArea').value, ds = $('#fData').value;
  const rows = D.catalog.filter(c =>
    (!q || [c.id,c.name,c.fuel,c.hw,c.why].join(' ').toLowerCase().includes(q)) &&
    (!area || c.area.includes(area)) && (!ds || c.data.startsWith(ds)));
  $('#catTable tbody').innerHTML = rows.map(c => `<tr>
    <td><b>${esc(c.id)}</b><span class="sm">${esc(c.name)}</span></td>
    <td>${esc(c.hw)}</td><td>${esc(c.fuel)}<div class="sm">${esc(c.why)}</div></td>
    <td>${c.area.map(a=>`<span class="pill ${a}">${a}</span>`).join('')}</td>
    <td><span class="ds ${dsClass(c.data)}">${esc(c.data)}</span></td></tr>`).join('');
  $('#catCount').textContent = `${rows.length} of ${D.catalog.length} investigations`;
}
['#q','#fArea','#fData'].forEach(s => $(s).addEventListener('input', renderCatalog));
renderCatalog();

/* ---------- 2 habitat ---------- */
const HAB = [
  {key:'iss', label:'Space station', atm:'Space station (ISS)'},
  {key:'moon', label:'Moon base', atm:'Moon base'},
  {key:'rover', label:'Pressurized rover', atm:'Pressurized rover'},
  {key:'mars', label:'Mars habitat', atm:'Mars habitat'},
  {key:'suit', label:'Spacesuit', atm:'Spacesuit'}];
const earth = D.atmospheres.find(a => a.place.startsWith('Earth'));
let n2Chart;
function renderHabitat(key){
  const h = HAB.find(x => x.key === key), a = D.atmospheres.find(x => x.place === h.atm);
  document.querySelectorAll('#habChips button').forEach(b => b.classList.toggle('on', b.dataset.k === key));
  const o2p = a.psi*a.o2, n2p = a.psi*a.n2;
  $('#atmCard').innerHTML = `<h3>${h.label} atmosphere</h3>
    <div class="atm"><div><span>Pressure</span><b>${a.psi}</b> psi</div><div><span>Oxygen</span><b>${Math.round(a.o2*1000)/10}%</b></div><div><span>Nitrogen</span><b>${Math.round(a.n2*1000)/10}%</b></div></div>
    <p>Oxygen to breathe: <b>${o2p.toFixed(1)} psi</b> (Earth ${(earth.psi*earth.o2).toFixed(1)}) · Nitrogen around a flame: <b>${n2p.toFixed(1)} psi</b> (Earth ${(earth.psi*earth.n2).toFixed(1)})</p>
    <p class="note">Source status: ${esc(a.status)}.</p>`;
  const data = [earth.psi*earth.n2, n2p];
  if (n2Chart) n2Chart.destroy();
  n2Chart = new Chart($('#n2Chart'), {type:'bar', data:{labels:['Earth', h.label], datasets:[{data, backgroundColor:[C.gray, C.accent], borderRadius:4, maxBarThickness:70}]},
    options:{plugins:{legend:{display:false}, tooltip:{callbacks:{label:c=>`${c.raw.toFixed(1)} psi N₂`}}}, scales:{y:{beginAtZero:true, title:{display:true,text:'N₂ partial pressure (psi)'}}, x:{grid:{display:false}}}}});
  const ranked = D.catalog.filter(c => c.rel[key] > 0).sort((x,y) => y.rel[key]-x.rel[key]);
  $('#rankList').innerHTML = ranked.map((c,i) => `<li><span class="no">${i+1}</span>
    <div><b>${esc(c.id)}</b> <span class="sm">${esc(c.name)}</span><div class="sm">${esc(c.why)}</div></div>
    <span class="score" title="Relevance 0–3">${'●'.repeat(c.rel[key])}${'○'.repeat(3-c.rel[key])}</span></li>`).join('');
}
$('#habChips').innerHTML = HAB.map(h => `<button data-k="${h.key}">${h.label}</button>`).join('');
document.querySelectorAll('#habChips button').forEach(b => b.addEventListener('click', () => renderHabitat(b.dataset.k)));
renderHabitat('moon');

/* ---------- 3 oxygen ---------- */
const S = D.summary, flex = D.flex;
const ml = S.moon_like;
$('#kpis').innerHTML = [
  [flex.length, 'valid FLEX tests on the ISS'],
  [S.o2_bands[0].extinction_pct+'%', 'self-extinguished at 12–17% O₂'],
  [S.o2_bands[S.o2_bands.length-1].extinction_pct+'%', 'self-extinguished at 25–34% O₂'],
  [`${ml.extinction} / ${ml.n}`, 'self-extinguished in Moon-like tests (≈0.7 atm, ≥25% O₂)', true]
].map(([v,l,hot]) => `<div class="kpi ${hot?'hot':''}"><b>${v}</b><span>${l}</span></div>`).join('');

new Chart($('#bandChart'), {type:'bar',
  data:{labels:S.o2_bands.map(b=>b.band), datasets:[{data:S.o2_bands.map(b=>b.extinction_pct), backgroundColor:C.accent, borderRadius:4, maxBarThickness:60}]},
  options:{plugins:{legend:{display:false}, tooltip:{callbacks:{label:c=>`${c.raw}% of ${S.o2_bands[c.dataIndex].n} tests`}}},
    scales:{y:{max:100, beginAtZero:true, title:{display:true,text:'% of tests'}}, x:{title:{display:true,text:'Initial oxygen'}, grid:{display:false}}}}});

const pts = f => flex.filter(r => r.Fuel===f && r.K_mm2_s!=null).map(r => ({x:+(r.O2_frac*100).toFixed(1), y:r.K_mm2_s}));
new Chart($('#kChart'), {type:'scatter',
  data:{datasets:[{label:'Heptane', data:pts('Heptane'), backgroundColor:C.accent+'AA', pointRadius:3.5},{label:'Methanol', data:pts('Methanol'), backgroundColor:C.blue+'AA', pointRadius:3.5}]},
  options:{plugins:{legend:{position:'bottom'}}, scales:{x:{title:{display:true,text:'Oxygen (%)'}}, y:{title:{display:true,text:'K (mm²/s)'}}}}});

const bands = S.o2_bands.map(b=>b.band), dils = [['N2 only','Nitrogen only',C.gray],['CO2','CO₂',C.accent],['He','Helium',C.blue]];
new Chart($('#dilChart'), {type:'bar',
  data:{labels:bands, datasets:dils.map(([k,l,col]) => ({label:l, backgroundColor:col, borderRadius:3,
    data:bands.map(b => { const r = S.diluent_by_band.find(x=>x.O2_band===b && x.Diluent===k); return r ? r.ext : null; }),
    ns:bands.map(b => { const r = S.diluent_by_band.find(x=>x.O2_band===b && x.Diluent===k); return r ? r.n : 0; })}))},
  options:{plugins:{legend:{position:'bottom'}, tooltip:{callbacks:{label:c=>`${c.dataset.label}: ${c.raw}% (n=${c.dataset.ns[c.dataIndex]})`}}},
    scales:{y:{max:100, beginAtZero:true, title:{display:true,text:'% self-extinguished'}}, x:{title:{display:true,text:'Initial oxygen'}, grid:{display:false}}}}});

/* predictor */
const M = D.model;
function predict(o2, p, dil, fuel){
  const x = [o2, p, dil==='CO2'?1:0, dil==='He'?1:0, fuel==='Heptane'?1:0];
  let z = M.intercept;
  x.forEach((v,i) => z += M.coef[i]*(v-M.mean[i])/M.std[i]);
  return 1/(1+Math.exp(-z));
}
function updatePred(){
  const o2 = +$('#o2').value, p = +$('#p').value, dil = $('#dil').value, fuel = $('#fuel').value;
  $('#o2Out').textContent = o2+'%';
  $('#pOut').textContent = `${p.toFixed(2)} atm · ${(p*14.696).toFixed(1)} psi`;
  const pr = predict(o2,p,dil,fuel), pct = Math.round(pr*100);
  $('#gfill').style.width = pct+'%';
  $('#gfill').style.background = pr < .5 ? C.accent : C.blue;
  $('#gval').textContent = pct+'%';
  const out = o2 < 12 || o2 > 34 || p < 0.69 || p > 3.05;
  $('#gmsg').className = 'gmsg' + (pr < .5 ? ' warn' : '');
  $('#gmsg').textContent = (pr < .5 ? 'Likely to keep burning – active suppression needed.' : 'Likely to go out by itself.') +
    (out ? ' ⚠ Outside the tested range (O₂ 12–34%, 0.7–3 atm): extrapolation, treat with caution.' : '');
}
$('#modelNote').textContent = `Logistic regression trained on NASA FLEX (n=${M.cv.n}). Cross-validated ROC-AUC ${M.cv.roc_auc}, balanced accuracy ${M.cv.balanced_accuracy} (${M.cv.method}). Probability of self-extinction for a single fuel droplet in microgravity – a screening indicator, not a design value.`;
['#o2','#p','#dil','#fuel'].forEach(s => $(s).addEventListener('input', updatePred));
document.querySelectorAll('.presets button').forEach(b => b.addEventListener('click', () => { $('#o2').value=b.dataset.o2; $('#p').value=b.dataset.p; updatePred(); }));
updatePred();

/* ---------- 4 insights ---------- */
const AREAS = ['All','Prevention','Detection','Suppression','Knowledge gap'];
function renderLessons(area){
  document.querySelectorAll('#areaChips button').forEach(b => b.classList.toggle('on', b.dataset.a === area));
  $('#lessons').innerHTML = D.lessons.filter(l => area==='All' || l.area===area).map(l => `<article class="lesson ${l.area.replace(' ','')}">
    <span class="pill ${l.area==='Knowledge gap'?'gap':l.area}">${esc(l.area)}</span>
    <dl><dt>Finding</dt><dd>${esc(l.finding)}</dd><dt>Meaning</dt><dd>${esc(l.meaning)}</dd>
    <dt>Recommendation</dt><dd class="rec">${esc(l.rec)}</dd></dl>
    <div class="status">Source: ${esc(l.source)} · ${esc(l.status)}</div></article>`).join('');
}
$('#areaChips').innerHTML = AREAS.map(a => `<button data-a="${a}">${a}</button>`).join('');
document.querySelectorAll('#areaChips button').forEach(b => b.addEventListener('click', () => renderLessons(b.dataset.a)));
renderLessons('All');
