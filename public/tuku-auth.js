(() => {
  const $ = (sel, root = document) => root.querySelector(sel);
  let mode = 'signin';

  function api(path, options = {}) {
    return fetch(path, {
      credentials: 'same-origin',
      ...options,
      headers: { Accept: 'application/json', ...(options.body ? {'content-type':'application/json'} : {}), ...(options.headers || {}) },
    }).then(async (r) => {
      const body = r.status === 204 ? null : await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(body?.error?.message || `Request failed (${r.status})`);
      return body?.data ?? body;
    });
  }

  function ensureUi() {
    if ($('#tukuAuthDialog')) return;
    document.body.insertAdjacentHTML('beforeend', `
      <dialog id="tukuAuthDialog" class="tuku-auth-dialog">
        <div class="tuku-auth-shell">
          <section class="tuku-auth-story">
            <div>
              <div class="tuku-auth-brand">R</div>
              <span class="tuku-auth-kicker">RADAR · TUKU AUTH</span>
              <h2>One account for opportunity work.</h2>
              <p>Use your Tuku identity to save opportunities, prepare applications, collaborate with teams and carry your profile across the Tuku estate.</p>
            </div>
            <div class="tuku-auth-points"><span>Single Tuku identity</span><span>Secure Radar session</span><span>Account recovery built in</span></div>
          </section>
          <section class="tuku-auth-panel">
            <button id="tukuAuthClose" class="tuku-auth-close" type="button" aria-label="Close">×</button>
            <div class="tuku-auth-tabs">
              <button type="button" data-mode="signin" class="active">Sign in</button>
              <button type="button" data-mode="signup">Create account</button>
            </div>
            <span class="tuku-auth-kicker">SECURED BY TUKU AUTH</span>
            <h2 id="tukuAuthHeading">Welcome back.</h2>
            <p id="tukuAuthIntro">Sign in without leaving Radar.</p>
            <form id="tukuAuthForm" class="tuku-auth-form">
              <label id="tukuAuthNameField" hidden>Your name<input id="tukuAuthName" autocomplete="name"></label>
              <label>Email<input id="tukuAuthEmail" type="email" autocomplete="email" required></label>
              <label><span>Password <button id="tukuAuthForgot" type="button">Forgot password?</button></span><input id="tukuAuthPassword" type="password" minlength="8" autocomplete="current-password" required></label>
              <div id="tukuAuthFeedback" class="tuku-auth-feedback" aria-live="polite"></div>
              <button id="tukuAuthSubmit" class="tuku-auth-submit" type="submit">Sign in to Radar</button>
            </form>
            <div class="tuku-auth-security">Your password is handled by Tuku Auth. Radar receives only the identity and workspace context needed to operate this product.</div>
          </section>
        </div>
      </dialog>
      <dialog id="tukuResetDialog" class="tuku-auth-dialog tuku-reset-dialog">
        <section class="tuku-auth-panel tuku-reset-card">
          <button id="tukuResetClose" class="tuku-auth-close" type="button" aria-label="Close">×</button>
          <span class="tuku-auth-kicker">ACCOUNT RECOVERY</span>
          <h2>Choose a new password.</h2>
          <form id="tukuResetForm" class="tuku-auth-form">
            <label>New password<input id="tukuResetPassword" type="password" minlength="8" autocomplete="new-password" required></label>
            <label>Confirm password<input id="tukuResetConfirm" type="password" minlength="8" autocomplete="new-password" required></label>
            <div id="tukuResetFeedback" class="tuku-auth-feedback"></div>
            <button class="tuku-auth-submit" type="submit">Update password</button>
          </form>
        </section>
      </dialog>
    `);
    $('#tukuAuthClose').onclick = () => $('#tukuAuthDialog').close();
    $('#tukuResetClose').onclick = () => $('#tukuResetDialog').close();
    document.querySelectorAll('#tukuAuthDialog [data-mode]').forEach(btn => btn.onclick = () => setMode(btn.dataset.mode));
    $('#tukuAuthForm').onsubmit = submitAuth;
    $('#tukuAuthForgot').onclick = forgotPassword;
    $('#tukuResetForm').onsubmit = resetPassword;
  }

  function setMode(next) {
    mode = next === 'signup' ? 'signup' : 'signin';
    document.querySelectorAll('#tukuAuthDialog [data-mode]').forEach(btn => btn.classList.toggle('active', btn.dataset.mode === mode));
    $('#tukuAuthNameField').hidden = mode !== 'signup';
    $('#tukuAuthForgot').style.display = mode === 'signin' ? '' : 'none';
    $('#tukuAuthHeading').textContent = mode === 'signin' ? 'Welcome back.' : 'Start with one Tuku account.';
    $('#tukuAuthIntro').textContent = mode === 'signin' ? 'Sign in without leaving Radar.' : 'Create your Tuku account here and continue directly into Radar.';
    $('#tukuAuthSubmit').textContent = mode === 'signin' ? 'Sign in to Radar' : 'Create Tuku account';
    $('#tukuAuthFeedback').textContent = '';
    $('#tukuAuthPassword').autocomplete = mode === 'signin' ? 'current-password' : 'new-password';
  }

  function openAuth(next = 'signin') {
    ensureUi();
    setMode(next);
    const dialog = $('#tukuAuthDialog');
    if (!dialog.open) dialog.showModal();
  }

  async function submitAuth(event) {
    event.preventDefault();
    const feedback = $('#tukuAuthFeedback');
    const submit = $('#tukuAuthSubmit');
    const body = {
      mode,
      email: $('#tukuAuthEmail').value.trim(),
      password: $('#tukuAuthPassword').value,
      name: $('#tukuAuthName').value.trim(),
    };
    if (!body.email || body.password.length < 8 || (mode === 'signup' && body.name.length < 2)) {
      feedback.textContent = 'Complete the required details. Passwords need at least 8 characters.';
      return;
    }
    submit.disabled = true;
    submit.textContent = mode === 'signin' ? 'Signing in…' : 'Creating account…';
    feedback.textContent = '';
    try {
      const result = await api('/api/auth/credentials', {method:'POST', body:JSON.stringify(body)});
      if (result.verificationRequired) {
        feedback.textContent = 'Account created. Confirm your email, then sign in here.';
        setMode('signin');
        return;
      }
      feedback.textContent = 'Signed in. Opening Radar…';
      location.assign('/app');
    } catch (error) {
      feedback.textContent = error.message;
    } finally {
      submit.disabled = false;
      submit.textContent = mode === 'signin' ? 'Sign in to Radar' : 'Create Tuku account';
    }
  }

  async function forgotPassword() {
    const feedback = $('#tukuAuthFeedback');
    const email = $('#tukuAuthEmail').value.trim();
    if (!email) { feedback.textContent = 'Enter your email address first.'; return; }
    feedback.textContent = 'Sending reset link...';
    try {
      await api('/api/auth/forgot-password', {method:'POST', body:JSON.stringify({email})});
      feedback.textContent = 'If that Tuku account exists, a password reset link has been sent.';
    } catch (error) { feedback.textContent = error.message; }
  }

  async function resetPassword(event) {
    event.preventDefault();
    const params = new URLSearchParams(location.search);
    const recoveryToken = params.get('token') || params.get('recovery_token') || params.get('recoveryToken') || '';
    const password = $('#tukuResetPassword').value;
    const confirm = $('#tukuResetConfirm').value;
    const feedback = $('#tukuResetFeedback');
    if (!recoveryToken) { feedback.textContent = 'This reset link is incomplete or expired.'; return; }
    if (password.length < 8 || password !== confirm) { feedback.textContent = 'Use at least 8 characters and make sure both passwords match.'; return; }
    try {
      await api('/api/auth/reset-password', {method:'POST', body:JSON.stringify({recoveryToken, password})});
      feedback.textContent = 'Password updated. You can sign in now.';
      history.replaceState({}, '', '/app');
      setTimeout(() => { $('#tukuResetDialog').close(); openAuth('signin'); }, 450);
    } catch (error) { feedback.textContent = error.message; }
  }

  document.addEventListener('click', (event) => {
    const auth = event.target.closest('#authButton');
    if (!auth) return;
    if (/sign out/i.test(auth.textContent || '')) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    openAuth('signin');
  }, true);

  document.addEventListener('DOMContentLoaded', () => {
    ensureUi();
    const params = new URLSearchParams(location.search);
    if (params.get('reset_password') === '1' || params.get('token') || params.get('recovery_token') || params.get('recoveryToken')) {
      $('#tukuResetDialog').showModal();
    }
  });

  window.RadarTukuAuth = { open: openAuth };
})();
