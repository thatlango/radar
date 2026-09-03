import React, { useEffect, useMemo, useState } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import {
  Search, SlidersHorizontal, Sparkles, Bell, Bookmark, BookmarkCheck, BriefcaseBusiness,
  Files, ChartNoAxesCombined, UserRound, CreditCard, LogOut, Plus, ArrowUpRight, MapPin,
  Clock3, ShieldCheck, CircleDollarSign, UsersRound, MessageSquareText, WandSparkles,
  CheckCircle2, ChevronRight, RefreshCw, X, Menu, Target, Layers3, FileCheck2, Send,
  Upload, Trash2, BrainCircuit, CircleGauge, CalendarDays, Globe2, Building2, Check,
  AlertTriangle, ChevronDown, ExternalLink, LoaderCircle, Mail, Phone, LockKeyhole
} from 'lucide-react';
import { api, deadlineLabel, fmtDate, fmtDateTime, money, statusLabel, fileToBase64, list } from './api';

const VIEW_META = {
  discover: { label: 'Discovery', icon: Search },
  workspace: { label: 'Workspaces', icon: Layers3 },
  applications: { label: 'Applications', icon: BriefcaseBusiness },
  documents: { label: 'Documents', icon: Files },
  analytics: { label: 'Analytics', icon: ChartNoAxesCombined },
  profile: { label: 'Profile', icon: UserRound },
  subscription: { label: 'Plans', icon: CreditCard },
};

const CARD_TONES = ['peach', 'mint', 'lavender', 'sky', 'rose', 'sand'];
const spring = { type: 'spring', stiffness: 310, damping: 30 };

function cx(...parts) { return parts.filter(Boolean).join(' '); }
function safeUrl(value) { try { const u = new URL(String(value)); return ['https:', 'http:'].includes(u.protocol) ? u.toString() : ''; } catch { return ''; } }
function fitClass(score) { if (score == null) return 'neutral'; if (score >= 80) return 'excellent'; if (score >= 65) return 'good'; return 'watch'; }
function opportunityValue(row) {
  if (row?.valueMin != null || row?.valueMax != null) {
    const currency = row.currency || 'USD';
    const fmt = (v) => new Intl.NumberFormat(undefined, { style: 'currency', currency, maximumFractionDigits: 0 }).format(Number(v));
    if (row.valueMin != null && row.valueMax != null) return `${fmt(row.valueMin)}–${fmt(row.valueMax)}`;
    return fmt(row.valueMin ?? row.valueMax);
  }
  return row?.compensation || '';
}
function trustLabel(row) {
  if (row?.sourceStatus === 'expired') return ['Expired', 'danger'];
  if (row?.verificationStatus === 'needs_review' || row?.sourceStatus === 'stale') return ['Needs re-check', 'warn'];
  return [Number(row?.sourceCount || 1) > 1 ? `${row.sourceCount} sources` : 'Verified', 'success'];
}
function eligibilityStatusLabel(status) {
  return ({ met: 'Met', likely_met: 'Likely met', missing_evidence: 'Evidence needed', not_met: 'Not met', partner_solvable: 'Partner-solvable' })[status] || 'Review';
}
function decisionAssessment(row) {
  if (!row || row.fitScore == null) return null;
  const evidence = row.fitEvidence || {};
  const hard = Array.isArray(evidence.hardConstraints) ? evidence.hardConstraints : [];
  const missing = Array.isArray(evidence.missingRequirements) ? evidence.missingRequirements : [];
  const specialist = Array.isArray(evidence.specialistNeeds) ? evidence.specialistNeeds : [];
  const matches = Array.isArray(evidence.keySkillMatches) ? evidence.keySkillMatches : [];
  const fit = Math.max(0, Math.min(100, Number(row.fitScore || 0)));
  const confidence = Math.max(0, Math.min(100, Math.round(Number(evidence.confidence ?? .5) * 100)));
  const eligibility = Math.max(0, Math.min(100, 96 - hard.length * 32 - missing.length * 7));
  const evidenceStrength = Math.max(10, Math.min(100, 58 + matches.length * 6 - missing.length * 10 - hard.length * 8));
  const days = row.deadline ? Math.ceil((new Date(row.deadline).getTime() - Date.now()) / 86400000) : null;
  const deadlineFeasibility = days == null ? 78 : days < 0 ? 0 : days <= 2 ? 28 : days <= 5 ? 52 : days <= 10 ? 72 : days <= 30 ? 90 : 84;
  const score = Math.round(fit * .40 + eligibility * .23 + evidenceStrength * .14 + deadlineFeasibility * .13 + confidence * .10);
  let label = 'CONSIDER';
  if (hard.length >= 2 || score < 50 || deadlineFeasibility === 0) label = 'SKIP';
  else if (!hard.length && score >= 72 && eligibility >= 70) label = 'PURSUE';
  const tone = label === 'PURSUE' ? 'pursue' : label === 'SKIP' ? 'skip' : 'consider';
  const effortPoints = missing.length + specialist.length * 2 + (days != null && days <= 7 ? 2 : 0) + (['tender','grant','consultancy'].includes(String(row.type || '').toLowerCase()) ? 2 : 0);
  const effort = effortPoints >= 7 ? 'High' : effortPoints >= 4 ? 'Medium' : 'Low';
  const primaryRisk = hard[0] || missing[0] || (days != null && days <= 5 ? `Only ${Math.max(0, days)} days remain` : null) || 'No major blocker identified from current evidence';
  const nextAction = hard[0]
    ? `Verify or resolve: ${hard[0]}`
    : missing[0]
      ? `Find evidence for: ${missing[0]}`
      : specialist[0]
        ? `Identify a specialist or partner for: ${specialist[0]}`
        : days != null && days <= 7
          ? 'Make the go/no-go decision today and start the application package.'
          : 'Review the source requirements and start the application workspace.';
  return { label, tone, score, fit: Math.round(fit), eligibility, evidenceStrength, deadlineFeasibility, confidence, effort, primaryRisk, nextAction };
}

