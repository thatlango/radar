(() => {
  const $ = (id) => document.getElementById(id);
  const state = { session: null, config: null, opportunities: [], selected: null, view: 'discover', timer: null };
  const pendingKey = 'radar:tuku-sso:pending';
  const escape = (value) => String(value ?? '').replace(/[&<>"']/g, (c) => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const api = async (path, options = {}) => {
    const response = await fetch(path, { credentials: 'same-origin', ...options, headers: { Accept: 'application/json', ...(options.body ? {'content-type':'application/json'} : {}), ...(options.headers || {}) } });
    const body = response.status === 204 ? null : await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(body?.error?.message || `Request failed (${response.status})`);
    return body?.data ?? body;
  };
  const toast = (message) => { const el = $('toast'); el.textContent = message; el.classList.add('show'); clearTimeout(state.timer); state.timer = setTimeout(() => el.classList.remove('show'), 2600); };
  const list = (value) => String(value || '').split(',').map((v) => v.trim()).filter(Boolean);
  const fmtDate = (value) => value ? new Intl.DateTimeFormat(undefined,{dateStyle:'medium'}).format(new Date(value)) : 'No deadline listed';
  const days = (value) => value ? Math.ceil((new Date(value).getTime() - Date.now()) / 86400000) : null;
  const deadline = (value) => { const d = days(value); if (d === null) return 'Open deadline'; if (d < 0) return 'Closed'; if (d === 0) return 'Closes today'; if (d === 1) return '1 day left'; return `${d} days left`; };
  const base64url = (bytes) => { let s=''; bytes.forEach(b => s += String.fromCharCode(b)); return btoa(s).replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/g,''); };
  const token = (length) => { const b = new Uint8Array(length); crypto.getRandomValues(b); return base64url(b); };
  const challenge = async (verifier) => base64url(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier))));

  async function signIn() {
    const config = state.config || await api('/api/config');
    const verifier = token(64), ssoState = token(32), codeChallenge = await challenge(verifier);
    sessionStorage.setItem(pendingKey, JSON.stringify({ verifier, state: ssoState, createdAt: Date.now() }));
    const url = new URL('/authorize', config.coreUrl);
    url.searchParams.set('client_id', config.clientId);
    url.searchParams.set('redirect_uri', config.redirectUri);
    url.searchParams.set('state', ssoState);
    url.searchParams.set('code_challenge', codeChallenge);
    url.searchParams.set('code_challenge_method', 'S256');
    location.assign(url.toString());
  }

  async function finishSignIn() {
    const params = new URLSearchParams(location.search);
    const code = params.get('code'), returnedState = params.get('state');
    if (!code || !returnedState) return false;
    const raw = sessionStorage.getItem(pendingKey);
    if (!raw) throw new Error('This Tuku sign-in has expired. Start again.');
    const pending = JSON.parse(raw);
    if (pending.state !== returnedState || Date.now() - Number(pending.createdAt || 0) > 600000) throw new Error('Tuku sign-in could not be resumed safely.');
    await api('/api/auth/tuku/exchange', { method:'POST', body: JSON.stringify({ code, codeVerifier: pending.verifier }) });
    sessionStorage.removeItem(pendingKey);
    history.replaceState({}, '', '/app');
    return true;
  }

  async function loadSession() {
    try { state.session = await api('/api/session'); } catch { state.session = null; }
    $('authButton').textContent = state.session ? 'Sign out' : 'Sign in with Tuku';
    $('sessionLabel').textContent = state.session ? (state.session.user?.name || state.session.user?.email || 'Tuku account') : 'Browsing public opportunities';
  }

  function requireAuth() { if (state.session) return true; toast('Sign in with Tuku to use this action.'); return false; }

  async function loadStats() {
    try {
      const s = await api('/api/stats');
      const items = [['Live',s.live,'Open opportunities'],['Remote',s.remote,'Location-flexible'],['Closing soon',s.closingSoon,'Within 14 days'],['Sources',s.activeSources,'Active feeds']];
      $('statsGrid').innerHTML = items.map(([l,v,n]) => `<article class="stat-card"><span>${escape(l)}</span><strong>${Number(v||0).toLocaleString()}</strong><small>${escape(n)}</small></article>`).join('');
      $('sourceStatus').textContent = `${Number(s.activeSources||0)} active sources`;
    } catch { $('statsGrid').innerHTML = ''; }
  }

  function card(row) {
    const selected = state.selected?.id === row.id ? ' selected' : '';
    const score = row.fitScore === null || row.fitScore === undefined ? '<span class="score unknown">—</span>' : `<span class="score">${Math.round(row.fitScore)}%</span>`;
    return `<article class="opportunity-card${selected}" data-id="${escape(row.id)}"><div class="card-top"><div><h3>${escape(row.title)}</h3><div class="org">${escape(row.organization || 'Organisation not listed')}</div></div>${score}</div><div class="meta-row">${row.type?`<span class="tag">${escape(row.type)}</span>`:''}${row.country?`<span class="tag">${escape(row.country)}</span>`:''}${row.remote?'<span class="tag">Remote</span>':''}<span class="tag deadline">${escape(deadline(row.deadline))}</span>${row.saved?'<span class="tag">Saved</span>':''}</div><p class="card-description">${escape(row.summary || row.description || 'Open the opportunity for full details.')}</p></article>`;
  }

  function bindCards(container) { container.querySelectorAll('.opportunity-card').forEach((el) => el.addEventListener('click', () => selectOpportunity(el.dataset.id))); }

  async function loadOpportunities() {
    const target = $('opportunityList'); target.innerHTML = '<div class="loading-card"></div><div class="loading-card"></div><div class="loading-card"></div>';
    const p = new URLSearchParams(); const q=$('searchInput').value.trim(), type=$('typeFilter').value, country=$('countryFilter').value.trim();
    if(q)p.set('q',q); if(type)p.set('type',type); if(country)p.set('country',country); if($('remoteFilter').checked)p.set('remote','true'); p.set('limit','60');
    try {
      const data = await api(`/api/opportunities?${p}`); state.opportunities = data.items || [];
      $('resultMeta').textContent = `${state.opportunities.length} current result${state.opportunities.length===1?'':'s'}`;
      target.innerHTML = state.opportunities.length ? state.opportunities.map(card).join('') : '<div class="empty-state">No current opportunities match these filters.</div>';
      bindCards(target);
      if (state.selected) { const fresh = state.opportunities.find(x=>x.id===state.selected.id); if(fresh){state.selected=fresh; renderDetail();} }
    } catch (e) { target.innerHTML = `<div class="empty-state">${escape(e.message)}</div>`; }
  }

  async function selectOpportunity(id) {
    try { state.selected = await api(`/api/opportunities/${encodeURIComponent(id)}`); renderDetail(); document.querySelectorAll('.opportunity-card').forEach(el => el.classList.toggle('selected',el.dataset.id===id)); } catch(e){toast(e.message)}
  }

  function renderDetail() {
    const row = state.selected; if(!row)return;
    const panel=$('detailPanel');
    panel.innerHTML = `<div class="detail"><div class="detail-head"><div><span class="eyebrow">${escape(row.type||'Opportunity')}</span><h2>${escape(row.title)}</h2><div class="org">${escape(row.organization||'Organisation not listed')} · ${escape(row.country||'Location not listed')}</div></div>${row.fitScore==null?'<span class="score unknown">—</span>':`<span class="score">${Math.round(row.fitScore)}%</span>`}</div><div class="meta-row">${row.remote?'<span class="tag">Remote</span>':''}<span class="tag deadline">${escape(deadline(row.deadline))}</span>${row.compensation?`<span class="tag">${escape(row.compensation)}</span>`:''}</div>${row.sourceUrl?`<a class="source-link" href="${escape(row.sourceUrl)}" target="_blank" rel="noopener noreferrer">Open original source ↗</a>`:''}<div class="detail-actions"><button id="saveAction" class="button secondary">${row.saved?'Remove saved':'Save opportunity'}</button><button id="fitAction" class="button accent">Explain my fit</button><button id="briefAction" class="button secondary">Prepare brief</button></div><div class="detail-section"><h4>Description</h4><p>${escape(row.description||row.summary||'No description available.')}</p></div>${row.requirements?`<div class="detail-section"><h4>Requirements</h4><p>${escape(row.requirements)}</p></div>`:''}<div id="aiSection" class="detail-section" style="display:none"><h4>Radar intelligence</h4><div id="aiBox" class="ai-box"></div></div><div class="detail-section"><h4>Application tracking</h4><div class="application-controls"><select id="applicationStatus"><option value="planning">Planning</option><option value="applied">Applied</option><option value="interview">Interview</option><option value="offer">Offer</option><option value="rejected">Rejected</option><option value="withdrawn">Withdrawn</option></select><textarea id="applicationNotes" rows="2" placeholder="Next step, contact, documents, follow-up…"></textarea></div><div class="detail-actions"><button id="trackAction" class="button primary">Save to pipeline</button></div></div><div class="detail-section"><h4>Deadline</h4><p>${escape(fmtDate(row.deadline))} · ${escape(deadline(row.deadline))}</p></div></div>`;
    $('saveAction').onclick=toggleSave; $('fitAction').onclick=()=>runAi('fit'); $('briefAction').onclick=()=>runAi('brief'); $('trackAction').onclick=saveApplication;
  }

  async function toggleSave(){ if(!requireAuth())return; const row=state.selected; try{ const result=row.saved?await api(`/api/opportunities/${row.id}/save`,{method:'DELETE'}):await api(`/api/opportunities/${row.id}/save`,{method:'POST',body:'{}'}); row.saved=result.saved; renderDetail(); await loadOpportunities(); toast(row.saved?'Saved to your shortlist.':'Removed from saved.'); }catch(e){toast(e.message)} }
  async function runAi(kind){ if(!requireAuth())return; const btn=$(kind==='fit'?'fitAction':'briefAction'); btn.disabled=true; btn.textContent='Working…'; $('aiSection').style.display='block'; $('aiBox').textContent='Radar is analysing the supplied opportunity and your saved context…'; try{const data=await api(`/api/opportunities/${state.selected.id}/${kind}`,{method:'POST',body:'{}'}); $('aiBox').textContent=data.explanation||data.text||'Analysis complete.'; if(data.fitScore!=null){state.selected.fitScore=data.fitScore;}}catch(e){$('aiBox').textContent=e.message}finally{btn.disabled=false;btn.textContent=kind==='fit'?'Explain my fit':'Prepare brief'} }
  async function saveApplication(){ if(!requireAuth())return; try{await api(`/api/opportunities/${state.selected.id}/applications`,{method:'POST',body:JSON.stringify({status:$('applicationStatus').value,notes:$('applicationNotes').value})});toast('Application pipeline updated.');}catch(e){toast(e.message)} }

  async function loadSaved(){ const el=$('savedList'); if(!requireAuth()){el.innerHTML='<div class="empty-state">Sign in with Tuku to keep a shortlist across devices.</div>';return;} el.innerHTML='<div class="loading-card"></div>'; try{const data=await api('/api/me/saved');el.innerHTML=(data.items||[]).length?(data.items||[]).map(card).join(''):'<div class="empty-state">No saved opportunities yet.</div>';bindCards(el);}catch(e){el.innerHTML=`<div class="empty-state">${escape(e.message)}</div>`} }
  async function loadApplications(){ const el=$('applicationList'); if(!requireAuth()){el.innerHTML='<div class="empty-state">Sign in with Tuku to track applications.</div>';return;} el.innerHTML='<div class="loading-card"></div>'; try{const data=await api('/api/me/applications');el.innerHTML=(data.items||[]).length?(data.items||[]).map(x=>`<article class="application-card"><div><h3>${escape(x.opportunity?.title)}</h3><p>${escape(x.opportunity?.organization||'')} · ${escape(x.notes||'No notes yet')}</p></div><span class="status-badge">${escape(x.status)}</span></article>`).join(''):'<div class="empty-state">Your application pipeline is empty.</div>';}catch(e){el.innerHTML=`<div class="empty-state">${escape(e.message)}</div>`} }
  async function loadProfile(){ if(!requireAuth())return; try{const u=await api('/api/me/profile');$('profileName').value=u.name||'';$('profileSkills').value=(u.skills||[]).join(', ');$('profileIndustries').value=(u.industries||[]).join(', ');$('profileCountries').value=(u.preferences?.countries||[]).join(', ');$('profileRemote').checked=u.preferences?.remote===true;}catch(e){toast(e.message)} }
  async function saveProfile(event){event.preventDefault();if(!requireAuth())return;const msg=$('profileMessage');msg.textContent='Saving…';try{await api('/api/me/profile',{method:'PUT',body:JSON.stringify({name:$('profileName').value.trim(),skills:list($('profileSkills').value),industries:list($('profileIndustries').value),preferences:{countries:list($('profileCountries').value),remote:$('profileRemote').checked}})});msg.textContent='Saved. Radar will use this context for future ranking.';toast('Matching profile updated.');await loadOpportunities();}catch(e){msg.textContent=e.message}}

  function showView(name){state.view=name;document.querySelectorAll('.view').forEach(el=>el.classList.toggle('active',el.id===`${name}View`));document.querySelectorAll('.nav-item').forEach(el=>el.classList.toggle('active',el.dataset.view===name));if(name==='saved')void loadSaved();if(name==='applications')void loadApplications();if(name==='profile')void loadProfile();}
  let debounce; $('searchInput').addEventListener('input',()=>{clearTimeout(debounce);debounce=setTimeout(loadOpportunities,300)}); $('typeFilter').onchange=loadOpportunities;$('countryFilter').addEventListener('input',()=>{clearTimeout(debounce);debounce=setTimeout(loadOpportunities,300)});$('remoteFilter').onchange=loadOpportunities;$('clearFilters').onclick=()=>{$('searchInput').value='';$('typeFilter').value='';$('countryFilter').value='';$('remoteFilter').checked=false;void loadOpportunities()};$('refreshButton').onclick=()=>Promise.all([loadStats(),loadOpportunities()]);$('profileForm').onsubmit=saveProfile;document.querySelectorAll('.nav-item').forEach(el=>el.onclick=()=>showView(el.dataset.view));
  $('authButton').onclick=async()=>{if(state.session){try{await api('/api/auth/logout',{method:'POST',body:'{}'});state.session=null;toast('Signed out.');await loadSession();showView('discover');await loadOpportunities();}catch(e){toast(e.message)}}else{await signIn()}};

  (async()=>{try{state.config=await api('/api/config');await finishSignIn();await loadSession();await Promise.all([loadStats(),loadOpportunities()]);}catch(e){toast(e.message);await loadSession();await Promise.all([loadStats(),loadOpportunities()]);}})();
})();
