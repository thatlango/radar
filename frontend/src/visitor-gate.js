const CARD_SELECTOR = '.opportunity-card';

function findSignInButton() {
  return [...document.querySelectorAll('.topbar button')]
    .find((button) => button.textContent?.trim() === 'Sign in') || null;
}

function switchAuthModalToSignup() {
  let attempts = 0;
  const timer = window.setInterval(() => {
    const createAccount = [...document.querySelectorAll('.auth-modal .auth-link')]
      .find((button) => button.textContent?.includes('New to Radar? Create account'));
    if (createAccount) {
      createAccount.click();
      window.clearInterval(timer);
      return;
    }
    attempts += 1;
    if (attempts >= 20) window.clearInterval(timer);
  }, 25);
}

function openSignupGate() {
  const signIn = findSignInButton();
  if (!signIn) return;
  signIn.click();
  switchAuthModalToSignup();
}

document.addEventListener('click', (event) => {
  const card = event.target?.closest?.(CARD_SELECTOR);
  if (!card || !findSignInButton()) return;

  event.preventDefault();
  event.stopPropagation();
  event.stopImmediatePropagation();
  openSignupGate();
}, true);