function App() {
  const [view, setView] = useState('discover');
  const [mobileNav, setMobileNav] = useState(false);
  const [session, setSession] = useState(null);
  const [stats, setStats] = useState(null);
  const [opportunities, setOpportunities] = useState([]);
  const [selected, setSelected] = useState(null);
  const [opportunityLoading, setOpportunityLoading] = useState(true);
  const [priorityQueue, setPriorityQueue] = useState(null);
  const [filters, setFilters] = useState({ q: '', type: '', country: '', minValue: '', deadlineDays: '', verified: true, remote: false });
  const [workspaces, setWorkspaces] = useState([]);
  const [workspace, setWorkspace] = useState(null);
  const [readiness, setReadiness] = useState(null);
  const [activeDocId, setActiveDocId] = useState(null);
  const [applications, setApplications] = useState([]);
  const [documents, setDocuments] = useState([]);
  const [evidenceHealth, setEvidenceHealth] = useState(null);
  const [analytics, setAnalytics] = useState(null);
  const [profile, setProfile] = useState(null);
  const [capability, setCapability] = useState(null);
  const [briefing, setBriefing] = useState(null);
  const [catalog, setCatalog] = useState(null);
  const [subscription, setSubscription] = useState(null);
  const [annual, setAnnual] = useState(false);
  const [notifications, setNotifications] = useState([]);
  const [authOpen, setAuthOpen] = useState(false);
  const [authMode, setAuthMode] = useState('signin');
  const [aiOpen, setAiOpen] = useState(false);
  const [aiMessages, setAiMessages] = useState([{ role: 'assistant', text: 'Ask me about an opportunity, evidence gap, application package or next best action.' }]);
  const [toast, setToast] = useState('');
  const [busy, setBusy] = useState('');

  const notify = (text) => { setToast(text); window.clearTimeout(window.__radarToast); window.__radarToast = window.setTimeout(() => setToast(''), 3200); };
  const requireAuth = () => { if (session) return true; setAuthOpen(true); notify('Sign in to use this Radar action.'); return false; };

  async function loadSession() {
    try { setSession(await api('/api/session')); }
    catch { setSession(null); }
  }
  async function loadStats() { try { setStats(await api('/api/stats')); } catch { setStats(null); } }
  async function loadOpportunities(next = filters) {
    setOpportunityLoading(true);
    try {
      const p = new URLSearchParams();
      if (next.q?.trim()) p.set('q', next.q.trim());
      if (next.type) p.set('type', next.type);
      if (next.country?.trim()) p.set('country', next.country.trim());
      if (next.minValue) p.set('minValue', next.minValue);
      if (next.deadlineDays) p.set('deadlineDays', next.deadlineDays);
      if (next.verified) p.set('verified', 'true');
      if (next.remote) p.set('remote', 'true');
      p.set('limit', '60');
      const data = await api(`/api/opportunities?${p}`);
      setOpportunities(data.items || []);
    } catch (error) { notify(error.message); }
    finally { setOpportunityLoading(false); }
  }
  async function openOpportunity(id) {
    try { setSelected(await api(`/api/opportunities/${encodeURIComponent(id)}`)); }
    catch (error) { notify(error.message); }
  }

  useEffect(() => { loadSession(); loadStats(); loadOpportunities(); }, []);
  useEffect(() => { const timer = setTimeout(() => loadOpportunities(filters), 280); return () => clearTimeout(timer); }, [filters]);
  useEffect(() => {
    if (view === 'workspace' && session) loadWorkspaces();
    if (view === 'applications' && session) loadApplications();
    if (view === 'documents' && session) loadDocuments();
    if (view === 'analytics' && session) loadAnalytics();
    if (view === 'profile' && session) loadProfileBundle();
    if (view === 'subscription') loadPlans();
  }, [view, session]);
  useEffect(() => { if (session) { loadNotifications(); loadPriorityQueue(); } else setPriorityQueue(null); }, [session]);

  async function loadPriorityQueue() {
    try { setPriorityQueue(await api('/api/me/priority-queue')); }
    catch { setPriorityQueue(null); }
  }

  async function loadWorkspaces() {
    try { const data = await api('/api/me/workspaces'); setWorkspaces(data.items || []); }
    catch (error) { notify(error.message); }
  }
  async function openWorkspace(id) {
    try {
      const [data, gate] = await Promise.all([api(`/api/workspaces/${id}`), api(`/api/workspaces/${id}/readiness`)]);
      setWorkspace(data); setReadiness(gate); setActiveDocId(data.documents?.[0]?.id || null);
    } catch (error) { notify(error.message); }
  }
  async function startWorkspace() {
    if (!selected || !requireAuth()) return;
    setBusy('workspace-create');
    try {
      const data = selected.workspace?.id ? await api(`/api/workspaces/${selected.workspace.id}`) : await api(`/api/opportunities/${selected.id}/workspace`, { method: 'POST', body: '{}' });
      const gate = await api(`/api/workspaces/${data.id}/readiness`).catch(() => null);
      setWorkspace(data); setReadiness(gate); setActiveDocId(data.documents?.[0]?.id || null); setView('workspace'); await loadWorkspaces(); notify('Application workspace ready.');
    } catch (error) { notify(error.message); }
    finally { setBusy(''); }
  }
  async function refreshWorkspace() {
    if (!workspace) return;
    const [data, gate] = await Promise.all([api(`/api/workspaces/${workspace.id}`), api(`/api/workspaces/${workspace.id}/readiness`)]);
    setWorkspace(data); setReadiness(gate); await loadWorkspaces();
  }
  async function generatePlan() {
    if (!workspace) return;
    setBusy('workspace-plan');
    try { await api(`/api/workspaces/${workspace.id}/ai/plan`, { method: 'POST', body: '{}' }); await refreshWorkspace(); notify('Radar AI plan refreshed.'); }
    catch (error) { notify(error.message); } finally { setBusy(''); }
  }
  async function saveDocument(doc, content, status) {
    setBusy(`save-${doc.id}`);
    try { await api(`/api/workspaces/${workspace.id}/documents/${doc.id}`, { method: 'PATCH', body: JSON.stringify({ content, status }) }); await refreshWorkspace(); notify('Document version saved.'); }
    catch (error) { notify(error.message); } finally { setBusy(''); }
  }
  async function aiDraftDocument(doc) {
    const instruction = window.prompt('Optional instruction for this grounded draft:', '') ?? '';
    setBusy(`draft-${doc.id}`);
    try { await api(`/api/workspaces/${workspace.id}/documents/${doc.id}/ai-draft`, { method: 'POST', body: JSON.stringify({ instruction }) }); await refreshWorkspace(); notify('AI draft created for review.'); }
    catch (error) { notify(error.message); } finally { setBusy(''); }
  }
  async function aiReviewDocument(doc) {
    setBusy(`review-${doc.id}`);
    try { const data = await api(`/api/workspaces/${workspace.id}/documents/${doc.id}/ai-review`, { method: 'POST', body: '{}' }); notify(data.text || 'AI review complete.'); }
    catch (error) { notify(error.message); } finally { setBusy(''); }
  }
  async function addMember(email, role) {
    try { await api(`/api/workspaces/${workspace.id}/members`, { method: 'POST', body: JSON.stringify({ email, role }) }); await refreshWorkspace(); notify('Collaborator invited.'); }
    catch (error) { notify(error.message); }
  }
  async function addComment(body) {
    try { await api(`/api/workspaces/${workspace.id}/comments`, { method: 'POST', body: JSON.stringify({ body, documentId: activeDocId }) }); await refreshWorkspace(); }
    catch (error) { notify(error.message); }
  }
  async function finalizeWorkspace() {
    try { await api(`/api/workspaces/${workspace.id}/finalize`, { method: 'POST', body: '{}' }); await refreshWorkspace(); notify('Package marked ready.'); }
    catch (error) { notify(Array.isArray(error.details) ? `${error.message}: ${error.details.join(', ')}` : error.message); }
  }
  async function recordSubmission() {
    if (!window.confirm('Record this application as submitted? Radar will not submit to the external portal.')) return;
    try { await api(`/api/workspaces/${workspace.id}/submit`, { method: 'POST', body: JSON.stringify({ confirmation: true }) }); await refreshWorkspace(); await loadApplications(); notify('Submission recorded.'); }
    catch (error) { notify(error.message); }
  }

  async function loadApplications() { try { const data = await api('/api/me/applications'); setApplications(data.items || []); } catch (error) { notify(error.message); } }
  async function saveApplication(status, notes = '') {
    if (!selected || !requireAuth()) return;
    try { await api(`/api/opportunities/${selected.id}/applications`, { method: 'POST', body: JSON.stringify({ status, notes }) }); notify('Application pipeline updated.'); }
    catch (error) { notify(error.message); }
  }
  async function toggleSave() {
    if (!selected || !requireAuth()) return;
    try {
      const result = selected.saved ? await api(`/api/opportunities/${selected.id}/save`, { method: 'DELETE' }) : await api(`/api/opportunities/${selected.id}/save`, { method: 'POST', body: '{}' });
      setSelected((old) => ({ ...old, saved: result.saved })); notify(result.saved ? 'Saved to shortlist.' : 'Removed from shortlist.');
    } catch (error) { notify(error.message); }
  }
  async function runOpportunityAI(kind) {
    if (!selected || !requireAuth()) return;
    setBusy(`opp-${kind}`);
    try {
      const data = await api(`/api/opportunities/${selected.id}/${kind}`, { method: 'POST', body: '{}' });
      setSelected((old) => {
        const next = { ...old, aiResult: data.explanation || data.text || 'Analysis complete.', fitScore: data.fitScore ?? old.fitScore };
        if (kind === 'eligibility') {
          next.eligibilityResult = data;
          next.fitEvidence = {
            ...(old.fitEvidence || {}),
            explanation: data.explanation || old.fitEvidence?.explanation || '',
            keySkillMatches: data.keySkillMatches || old.fitEvidence?.keySkillMatches || [],
            missingRequirements: data.missingRequirements || old.fitEvidence?.missingRequirements || [],
            hardConstraints: data.hardConstraints || old.fitEvidence?.hardConstraints || [],
            specialistNeeds: data.specialistNeeds || old.fitEvidence?.specialistNeeds || [],
            confidence: data.confidence ?? old.fitEvidence?.confidence ?? .5,
          };
        }
        return next;
      });
    } catch (error) { notify(error.message); } finally { setBusy(''); }
  }

  async function loadDocuments() {
    try {
      const [data, health] = await Promise.all([api('/api/me/documents'), api('/api/me/evidence-health')]);
      setDocuments(data.items || []); setEvidenceHealth(health);
    } catch (error) { notify(error.message); }
  }
  async function addLibraryDocument(payload) {
    try { await api('/api/me/documents', { method: 'POST', body: JSON.stringify(payload) }); await loadDocuments(); notify('Golden document saved.'); }
    catch (error) { notify(error.message); }
  }
  async function deleteDocument(id) { if (!window.confirm('Delete this reusable document?')) return; try { await api(`/api/me/documents/${id}`, { method: 'DELETE' }); await loadDocuments(); } catch (error) { notify(error.message); } }
  async function extractEvidence(id) { try { await api(`/api/me/documents/${id}/ai/extract-evidence`, { method: 'POST', body: '{}' }); await loadDocuments(); notify('Reusable evidence extracted.'); } catch (error) { notify(error.message); } }
  async function loadAnalytics() { try { setAnalytics(await api('/api/me/analytics')); } catch (error) { notify(error.message); } }
  async function loadProfileBundle() {
    try {
      const [p, c, b] = await Promise.all([api('/api/me/profile'), api('/api/me/capability'), api('/api/me/briefing')]);
      setProfile(p); setCapability(c.capability || {}); setBriefing(b);
    } catch (error) { notify(error.message); }
  }
  async function saveProfile(payload) { try { const p = await api('/api/me/profile', { method: 'PUT', body: JSON.stringify(payload) }); setProfile(p); notify('Matching profile updated.'); await loadOpportunities(); } catch (error) { notify(error.message); } }
  async function saveCapability(payload) { try { const c = await api('/api/me/capability', { method: 'PUT', body: JSON.stringify(payload) }); setCapability(c.capability || {}); notify('Capability profile updated.'); await loadOpportunities(); } catch (error) { notify(error.message); } }
  async function saveBriefing(payload) { try { const b = await api('/api/me/briefing', { method: 'PUT', body: JSON.stringify(payload) }); setBriefing(b); notify('Daily Radar preferences saved.'); } catch (error) { notify(error.message); } }
  async function uploadResume(file) {
    if (!file) return; if (file.size > 5 * 1024 * 1024) return notify('CV files must be 5 MB or smaller.');
    try { const base64 = await fileToBase64(file); await api('/api/me/resume', { method: 'POST', body: JSON.stringify({ fileName: file.name, mimeType: file.type || 'application/pdf', base64 }) }); await loadProfileBundle(); notify('CV added to Radar.'); }
    catch (error) { notify(error.message); }
  }
  async function loadPlans() {
    try {
      const c = await api('/api/subscriptions/plans'); setCatalog(c);
      if (session) setSubscription(await api('/api/me/subscription'));
    } catch (error) { notify(error.message); }
  }
  async function checkout(planCode) {
    try { const data = await api('/api/subscriptions/checkout', { method: 'POST', body: JSON.stringify({ planCode }) }); if (data.checkoutUrl) location.assign(data.checkoutUrl); else notify(data.message || 'Checkout is not available yet.'); }
    catch (error) { notify(error.message); }
  }
  async function loadNotifications() { try { const data = await api('/api/me/notifications'); setNotifications(data.items || []); } catch {} }
  async function markAllRead() { try { await api('/api/me/notifications/read-all', { method: 'POST', body: '{}' }); await loadNotifications(); } catch {} }
  async function logout() { try { await api('/api/auth/logout', { method: 'POST', body: '{}' }); setSession(null); setView('discover'); notify('Signed out.'); } catch (error) { notify(error.message); } }
  async function askAI(message) {
    if (!requireAuth() || !message.trim()) return;
    setAiMessages((m) => [...m, { role: 'user', text: message }, { role: 'assistant', text: 'Thinking…', loading: true }]);
    try {
      const data = await api('/api/ai/chat', { method: 'POST', body: JSON.stringify({ message, workspaceId: workspace?.id || null, opportunityId: workspace ? null : selected?.id || null }) });
      setAiMessages((m) => [...m.filter((x) => !x.loading), { role: 'assistant', text: data.text || '' }]);
    } catch (error) { setAiMessages((m) => [...m.filter((x) => !x.loading), { role: 'assistant', text: error.message }]); }
  }

  const unread = notifications.filter((n) => !n.readAt).length;
  const trialDays = subscription?.basis === 'radar_trial' && subscription?.tukuAccess?.endsAt ? Math.max(0, Math.ceil((new Date(subscription.tukuAccess.endsAt).getTime() - Date.now()) / 86400000)) : null;

  return <div className="radar-app">
    <Sidebar view={view} setView={setView} session={session} mobileNav={mobileNav} setMobileNav={setMobileNav} trialDays={trialDays} />
    <div className="app-stage">
      <Topbar filters={filters} setFilters={setFilters} session={session} onAuth={() => setAuthOpen(true)} onLogout={logout} unread={unread} onNotifications={() => setView('profile')} onAI={() => setAiOpen(true)} onMobile={() => setMobileNav(true)} />
      <main className="page-stage">
        <AnimatePresence mode="wait">
          {view === 'discover' && <motion.div key="discover" {...pageMotion}><DiscoveryView stats={stats} opportunities={opportunities} loading={opportunityLoading} selected={selected} filters={filters} setFilters={setFilters} priorityQueue={priorityQueue} openOpportunity={openOpportunity} onClose={() => setSelected(null)} onSave={toggleSave} onAI={runOpportunityAI} onWorkspace={startWorkspace} onTrack={saveApplication} busy={busy} session={session} onAuth={() => setAuthOpen(true)} /></motion.div>}
          {view === 'workspace' && <motion.div key="workspace" {...pageMotion}><WorkspaceView session={session} workspaces={workspaces} workspace={workspace} readiness={readiness} openWorkspace={openWorkspace} activeDocId={activeDocId} setActiveDocId={setActiveDocId} generatePlan={generatePlan} saveDocument={saveDocument} aiDraftDocument={aiDraftDocument} aiReviewDocument={aiReviewDocument} addMember={addMember} addComment={addComment} finalizeWorkspace={finalizeWorkspace} recordSubmission={recordSubmission} busy={busy} onAuth={() => setAuthOpen(true)} /></motion.div>}
          {view === 'applications' && <motion.div key="applications" {...pageMotion}><ApplicationsView session={session} applications={applications} onAuth={() => setAuthOpen(true)} /></motion.div>}
          {view === 'documents' && <motion.div key="documents" {...pageMotion}><DocumentsView session={session} documents={documents} evidenceHealth={evidenceHealth} addDocument={addLibraryDocument} deleteDocument={deleteDocument} extractEvidence={extractEvidence} onAuth={() => setAuthOpen(true)} /></motion.div>}
          {view === 'analytics' && <motion.div key="analytics" {...pageMotion}><AnalyticsView session={session} analytics={analytics} onAuth={() => setAuthOpen(true)} /></motion.div>}
          {view === 'profile' && <motion.div key="profile" {...pageMotion}><ProfileView session={session} profile={profile} capability={capability} briefing={briefing} notifications={notifications} unread={unread} markAllRead={markAllRead} saveProfile={saveProfile} saveCapability={saveCapability} saveBriefing={saveBriefing} uploadResume={uploadResume} onAuth={() => setAuthOpen(true)} /></motion.div>}
          {view === 'subscription' && <motion.div key="subscription" {...pageMotion}><SubscriptionView catalog={catalog} subscription={subscription} annual={annual} setAnnual={setAnnual} checkout={checkout} session={session} onAuth={() => setAuthOpen(true)} /></motion.div>}
        </AnimatePresence>
      </main>
    </div>
    <AuthModal open={authOpen} setOpen={setAuthOpen} mode={authMode} setMode={setAuthMode} onSuccess={async () => { setAuthOpen(false); await loadSession(); notify('Welcome to Radar.'); }} notify={notify} />
    <AIDrawer open={aiOpen} setOpen={setAiOpen} messages={aiMessages} onAsk={askAI} context={workspace?.opportunity?.title || selected?.title || 'General Radar context'} />
    <AnimatePresence>{toast && <motion.div className="toast" initial={{ y: 40, opacity: 0 }} animate={{ y: 0, opacity: 1 }} exit={{ y: 20, opacity: 0 }}>{toast}</motion.div>}</AnimatePresence>
  </div>;
}

