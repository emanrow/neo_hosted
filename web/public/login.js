// Sign in or create an account; one form, two modes. No framework.
(function () {
  'use strict';
  const form = document.getElementById('login-form');
  const error = document.getElementById('error');
  const submit = document.getElementById('submit');
  const switcher = document.getElementById('switch');
  const inviteRow = document.getElementById('invite-row');
  const password = document.getElementById('password');
  let creating = false;

  function setMode(create) {
    creating = create;
    inviteRow.hidden = !create;
    submit.textContent = create ? 'Create account' : 'Sign in';
    switcher.textContent = create ? 'I already have an account' : 'Create an account';
    password.autocomplete = create ? 'new-password' : 'current-password';
    error.textContent = '';
  }
  switcher.addEventListener('click', () => setMode(!creating));

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    error.textContent = '';
    submit.disabled = true;
    const body = {
      email: form.email.value.trim(),
      password: form.password.value,
      invite: form.invite.value.trim()
    };
    try {
      const res = await fetch(creating ? '/auth/signup' : '/auth/login', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), credentials: 'same-origin'
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || !data.ok) throw new Error(data.error || 'Could not sign in');
      location.href = '/';
    } catch (err) {
      error.textContent = err.message;
      submit.disabled = false;
    }
  });
})();
