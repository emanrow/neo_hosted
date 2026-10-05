// Sign in, create an account, ask for a password reset, or set a new password
// from a reset link. One form, four modes, no framework.
//
//   /login                  sign in (switch to create)
//   /login?reset=<token>    choose a new password; the token came by email
//   /login?notice=<key>     a line to show first, e.g. after an expired link
(function () {
  'use strict';
  const form = document.getElementById('login-form');
  const error = document.getElementById('error');
  const notice = document.getElementById('notice');
  const submit = document.getElementById('submit');
  const switcher = document.getElementById('switch');
  const forgot = document.getElementById('forgot');
  const rows = { email: document.getElementById('email-row'), password: document.getElementById('password-row'), invite: document.getElementById('invite-row') };
  const password = document.getElementById('password');
  const passwordLabel = document.getElementById('password-label');
  const params = new URLSearchParams(location.search);
  const resetToken = params.get('reset') || '';

  const NOTICES = {
    'link-expired': 'That link has expired or was already used. Sign in to get a new one, or ask for a password reset.'
  };

  // what each mode shows, posts, and says
  const MODES = {
    signin: { fields: ['email', 'password'], submit: 'Sign in', switcher: 'Create an account', next: 'create', url: '/auth/login', passwordKind: 'current-password', passwordLabel: 'Password', forgot: true },
    create: { fields: ['email', 'password', 'invite'], submit: 'Create account', switcher: 'I already have an account', next: 'signin', url: '/auth/signup', passwordKind: 'new-password', passwordLabel: 'Password', forgot: false },
    forgot: { fields: ['email'], submit: 'Email me a reset link', switcher: 'Back to sign in', next: 'signin', url: '/auth/forgot', passwordKind: 'current-password', passwordLabel: 'Password', forgot: false },
    reset: { fields: ['password'], submit: 'Set new password', switcher: 'Back to sign in', next: 'signin', url: '/auth/reset', passwordKind: 'new-password', passwordLabel: 'New password', forgot: false }
  };
  let mode = resetToken ? 'reset' : 'signin';

  function say(text) {
    notice.textContent = text || '';
    notice.hidden = !text;
  }

  function setMode(next) {
    mode = next;
    const m = MODES[mode];
    Object.keys(rows).forEach((name) => { rows[name].hidden = !m.fields.includes(name); });
    form.email.required = m.fields.includes('email');
    password.required = m.fields.includes('password');
    password.autocomplete = m.passwordKind;
    passwordLabel.textContent = m.passwordLabel;
    submit.textContent = m.submit;
    switcher.textContent = m.switcher;
    forgot.parentElement.hidden = !m.forgot;
    error.textContent = '';
    submit.disabled = false;
    (m.fields.includes('email') ? form.email : password).focus();
  }
  switcher.addEventListener('click', () => setMode(MODES[mode].next));
  forgot.addEventListener('click', () => setMode('forgot'));

  function body() {
    return {
      email: form.email.value.trim(),
      password: form.password.value,
      invite: form.invite.value.trim(),
      token: resetToken
    };
  }

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    error.textContent = '';
    submit.disabled = true;
    const current = mode;
    try {
      const res = await fetch(MODES[current].url, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body()), credentials: 'same-origin'
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || !data.ok) throw new Error(data.error || 'Could not sign in');
      if (current === 'forgot') {
        setMode('signin');
        say('If that address has an account here, a reset link is on its way. Check your email.');
      } else if (data.confirm) {
        setMode('signin');
        say('Almost there. We sent a confirmation link to your email; open it to start writing.');
      } else {
        location.href = '/';
      }
    } catch (err) {
      error.textContent = err.message;
      submit.disabled = false;
    }
  });

  setMode(mode);
  if (params.get('notice') && NOTICES[params.get('notice')]) say(NOTICES[params.get('notice')]);
})();