const pageMotion = { initial: { opacity: 0, y: 8 }, animate: { opacity: 1, y: 0 }, exit: { opacity: 0, y: -4 }, transition: { duration: .22 } };

function Sidebar({ view, setView, session, mobileNav, setMobileNav, trialDays }) {
  return <>
    <AnimatePresence>{mobileNav && <motion.button className="mobile-scrim" onClick={() => setMobileNav(false)} initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} />}</AnimatePresence>
    <aside className={cx('sidebar', mobileNav && 'open')}>
      <div className="brand-lockup"><div className="radar-mark"><span /><span /><i /></div><div><strong>RADAR</strong><small>Opportunity OS</small></div></div>
      <button className="new-search-btn" onClick={() => { setView('discover'); setMobileNav(false); }}><Plus size={18} /> New search</button>
      <nav>{Object.entries(VIEW_META).map(([key, item]) => { const Icon = item.icon; return <button key={key} className={cx('nav-button', view === key && 'active')} onClick={() => { setView(key); setMobileNav(false); }}><Icon size={18} /><span>{item.label}</span>{key === 'subscription' && trialDays != null && <em>{trialDays}d</em>}</button>; })}</nav>
      <div className="sidebar-fill" />
      <div className="sidebar-card"><Sparkles size={18} /><div><strong>{session ? 'Radar AI is ready' : 'Unlock your Radar'}</strong><small>{session ? 'Ask from any opportunity or workspace.' : 'Sign in to match and prepare applications.'}</small></div></div>
      <div className="sidebar-foot"><span className="pulse-dot" /> Verified opportunity feed</div>
    </aside>
  </>;
}

function Topbar({ filters, setFilters, session, onAuth, onLogout, unread, onNotifications, onAI, onMobile }) {
  return <header className="topbar">
    <button className="mobile-menu" onClick={onMobile}><Menu /></button>
    <div className="global-search"><Search size={19} /><input value={filters.q} onChange={(e) => setFilters((f) => ({ ...f, q: e.target.value }))} placeholder="Search opportunities, organisations, countries…" /></div>
    <div className="top-actions"><button className="icon-btn ai-btn" onClick={onAI}><Sparkles size={18} /></button><button className="icon-btn" onClick={onNotifications}><Bell size={18} />{unread > 0 && <b>{unread > 9 ? '9+' : unread}</b>}</button>{session ? <div className="account-pill"><div className="avatar">{(session.user?.name || session.user?.email || 'R').slice(0,1).toUpperCase()}</div><div><strong>{session.user?.name || 'Radar user'}</strong><small>{session.user?.email}</small></div><button onClick={onLogout}><LogOut size={16} /></button></div> : <button className="button dark" onClick={onAuth}>Sign in</button>}</div>
  </header>;
}

function PageTitle({ eyebrow, title, copy, action }) { return <div className="page-title"><div><span className="eyebrow">{eyebrow}</span><h1>{title}</h1><p>{copy}</p></div>{action}</div>; }
function StatCard({ icon: Icon, label, value, note, tone = 'navy' }) { return <motion.article className={cx('stat-card', tone)} whileHover={{ y: -3 }} transition={spring}><div className="stat-icon"><Icon size={18} /></div><div><span>{label}</span><strong>{value}</strong><small>{note}</small></div></motion.article>; }

function DiscoveryView({ stats, opportunities, loading, selected, filters, setFilters, priorityQueue, openOpportunity, onClose, onSave, onAI, onWorkspace, onTrack, busy, session, onAuth }) {
  return <div>
    <PageTitle eyebrow="Opportunity intelligence" title="Find work worth chasing." copy="A live, verified feed ranked around fit, timing and evidence—not an endless job board." action={<div className="hero-chip"><ShieldCheck size={17} /> Verified live feed</div>} />
    <div className="stats-row"><StatCard icon={Target} label="Live opportunities" value={Number(stats?.live || 0).toLocaleString()} note="currently open" tone="gold"/><StatCard icon={Globe2} label="Remote" value={Number(stats?.remote || 0).toLocaleString()} note="location-flexible" tone="teal"/><StatCard icon={Clock3} label="Closing soon" value={Number(stats?.closingSoon || 0).toLocaleString()} note="within 14 days" tone="pumpkin"/><StatCard icon={ShieldCheck} label="Active sources" value={Number(stats?.activeSources || 0).toLocaleString()} note="scanning now" tone="chartreuse"/></div>
    {session && <TodayQueue queue={priorityQueue} openOpportunity={openOpportunity} />}
    <div className="discovery-shell">
      <FilterRail filters={filters} setFilters={setFilters} />
      <section className="feed-column"><div className="section-bar"><div><h2>Recommended opportunities</h2><p>{loading ? 'Refreshing live feed…' : `${opportunities.length} current matches`}</p></div><button className="compact-btn" onClick={() => setFilters((f) => ({ ...f }))}><RefreshCw size={16}/> Refresh</button></div>{loading ? <CardSkeletons /> : <div className="opportunity-grid">{opportunities.map((row, i) => <OpportunityCard key={row.id} row={row} tone={CARD_TONES[i % CARD_TONES.length]} active={selected?.id === row.id} onClick={() => openOpportunity(row.id)} />)}</div>}</section>
      <OpportunityPanel row={selected} onClose={onClose} onSave={onSave} onAI={onAI} onWorkspace={onWorkspace} onTrack={onTrack} busy={busy} session={session} onAuth={onAuth} />
    </div>
  </div>;
}

function TodayQueue({ queue, openOpportunity }) {
  const items = queue?.items || [];
  if (!items.length) return null;
  const summary = queue?.summary || {};
  const kindLabel = { act_now: 'ACT NOW', application: 'APPLICATION', strong_match: 'STRONG MATCH', evidence_gap: 'UNLOCK' };
  return <section className="today-queue"><div className="today-head"><div><span className="eyebrow">Your Radar today</span><h2>What deserves attention now</h2></div><div className="today-summary"><span><strong>{summary.actNow || 0}</strong> urgent</span><span><strong>{summary.strongMatches || 0}</strong> strong matches</span><span><strong>{summary.evidenceGaps || 0}</strong> unlockable</span></div></div><div className="today-items">{items.slice(0,4).map((item) => <button key={`${item.kind}-${item.opportunity?.id}`} className={cx('today-item', item.urgency)} onClick={() => openOpportunity(item.opportunity?.id)}><span className="today-kind">{kindLabel[item.kind] || 'NEXT'}</span><strong>{item.opportunity?.title || item.title}</strong><p>{item.title}</p><small>{item.reason}</small><div><span>{item.action}</span><ArrowUpRight size={15}/></div></button>)}</div></section>;
}

function FilterRail({ filters, setFilters }) {
  const patch = (key, value) => setFilters((f) => ({ ...f, [key]: value }));
  return <aside className="filter-rail"><div className="filter-head"><div><SlidersHorizontal size={18}/><strong>Filters</strong></div><button onClick={() => setFilters({ q: '', type: '', country: '', minValue: '', deadlineDays: '', verified: true, remote: false })}>Reset</button></div>
    <label>Category<select value={filters.type} onChange={(e) => patch('type', e.target.value)}><option value="">All opportunities</option><option value="job">Jobs</option><option value="consultancy">Consulting</option><option value="tender">Tenders / RFPs</option><option value="grant">Grants</option><option value="fellowship">Fellowships</option><option value="internship">Internships</option></select></label>
    <label>Country or region<input value={filters.country} onChange={(e) => patch('country', e.target.value)} placeholder="Uganda, East Africa…" /></label>
    <label>Minimum stated value<input type="number" min="0" step="1000" value={filters.minValue} onChange={(e) => patch('minValue', e.target.value)} placeholder="0" /></label>
    <label>Closing within<select value={filters.deadlineDays} onChange={(e) => patch('deadlineDays', e.target.value)}><option value="">Any runway</option><option value="7">7 days</option><option value="14">14 days</option><option value="30">30 days</option><option value="60">60 days</option></select></label>
    <label className="checkline"><input type="checkbox" checked={filters.verified} onChange={(e) => patch('verified', e.target.checked)} /><span><Check size={13}/> Verified only</span></label>
    <label className="checkline"><input type="checkbox" checked={filters.remote} onChange={(e) => patch('remote', e.target.checked)} /><span><Globe2 size={13}/> Remote-friendly</span></label>
    <div className="filter-tip"><Sparkles size={16}/><p>Signed-in results are additionally ranked with your profile, capability and evidence gaps.</p></div>
  </aside>;
}

function OpportunityCard({ row, tone, active, onClick }) {
  const [trust, trustTone] = trustLabel(row); const value = opportunityValue(row); const decision = decisionAssessment(row);
  return <motion.button className={cx('opportunity-card', `tone-${tone}`, active && 'selected')} onClick={onClick} whileHover={{ y: -5, scale: 1.005 }} transition={spring} layout>
    <div className="card-topline"><span className={cx('trust-pill', trustTone)}><span />{trust}</span><div className="card-top-actions">{decision && <span className={cx('decision-mini', decision.tone)}>{decision.label}</span>}<span className="bookmark-dot" tabIndex={-1}>{row.saved ? <BookmarkCheck size={15}/> : <Bookmark size={15}/>}</span></div></div>
    <div className="card-company">{row.organization || 'Organisation not listed'}</div><h3>{row.title}</h3>
    <div className="card-tags">{row.type && <span>{row.type}</span>}{row.remote && <span>Remote</span>}{row.country && <span>{row.country}</span>}</div>
    <p>{row.summary || row.description || 'Open the opportunity for full details.'}</p>
    <div className="card-bottom"><div><strong>{value || deadlineLabel(row.deadline)}</strong><small>{value ? deadlineLabel(row.deadline) : row.country || 'Open location'}</small></div><div className={cx('fit-orb', fitClass(row.fitScore))}>{row.fitScore == null ? '—' : `${Math.round(row.fitScore)}%`}<small>fit</small></div></div>
  </motion.button>;
}
function CardSkeletons() { return <div className="opportunity-grid">{Array.from({ length: 6 }).map((_, i) => <div className="skeleton-card" key={i}><i/><i/><i/><i/></div>)}</div>; }

function OpportunityPanel({ row, onClose, onSave, onAI, onWorkspace, onTrack, busy, session, onAuth }) {
  useEffect(() => { if (!row) return undefined; const key = (event) => { if (event.key === 'Escape') onClose?.(); }; window.addEventListener('keydown', key); return () => window.removeEventListener('keydown', key); }, [row, onClose]);
  if (!row) return null;
  const [trust, trustTone] = trustLabel(row); const value = opportunityValue(row); const source = safeUrl(row.sourceUrl); const evidence = row.fitEvidence || {}; const decision = decisionAssessment(row);
  return <><motion.button className="detail-scrim" aria-label="Close opportunity details" onClick={onClose} initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}/><motion.aside className="opportunity-panel detail-drawer" initial={{ x: '100%' }} animate={{ x: 0 }} exit={{ x: '100%' }} transition={spring}><button className="drawer-close" onClick={onClose} aria-label="Close"><X size={18}/></button><div className="detail-scroll"><div className="detail-kicker"><span className={cx('trust-pill', trustTone)}><span />{trust}</span><span>{row.type || 'Opportunity'}</span></div><h2>{row.title}</h2><p className="detail-org"><Building2 size={15}/>{row.organization || 'Organisation'} · {row.country || 'Location not listed'}</p>
    {decision && <section className={cx('decision-scorecard', decision.tone)}>
      <div className="decision-lead"><div><span className="decision-kicker">RADAR DECISION</span><strong>{decision.label}</strong><small>{decision.score}/100 decision score</small></div><div className="decision-effort"><span>Prep effort</span><strong>{decision.effort}</strong></div></div>
      <div className="decision-dimensions"><div><span>Strategic fit</span><strong>{decision.fit}</strong></div><div><span>Eligibility</span><strong>{decision.eligibility}</strong></div><div><span>Evidence</span><strong>{decision.evidenceStrength}</strong></div><div><span>Runway</span><strong>{decision.deadlineFeasibility}</strong></div><div><span>Confidence</span><strong>{decision.confidence}</strong></div></div>
      <div className="decision-guidance"><div><span>Main risk</span><p>{decision.primaryRisk}</p></div><div><span>Next best action</span><p>{decision.nextAction}</p></div></div>
    </section>}
    <div className="detail-metrics"><div><CircleGauge/><strong>{row.fitScore == null ? '—' : `${Math.round(row.fitScore)}%`}</strong><small>fit score</small></div><div><CalendarDays/><strong>{deadlineLabel(row.deadline)}</strong><small>{fmtDate(row.deadline)}</small></div>{value && <div><CircleDollarSign/><strong>{value}</strong><small>stated value</small></div>}</div>
    <div className="detail-actions"><button className="button gold" onClick={onWorkspace} disabled={busy === 'workspace-create'}>{busy === 'workspace-create' ? <LoaderCircle className="spin"/> : <BriefcaseBusiness/>}{row.workspace ? 'Open workspace' : 'Start application'}</button><button className="button ghost" onClick={onSave}>{row.saved ? <BookmarkCheck/> : <Bookmark/>}{row.saved ? 'Saved' : 'Save'}</button></div>
    <div className="ai-action-grid"><button onClick={() => onAI('eligibility')} disabled={busy === 'opp-eligibility'}>{busy === 'opp-eligibility' ? <LoaderCircle className="spin"/> : <ShieldCheck/>}<span><strong>Check eligibility</strong><small>Met, gaps & blockers</small></span></button><button onClick={() => onAI('brief')} disabled={busy === 'opp-brief'}>{busy === 'opp-brief' ? <LoaderCircle className="spin"/> : <FileCheck2/>}<span><strong>Prepare brief</strong><small>Requirements + next action</small></span></button></div>
    {row.eligibilityResult?.requirements?.length > 0 && <section className="eligibility-matrix"><div className="eligibility-head"><div><ShieldCheck/><span><strong>Eligibility check</strong><small>{row.eligibilityResult.requirements.length} decision-critical requirements</small></span></div><span className={cx('decision-mini', row.eligibilityResult.decision === 'pursue' ? 'pursue' : row.eligibilityResult.decision === 'skip' ? 'skip' : 'consider')}>{String(row.eligibilityResult.decision || 'consider').toUpperCase()}</span></div><div className="eligibility-list">{row.eligibilityResult.requirements.map((item, i) => <article key={`${item.requirement}-${i}`}><span className={cx('eligibility-status', item.status)}>{eligibilityStatusLabel(item.status)}</span><div><strong>{item.requirement}</strong>{item.evidence && <p>{item.evidence}</p>}{item.action && <small>{item.action}</small>}</div></article>)}</div></section>}
    {row.aiResult && <div className="ai-result"><div><BrainCircuit size={17}/><strong>Radar AI</strong></div><p>{row.aiResult}</p></div>}
    {session && row.fitScore != null && <div className="evidence-grid"><div><span>Confidence</span><strong>{Math.round(Number(evidence.confidence ?? .5) * 100)}%</strong></div><div><span>Direct matches</span><strong>{(evidence.keySkillMatches || []).length}</strong></div><div><span>Evidence gaps</span><strong>{(evidence.missingRequirements || []).length}</strong></div></div>}
    {(evidence.hardConstraints || []).length > 0 && <InfoBox tone="warning" icon={AlertTriangle} title="Hard constraints" text={evidence.hardConstraints.join(' · ')} />}
    {(evidence.specialistNeeds || []).length > 0 && <InfoBox tone="teal" icon={UsersRound} title="Specialist gaps you could close" text={evidence.specialistNeeds.join(' · ')} />}
    <DetailSection title="Opportunity overview"><p>{row.description || row.summary || 'No description available.'}</p></DetailSection>{row.requirements && <DetailSection title="Technical requirements"><p>{row.requirements}</p></DetailSection>}
    <DetailSection title="Source confidence">{source ? <a className="source-link" href={source} target="_blank" rel="noreferrer"><ShieldCheck/><span><strong>{row.source || 'Original source'}</strong><small>Open verified listing</small></span><ExternalLink/></a> : <p>Source URL unavailable.</p>}</DetailSection>
    <div className="track-box"><strong>Application status</strong><div className="track-actions"><button onClick={() => session ? onTrack('planning') : onAuth()}>Planning</button><button onClick={() => session ? onTrack('applied') : onAuth()}>Applied</button><button onClick={() => session ? onTrack('interview') : onAuth()}>Interview</button></div></div>
  </div></motion.aside></>;
}
function DetailSection({ title, children }) { return <section className="detail-section"><h4>{title}</h4>{children}</section>; }
function InfoBox({ tone, icon: Icon, title, text }) { return <div className={cx('info-box', tone)}><Icon/><div><strong>{title}</strong><p>{text}</p></div></div>; }

function LockedState({ onAuth, title = 'Sign in to continue', copy = 'Radar uses your Tuku identity to keep application work private and personalised.' }) { return <div className="locked-state"><div><LockKeyhole/></div><h2>{title}</h2><p>{copy}</p><button className="button gold" onClick={onAuth}>Sign in to Radar</button></div>; }

function WorkspaceView(props) {
  if (!props.session) return <LockedState onAuth={props.onAuth} title="Your application workspaces live here" />;
  return <div><PageTitle eyebrow="Application operating system" title="Build stronger submissions." copy="Move from fit assessment to evidence, drafting, review and submission without losing context." action={<button className="button dark" onClick={props.generatePlan} disabled={!props.workspace || props.busy === 'workspace-plan'}><Sparkles/> Build AI plan</button>} />
    <div className="workspace-layout"><aside className="workspace-list"><div className="section-bar"><div><h2>Active work</h2><p>{props.workspaces.length} workspaces</p></div></div>{props.workspaces.length ? props.workspaces.map((w) => <button className={cx('workspace-list-card', props.workspace?.id === w.id && 'active')} key={w.id} onClick={() => props.openWorkspace(w.id)}><div><strong>{w.opportunity?.title || w.name}</strong><small>{w.opportunity?.organization || ''}</small></div><span>{w.progress || 0}%</span><div className="mini-progress"><i style={{ width: `${Math.max(0, Math.min(100, Number(w.progress || 0)))}%` }}/></div><small>{deadlineLabel(w.submissionDeadline || w.opportunity?.deadline)}</small></button>) : <div className="mini-empty">Start an application from Discovery.</div>}</aside>
      <WorkspaceCanvas {...props}/></div></div>;
}
function WorkspaceCanvas({ workspace, readiness, activeDocId, setActiveDocId, generatePlan, saveDocument, aiDraftDocument, aiReviewDocument, addMember, addComment, finalizeWorkspace, recordSubmission, busy }) {
  if (!workspace) return <section className="workspace-canvas empty-workspace"><Layers3/><h2>Open a workspace</h2><p>Select an active application to see its preparation plan, required documents, comments and submission state.</p></section>;
  const docs = workspace.documents || []; const active = docs.find((d) => d.id === activeDocId) || docs[0]; const role = workspace.accessRole || 'owner'; const canEdit = ['owner','editor'].includes(role); const canManage = role === 'owner';
  return <section className="workspace-canvas"><div className="workspace-hero"><div><span className="eyebrow">{workspace.opportunity?.type || 'Application'}</span><h2>{workspace.opportunity?.title || workspace.name}</h2><p>{workspace.opportunity?.organization || ''} · {workspace.opportunity?.country || ''}</p></div><div className="progress-ring"><strong>{workspace.progress || 0}%</strong><small>ready</small></div></div>
    <div className="stage-rail">{['Assess & plan','Draft & review','Ready','Submitted'].map((x,i) => <div key={x} className={cx(i <= Math.max(0,['drafting','review','ready','submitted'].indexOf(workspace.status)) && 'done')}><span>{i+1}</span><small>{x}</small></div>)}</div>
    <div className="workspace-grid"><div className="workspace-main"><SubmissionReadiness readiness={readiness}/><section className="surface-panel ai-plan-panel"><div className="panel-title"><div><Sparkles/><span><strong>Radar AI plan</strong><small>Grounded preparation strategy</small></span></div>{canEdit && <button onClick={generatePlan}>{busy === 'workspace-plan' ? <LoaderCircle className="spin"/> : <RefreshCw/>} Refresh</button>}</div>{workspace.aiPlan ? <p className="ai-plan-copy">{workspace.aiPlan}</p> : <div className="mini-empty">Generate a plan to identify constraints, evidence gaps, specialist needs, required documents and timeline.</div>}</section>
      <section className="surface-panel"><div className="panel-title"><div><Files/><span><strong>Required documents</strong><small>{docs.length} package items</small></span></div></div><div className="doc-tabs">{docs.map((d) => <button key={d.id} onClick={() => setActiveDocId(d.id)} className={cx(active?.id === d.id && 'active')}><span>{d.title}</span><small>{statusLabel(d.status)}</small></button>)}</div>{active && <DocumentEditor doc={active} canEdit={canEdit} onSave={saveDocument} onDraft={aiDraftDocument} onReview={aiReviewDocument} busy={busy}/>}</section>
    </div><aside className="workspace-side"><TeamPanel workspace={workspace} canManage={canManage} addMember={addMember} addComment={addComment}/><section className="surface-panel submission-card"><Send/><h3>Submission state</h3><p>Radar validates the package before it can be marked ready. External submission remains explicit and user-controlled.</p>{readiness && <div className={cx('submission-gate-pill', readiness.canFinalize ? 'ready' : 'blocked')}><strong>{readiness.score}%</strong><span>{readiness.canFinalize ? 'gate passed' : `${readiness.blockers?.length || 0} blockers`}</span></div>}<button className="button ghost" onClick={finalizeWorkspace} disabled={!canEdit || (readiness && !readiness.canFinalize)}>Finalize package</button><button className="button dark" onClick={recordSubmission} disabled={!canManage || workspace.status !== 'ready'}>Record submission</button></section></aside></div>
  </section>;
}
function SubmissionReadiness({ readiness }) {
  if (!readiness) return <section className="surface-panel readiness-panel loading"><LoaderCircle className="spin"/><div><strong>Checking submission readiness…</strong><small>Radar is validating the package.</small></div></section>;
  const blockers = readiness.blockers || []; const warnings = readiness.warnings || [];
  return <section className={cx('surface-panel', 'readiness-panel', readiness.canFinalize ? 'ready' : 'blocked')}><div className="readiness-head"><div><ShieldCheck/><span><small>SUBMISSION READINESS</small><strong>{readiness.canFinalize ? 'Ready to finalize' : 'Not ready yet'}</strong></span></div><div className="readiness-score"><strong>{readiness.score}%</strong><small>{readiness.status?.replaceAll('_',' ')}</small></div></div><div className="readiness-checks">{(readiness.checks || []).map((check) => <div key={check.label} className={check.passed ? 'passed' : 'failed'}>{check.passed ? <CheckCircle2/> : <AlertTriangle/>}<span>{check.label}</span></div>)}</div>{blockers.length > 0 && <div className="readiness-issues blockers"><strong>Resolve before finalizing</strong>{blockers.slice(0,5).map((item) => <p key={item.code}>{item.message}</p>)}</div>}{warnings.length > 0 && <div className="readiness-issues warnings"><strong>Review before submission</strong>{warnings.slice(0,4).map((item) => <p key={item.code}>{item.message}</p>)}</div>}</section>;
}
function DocumentEditor({ doc, canEdit, onSave, onDraft, onReview, busy }) {
  const [content, setContent] = useState(doc.content || ''); const [status, setStatus] = useState(doc.status || 'pending');
  useEffect(() => { setContent(doc.content || ''); setStatus(doc.status || 'pending'); }, [doc.id, doc.content, doc.status]);
  return <div className="document-editor"><div className="editor-head"><div><strong>{doc.title}</strong><small>Version {doc.version} · {doc.generatedByAi ? 'AI drafted' : 'Manual / pending'}</small></div><span className={cx('status-chip', doc.status)}>{statusLabel(doc.status)}</span></div><textarea value={content} onChange={(e) => setContent(e.target.value)} readOnly={!canEdit} placeholder="Draft content here…"/><div className="editor-actions">{canEdit && <><select value={status} onChange={(e) => setStatus(e.target.value)}><option value="pending">Pending</option><option value="drafting">Drafting</option><option value="review">Review</option><option value="approved">Approved</option><option value="complete">Complete</option></select><button className="button ghost" onClick={() => onSave(doc, content, status)}><FileCheck2/> Save version</button><button className="button gold" onClick={() => onDraft(doc)} disabled={busy === `draft-${doc.id}`}><WandSparkles/> AI autofill</button></>}<button className="button ghost" onClick={() => onReview(doc)}><BrainCircuit/> AI review</button></div></div>;
}
function TeamPanel({ workspace, canManage, addMember, addComment }) {
  const [email, setEmail] = useState(''); const [role, setRole] = useState('reviewer'); const [comment, setComment] = useState('');
  return <section className="surface-panel team-panel"><div className="panel-title"><div><UsersRound/><span><strong>Team review</strong><small>{workspace.members?.length || 0} collaborators</small></span></div></div><div className="member-stack">{(workspace.members || []).map((m) => <div key={m.id}><div className="mini-avatar">{(m.name || m.email || 'R').slice(0,1).toUpperCase()}</div><span><strong>{m.name || m.email}</strong><small>{m.role} · {m.status}</small></span></div>)}</div>{canManage && <div className="invite-row"><input value={email} onChange={(e) => setEmail(e.target.value)} placeholder="reviewer@example.com"/><select value={role} onChange={(e) => setRole(e.target.value)}><option value="reviewer">Reviewer</option><option value="editor">Editor</option><option value="viewer">Viewer</option></select><button onClick={() => { if(email.trim()) { addMember(email.trim(), role); setEmail(''); } }}><Plus/></button></div>}<div className="comments"><h4>Comments</h4>{(workspace.comments || []).slice(0,4).map((c) => <div className="comment" key={c.id}><strong>{c.authorName || 'Reviewer'}</strong><small>{fmtDateTime(c.createdAt)}</small><p>{c.body}</p></div>)}<div className="comment-input"><input value={comment} onChange={(e) => setComment(e.target.value)} placeholder="Add review comment…"/><button onClick={() => { if(comment.trim()) { addComment(comment.trim()); setComment(''); } }}><Send/></button></div></div></section>;
}

function ApplicationsView({ session, applications, onAuth }) {
  if (!session) return <LockedState onAuth={onAuth} title="Track every application outcome" />;
  const submitted = applications.filter((x) => ['applied','interview','offer','rejected'].includes(x.status)); const interviews = applications.filter((x) => x.status === 'interview'); const offers = applications.filter((x) => x.status === 'offer');
  return <div><PageTitle eyebrow="Outcome pipeline" title="Know what is moving." copy="A clean view of planning, submitted work and progression—so Radar can eventually learn what converts."/><div className="stats-row"><StatCard icon={BriefcaseBusiness} label="Tracked" value={applications.length} note="pipeline records" tone="navy"/><StatCard icon={Send} label="Submitted" value={submitted.length} note="recorded applications" tone="gold"/><StatCard icon={MessageSquareText} label="Interviews" value={interviews.length} note="progressed" tone="teal"/><StatCard icon={CheckCircle2} label="Offers" value={offers.length} note="positive outcomes" tone="chartreuse"/></div><div className="pipeline-board">{[['planning','Planning'],['applied','Submitted'],['progress','Progressed']].map(([key,label]) => { const rows = key === 'progress' ? applications.filter((x) => ['interview','offer'].includes(x.status)) : applications.filter((x) => x.status === key); return <section key={key}><div className="pipeline-head"><strong>{label}</strong><span>{rows.length}</span></div>{rows.map((x) => <article key={x.id}><span className={cx('status-chip', x.status)}>{statusLabel(x.status)}</span><h3>{x.opportunity?.title || 'Opportunity'}</h3><p>{x.opportunity?.organization || ''}</p><small>{x.notes || 'No notes yet.'}</small></article>)}</section>; })}</div></div>;
}

function DocumentsView({ session, documents, evidenceHealth, addDocument, deleteDocument, extractEvidence, onAuth }) {
  const [open, setOpen] = useState(false);
  if (!session) return <LockedState onAuth={onAuth} title="Build a reusable evidence library" />;
  return <div><PageTitle eyebrow="Reusable evidence" title="Evidence Vault." copy="Keep proof ready, see what your documents actually cover, and close recurring evidence gaps before the next deadline." action={<button className="button dark" onClick={() => setOpen(!open)}><Plus/> Add document</button>} />
    {evidenceHealth && <EvidenceHealthPanel health={evidenceHealth} />}
    {open && <DocumentForm onSubmit={async (p) => { await addDocument(p); setOpen(false); }}/>}<div className="document-library">{documents.map((d, i) => <motion.article key={d.id} className={cx('library-card', `tone-${CARD_TONES[i % CARD_TONES.length]}`)} whileHover={{ y: -4 }}><div className="library-icon"><Files/></div><div className="library-top"><span className="status-chip">{d.category}</span><button onClick={() => deleteDocument(d.id)}><Trash2/></button></div><h3>{d.title}</h3><p>{d.fileName || 'Stored text evidence'}</p><div className="library-meta"><span>{d.hasContent ? 'AI-ready' : 'Metadata only'}</span><span>{d.verificationStatus === 'machine_extracted' ? 'Evidence extracted' : d.verificationStatus === 'verified' ? 'Verified' : 'Needs extraction'}</span></div><button className="text-action" onClick={() => extractEvidence(d.id)}><Sparkles/> Extract reusable evidence <ChevronRight/></button></motion.article>)}{documents.length === 0 && <div className="empty-grid-card">No evidence documents yet. Add a CV, capability statement, reference, certificate or past proposal to make Radar's eligibility decisions stronger.</div>}</div></div>;
}
function EvidenceHealthPanel({ health }) {
  const t = health.totals || {}; const c = health.coverage || {}; const gaps = health.unresolvedGaps || [];
  return <section className="evidence-health"><div className="evidence-health-score"><CircleGauge/><div><span>Evidence readiness</span><strong>{health.score}%</strong><small>{health.score >= 75 ? 'Strong reusable evidence base' : health.score >= 50 ? 'Useful, but important proof is still missing' : 'Build the evidence base before high-value applications'}</small></div></div><div className="evidence-health-metrics"><div><span>AI-ready docs</span><strong>{t.aiReady || 0}</strong></div><div><span>Extracted</span><strong>{t.extracted || 0}</strong></div><div><span>Reusable claims</span><strong>{t.claims || 0}</strong></div><div><span>Tracked gaps</span><strong>{c.unresolved || 0}</strong></div></div><div className="evidence-gap-list"><div className="evidence-gap-head"><strong>Evidence Radar keeps seeing as missing</strong><small>{c.likelyCovered || 0} gaps already have likely supporting evidence</small></div>{gaps.length ? gaps.slice(0,4).map((gap, i) => <article key={`${gap.requirement}-${i}`}><div><span>{gap.occurrences}×</span><strong>{gap.requirement}</strong></div><small>{gap.opportunities?.[0]?.title ? `Appears in ${gap.opportunities[0].title}` : 'Recurring opportunity requirement'}</small></article>) : <div className="evidence-clear"><CheckCircle2/> No recurring unresolved evidence gaps detected in your current strong matches.</div>}</div></section>;
}
function DocumentForm({ onSubmit }) {
  const [form, setForm] = useState({ title: '', category: 'cv', content: '' }); const [file, setFile] = useState(null);
  return <form className="document-form" onSubmit={async (e) => { e.preventDefault(); const payload = { ...form }; if (file) { payload.fileName = file.name; payload.mimeType = file.type || 'application/pdf'; payload.base64 = await fileToBase64(file); } await onSubmit(payload); }}><label>Title<input required value={form.title} onChange={(e) => setForm({ ...form, title: e.target.value })} placeholder="Master CV 2026"/></label><label>Category<select value={form.category} onChange={(e) => setForm({ ...form, category: e.target.value })}><option value="cv">CV</option><option value="profile">Profile</option><option value="bio">Bio</option><option value="capability">Capability statement</option><option value="reference">Reference</option><option value="certificate">Certificate</option><option value="financial">Financial</option><option value="legal">Legal</option><option value="portfolio">Portfolio</option><option value="other">Other</option></select></label><label className="wide">Upload<input type="file" accept="application/pdf,text/plain,.pdf,.txt" onChange={(e) => setFile(e.target.files?.[0] || null)}/></label><label className="wide">Or paste text<textarea rows="5" value={form.content} onChange={(e) => setForm({ ...form, content: e.target.value })}/></label><button className="button gold">Save to library</button></form>;
}

function AnalyticsView({ session, analytics, onAuth }) {
  if (!session) return <LockedState onAuth={onAuth} title="Measure what is working" />;
  if (!analytics) return <div className="center-loader"><LoaderCircle className="spin"/></div>;
  const metrics = [['Average fit', analytics.quality?.averageFitScore == null ? '—' : `${analytics.quality.averageFitScore}%`, 'Across AI assessments'], ['Active workspaces', analytics.pipeline?.activeWorkspaces || 0, 'Packages being prepared'], ['Progression rate', `${analytics.outcomes?.progressionRate || 0}%`, 'Submitted → interview/offer'], ['Reusable docs', analytics.pipeline?.reusableDocuments || 0, 'Grounding assets'], ['Saved', analytics.pipeline?.saved || 0, 'Shortlisted opportunities'], ['Workspace progress', `${analytics.quality?.averageWorkspaceProgress || 0}%`, 'Average completion']];
  const statuses = analytics.pipeline?.byStatus || {}; const max = Math.max(1, ...Object.values(statuses).map(Number));
  return <div><PageTitle eyebrow="Performance analytics" title="See what converts." copy="Measure opportunity quality, preparation throughput and outcomes—not just how many listings Radar found."/><div className="analytics-grid">{metrics.map(([l,v,p],i) => <article key={l} className={cx('analytics-card', `tone-${CARD_TONES[i % CARD_TONES.length]}`)}><span>{l}</span><strong>{v}</strong><p>{p}</p></article>)}</div><section className="surface-panel analytics-panel"><div className="panel-title"><div><ChartNoAxesCombined/><span><strong>Application pipeline distribution</strong><small>Current tracked outcomes</small></span></div></div><div className="bar-chart">{Object.entries(statuses).map(([k,v]) => <div key={k}><span>{statusLabel(k)}</span><div><i style={{ width: `${Math.round((Number(v)/max)*100)}%` }}/></div><strong>{v}</strong></div>)}</div></section></div>;
}

function ProfileView({ session, profile, capability, briefing, notifications, unread, markAllRead, saveProfile, saveCapability, saveBriefing, uploadResume, onAuth }) {
  if (!session) return <LockedState onAuth={onAuth} title="Build your matching context" />;
  if (!profile || !capability || !briefing) return <div className="center-loader"><LoaderCircle className="spin"/></div>;
  return <div><PageTitle eyebrow="Matching context" title="Make Radar know you." copy="Better profile evidence means sharper ranking, fewer false positives and more grounded AI drafting."/><div className="profile-layout"><ProfileForm initial={profile} onSave={saveProfile} uploadResume={uploadResume}/><CapabilityForm initial={capability} onSave={saveCapability}/><BriefingCard initial={briefing} onSave={saveBriefing}/><section className="settings-card notification-card"><div className="settings-head"><div><Bell/><span><strong>Notifications</strong><small>{unread} unread</small></span></div><button onClick={markAllRead}>Mark all read</button></div><div className="notification-list">{notifications.slice(0,8).map((n) => <article key={n.id} className={!n.readAt ? 'unread' : ''}><span/><div><strong>{n.title}</strong><p>{n.body}</p><small>{fmtDateTime(n.createdAt)}</small></div></article>)}{notifications.length === 0 && <div className="mini-empty">No Radar activity yet.</div>}</div></section></div></div>;
}
function ProfileForm({ initial, onSave, uploadResume }) {
  const p = initial.preferences || {}; const [form, setForm] = useState({ name: initial.name || '', phone: initial.phone || '', looking: p.whatLookingFor || '', profileType: p.profileType || 'individual', scanPreset: p.scanPreset || 'strong-fit-role', recruit: p.canRecruitSpecialists === true, skills: (initial.skills || []).join(', '), industries: (initial.industries || []).join(', '), types: (p.types || []).join(', '), countries: (p.countries || []).join(', '), regions: (p.regions || []).join(', '), remote: p.remote === true });
  return <form className="settings-card" onSubmit={(e) => { e.preventDefault(); onSave({ name: form.name, phone: form.phone, skills: list(form.skills), industries: list(form.industries), preferences: { ...p, whatLookingFor: form.looking, profileType: form.profileType, canRecruitSpecialists: form.recruit, scanPreset: form.scanPreset, types: list(form.types), countries: list(form.countries), regions: list(form.regions), remote: form.remote } }); }}><div className="settings-head"><div><UserRound/><span><strong>Opportunity profile</strong><small>Matching and drafting context</small></span></div></div><label>Name<input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })}/></label><label>What are you looking for?<textarea rows="4" value={form.looking} onChange={(e) => setForm({ ...form, looking: e.target.value })}/></label><div className="two-fields"><label>Searching as<select value={form.profileType} onChange={(e) => setForm({ ...form, profileType: e.target.value })}><option value="individual">Individual</option><option value="firm">Firm / organisation</option><option value="both">Both</option></select></label><label>Scan focus<select value={form.scanPreset} onChange={(e) => setForm({ ...form, scanPreset: e.target.value })}><option value="consulting-firm">Consulting & implementation</option><option value="strong-fit-role">Strong-fit roles</option><option value="innovation-entrepreneurship">Innovation & entrepreneurship</option></select></label></div><label>Skills<textarea rows="3" value={form.skills} onChange={(e) => setForm({ ...form, skills: e.target.value })}/></label><label>Industries / domains<textarea rows="3" value={form.industries} onChange={(e) => setForm({ ...form, industries: e.target.value })}/></label><div className="two-fields"><label>Countries<input value={form.countries} onChange={(e) => setForm({ ...form, countries: e.target.value })}/></label><label>Regions<input value={form.regions} onChange={(e) => setForm({ ...form, regions: e.target.value })}/></label></div><label className="switchline"><input type="checkbox" checked={form.recruit} onChange={(e) => setForm({ ...form, recruit: e.target.checked })}/><span>I can recruit specialists to close gaps</span></label><label className="switchline"><input type="checkbox" checked={form.remote} onChange={(e) => setForm({ ...form, remote: e.target.checked })}/><span>Prioritise remote opportunities</span></label><label>Phone / WhatsApp<input value={form.phone} onChange={(e) => setForm({ ...form, phone: e.target.value })}/></label><label className="file-drop"><Upload/><span><strong>{initial.resume?.uploaded ? initial.resume.fileName || 'CV uploaded' : 'Add a CV or profile'}</strong><small>PDF or TXT · up to 5MB</small></span><input type="file" accept="application/pdf,text/plain,.pdf,.txt" onChange={(e) => uploadResume(e.target.files?.[0])}/></label><button className="button dark">Save matching profile</button></form>;
}
function CapabilityForm({ initial, onSave }) {
  const [f,setF] = useState({ legalName: initial.legalName || '', registrationCountry: initial.registrationCountry || '', registrationNumber: initial.registrationNumber || '', yearsOperating: initial.yearsOperating ?? '', turnoverBand: initial.turnoverBand || '', sectors: (initial.sectors || []).join(', '), countries: (initial.countries || []).join(', '), donorExperience: (initial.donorExperience || []).join(', '), licences: (initial.licences || []).join(', '), referenceCount: initial.referenceCount || 0, profileType: initial.profileType || 'individual', canRecruitSpecialists: initial.canRecruitSpecialists === true });
  return <form className="settings-card" onSubmit={(e) => { e.preventDefault(); onSave({ ...f, yearsOperating: f.yearsOperating, sectors: list(f.sectors), countries: list(f.countries), donorExperience: list(f.donorExperience), licences: list(f.licences), referenceCount: Number(f.referenceCount || 0) }); }}><div className="settings-head"><div><ShieldCheck/><span><strong>Capability & credentials</strong><small>Eligibility intelligence</small></span></div></div><div className="two-fields"><label>Legal / trading name<input value={f.legalName} onChange={(e)=>setF({...f,legalName:e.target.value})}/></label><label>Registration country<input value={f.registrationCountry} onChange={(e)=>setF({...f,registrationCountry:e.target.value})}/></label></div><div className="two-fields"><label>Registration number<input value={f.registrationNumber} onChange={(e)=>setF({...f,registrationNumber:e.target.value})}/></label><label>Years operating<input type="number" value={f.yearsOperating} onChange={(e)=>setF({...f,yearsOperating:e.target.value})}/></label></div><label>Turnover / capacity band<input value={f.turnoverBand} onChange={(e)=>setF({...f,turnoverBand:e.target.value})}/></label><label>Sectors<textarea rows="3" value={f.sectors} onChange={(e)=>setF({...f,sectors:e.target.value})}/></label><label>Countries of operation<textarea rows="2" value={f.countries} onChange={(e)=>setF({...f,countries:e.target.value})}/></label><label>Donor / institutional experience<textarea rows="3" value={f.donorExperience} onChange={(e)=>setF({...f,donorExperience:e.target.value})}/></label><label>Licences / certifications<textarea rows="2" value={f.licences} onChange={(e)=>setF({...f,licences:e.target.value})}/></label><label className="switchline"><input type="checkbox" checked={f.canRecruitSpecialists} onChange={(e)=>setF({...f,canRecruitSpecialists:e.target.checked})}/><span>I can recruit specialists to close technical gaps</span></label><button className="button gold">Save capability profile</button></form>;
}
function BriefingCard({ initial, onSave }) {
  const p = initial.preferences || {}; const [f,setF] = useState({ enabled: p.dailyBriefEnabled === true, deliveryHour: Number(p.deliveryHour || 8), timezone: p.timezone || Intl.DateTimeFormat().resolvedOptions().timeZone || 'Africa/Kampala', minFitScore: Number(p.minFitScore ?? 60), minDaysToDeadline: Number(p.minDaysToDeadline ?? 7), email: p.emailBrief !== false, whatsapp: p.whatsappBrief === true, phone: initial.phone || '' });
  return <form className="settings-card briefing-card" onSubmit={(e)=>{e.preventDefault();onSave(f)}}><div className="settings-head"><div><CalendarDays/><span><strong>Daily Radar</strong><small>Opportunity briefing</small></span></div></div><label className="switchline"><input type="checkbox" checked={f.enabled} onChange={(e)=>setF({...f,enabled:e.target.checked})}/><span>Send a daily opportunity brief</span></label><div className="two-fields"><label>Delivery<select value={f.deliveryHour} onChange={(e)=>setF({...f,deliveryHour:Number(e.target.value)})}><option value="8">8:00 AM</option><option value="9">9:00 AM</option></select></label><label>Timezone<input value={f.timezone} onChange={(e)=>setF({...f,timezone:e.target.value})}/></label></div><div className="two-fields"><label>Minimum fit<select value={f.minFitScore} onChange={(e)=>setF({...f,minFitScore:Number(e.target.value)})}><option value="50">50% broad</option><option value="60">60% useful</option><option value="70">70% strong</option><option value="80">80% selective</option></select></label><label>Minimum runway<select value={f.minDaysToDeadline} onChange={(e)=>setF({...f,minDaysToDeadline:Number(e.target.value)})}><option value="3">3 days</option><option value="5">5 days</option><option value="7">7 days</option><option value="14">14 days</option></select></label></div><div className="channel-row"><label><input type="checkbox" checked={f.email} onChange={(e)=>setF({...f,email:e.target.checked})}/><Mail/> Email</label><label><input type="checkbox" checked={f.whatsapp} onChange={(e)=>setF({...f,whatsapp:e.target.checked})}/><Phone/> WhatsApp</label></div><button className="button dark">Save daily brief</button></form>;
}

function SubscriptionView({ catalog, subscription, annual, setAnnual, checkout, session, onAuth }) {
  const plans = catalog?.plans || []; const starter = plans.find((p)=>p.code==='starter'); const pro = plans.find((p)=>p.code === (annual ? 'radar-pro-annual' : 'radar-pro-monthly')); const enterprise = plans.find((p)=>p.code==='enterprise'); const trialDays = subscription?.basis==='radar_trial' && subscription?.tukuAccess?.endsAt ? Math.max(0,Math.ceil((new Date(subscription.tukuAccess.endsAt).getTime()-Date.now())/86400000)) : null;
  return <div><section className="pricing-hero"><span className="eyebrow">Radar plans</span><h1>Explore freely. Pay when Radar starts doing the heavy work.</h1><p>Every new user gets 30 days of Professional. Discovery and your stored work remain useful on Starter after the trial.</p><div className="trial-badges"><span><Sparkles/> 30-day Pro trial</span><span><Search/> Unlimited discovery</span><span><LockKeyhole/> Your work stays yours</span></div><div className="billing-toggle"><button className={!annual?'active':''} onClick={()=>setAnnual(false)}>Monthly</button><button className={annual?'active':''} onClick={()=>setAnnual(true)}>Annually <span>Save 21%</span></button></div></section>{subscription && <div className="current-plan"><div><span className="eyebrow">Current access</span><h3>{trialDays != null ? `Professional trial · ${trialDays} days left` : subscription.plan?.name || 'Starter'}</h3><p>{trialDays != null ? 'No card required. Your account falls back to Starter when the trial ends.' : subscription.tier === 'starter' ? 'Discovery, saving and basic tracking remain free.' : 'Paid access is managed through Tuku Core.'}</p></div><div className="usage-row"><span>AI drafts <b>{subscription.usage?.aiDrafts?.used || 0}{subscription.usage?.aiDrafts?.limit == null ? '' : ` / ${subscription.usage.aiDrafts.limit}`}</b></span><span>Workspaces <b>{subscription.usage?.workspaces?.used || 0}{subscription.usage?.workspaces?.limit == null ? '' : ` / ${subscription.usage.workspaces.limit}`}</b></span></div></div>}<div className="pricing-grid">{[starter,pro,enterprise].filter(Boolean).map((p)=> <PlanCard key={p.code} plan={p} annual={annual} featured={p.code.startsWith('radar-pro')} catalog={catalog} subscription={subscription} session={session} checkout={checkout} onAuth={onAuth}/>)}</div><div className="pricing-note"><ShieldCheck/><div><strong>Your work stays yours</strong><p>Trial expiry reduces new AI/workspace capacity; Radar does not delete saved opportunities, documents, workspaces or application history.</p></div></div></div>;
}
function PlanCard({ plan, featured, catalog, subscription, session, checkout, onAuth }) {
  const displayMinor = plan.code==='radar-pro-annual' ? plan.equivalentMonthlyMinor : plan.priceMinor; const suffix = plan.code==='enterprise' ? '' : plan.code==='radar-pro-annual' ? '/mo equivalent' : '/mo'; const current = subscription && ((subscription.tier==='starter'&&plan.code==='starter')||(subscription.tier==='professional'&&plan.code.startsWith('radar-pro'))||(subscription.tier==='enterprise'&&plan.code==='enterprise'));
  return <motion.article className={cx('plan-card', featured && 'featured')} whileHover={{ y:-6 }} transition={spring}>{featured && <span className="plan-ribbon">Most useful</span>}<span className="eyebrow">{plan.name.replace(' Annual','')}</span><div className="plan-price"><strong>{money(displayMinor,plan.currency)}</strong><small>{suffix}</small></div>{plan.code==='radar-pro-annual' && <p className="annual-note">Billed {money(plan.priceMinor,plan.currency)} annually.</p>}<p>{plan.description}</p><ul>{(plan.features || []).map((f)=><li key={f}><CheckCircle2/>{f}</li>)}</ul>{current ? <button className="button ghost" disabled>Current plan</button> : plan.code==='starter' ? <button className="button ghost" disabled>Always available</button> : plan.code==='enterprise' ? <button className="button dark" disabled>Contact Tuku-Tuku</button> : !session ? <button className="button gold" onClick={onAuth}>Start free trial</button> : !catalog?.checkoutAvailable ? <button className="button gold" disabled>Billing opening soon</button> : <button className="button gold" onClick={()=>checkout(plan.code)}>Upgrade to Professional</button>}</motion.article>;
}

function AuthModal({ open, setOpen, mode, setMode, onSuccess, notify }) {
  const [name,setName] = useState(''); const [email,setEmail] = useState(''); const [password,setPassword] = useState(''); const [loading,setLoading] = useState(false); const [forgot,setForgot] = useState(false);
  async function submit(e) { e.preventDefault(); setLoading(true); try { if (forgot) { await api('/api/auth/forgot-password',{method:'POST',body:JSON.stringify({email})}); notify('Password reset instructions sent if the account exists.'); setForgot(false); } else { const result = await api('/api/auth/credentials',{method:'POST',body:JSON.stringify({mode,email,password,name})}); if (result.verificationRequired) notify('Check your email to verify the account.'); else await onSuccess(); } } catch(error){ notify(error.message); } finally { setLoading(false); } }
  return <AnimatePresence>{open && <motion.div className="modal-layer" initial={{opacity:0}} animate={{opacity:1}} exit={{opacity:0}}><motion.div className="auth-modal" initial={{scale:.96,y:20,opacity:0}} animate={{scale:1,y:0,opacity:1}} exit={{scale:.98,y:10,opacity:0}}><button className="modal-close" onClick={()=>setOpen(false)}><X/></button><div className="auth-brand"><div className="radar-mark"><span/><span/><i/></div><strong>RADAR</strong></div><span className="eyebrow">Tuku account</span><h2>{forgot ? 'Reset your password' : mode==='signup' ? 'Start your 30-day trial.' : 'Welcome back.'}</h2><p>{forgot ? 'We will send a secure reset link through Tuku Auth.' : 'One account for Radar and the wider Tuku product estate.'}</p><form onSubmit={submit}>{!forgot && mode==='signup' && <label>Name<input required value={name} onChange={(e)=>setName(e.target.value)} placeholder="Your name"/></label>}<label>Email<input type="email" required value={email} onChange={(e)=>setEmail(e.target.value)} placeholder="you@example.com"/></label>{!forgot && <label>Password<input type="password" minLength="8" required value={password} onChange={(e)=>setPassword(e.target.value)} placeholder="At least 8 characters"/></label>}<button className="button gold" disabled={loading}>{loading ? <LoaderCircle className="spin"/> : null}{forgot ? 'Send reset link' : mode==='signup' ? 'Create account' : 'Sign in'}</button></form>{!forgot && <button className="auth-link" onClick={()=>setForgot(true)}>Forgot password?</button>}{forgot ? <button className="auth-link" onClick={()=>setForgot(false)}>Back to sign in</button> : <button className="auth-link" onClick={()=>setMode(mode==='signup'?'signin':'signup')}>{mode==='signup'?'Already have an account? Sign in':'New to Radar? Create account'}</button>}</motion.div></motion.div>}</AnimatePresence>;
}

function AIDrawer({ open, setOpen, messages, onAsk, context }) {
  const [message,setMessage] = useState('');
  return <AnimatePresence>{open && <><motion.button className="drawer-scrim" onClick={()=>setOpen(false)} initial={{opacity:0}} animate={{opacity:1}} exit={{opacity:0}}/><motion.aside className="ai-drawer" initial={{x:'100%'}} animate={{x:0}} exit={{x:'100%'}} transition={spring}><div className="drawer-head"><div><span className="eyebrow">Private intelligence</span><h2>Ask Radar AI</h2></div><button onClick={()=>setOpen(false)}><X/></button></div><div className="ai-context"><Target/><span>{context}</span></div><div className="chat-stream">{messages.map((m,i)=><div key={i} className={cx('chat-bubble',m.role,m.loading&&'loading')}>{m.loading && <LoaderCircle className="spin"/>}{m.text}</div>)}</div><form className="chat-form" onSubmit={(e)=>{e.preventDefault();const text=message.trim();if(!text)return;setMessage('');onAsk(text)}}><textarea rows="3" value={message} onChange={(e)=>setMessage(e.target.value)} placeholder="What should I do next?"/><button className="button gold"><Sparkles/> Ask Radar</button></form></motion.aside></>}</AnimatePresence>;
}

export default App;