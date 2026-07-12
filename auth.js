/**
 * GIOLYNK - Authentication Module
 * Handles login, registration, password reset, Google OAuth, and auth state.
 * Uses Firebase compat SDK via window.Firebase references.
 */
(function () {
  'use strict';

  // ── State ─────────────────────────────────────────────────────────────────
  let _currentUser = null;   // Firestore user doc (not just Firebase auth user)
  let _authUser = null;      // Firebase auth user object
  let _rememberMe = false;

  // ── DOM references (cached on init) ───────────────────────────────────────
  let els = {};

  function cacheDOM() {
    els = {
      authContainer:      document.getElementById('auth-container'),
      appShell:           document.getElementById('app-shell'),
      splashScreen:       document.getElementById('splash-screen'),
      onboardingContainer:document.getElementById('onboarding-container'),

      // Screens
      loginScreen:        document.getElementById('login-screen'),
      registerScreen:     document.getElementById('register-screen'),
      forgotScreen:       document.getElementById('forgot-screen'),

      // Login form
      loginForm:          document.getElementById('login-form'),
      loginEmail:         document.getElementById('login-email'),
      loginPassword:      document.getElementById('login-password'),
      loginBtn:           document.getElementById('login-btn'),
      rememberMe:         document.getElementById('remember-me'),

      // Register form
      registerForm:       document.getElementById('register-form'),
      regFirstname:       document.getElementById('reg-firstname'),
      regLastname:        document.getElementById('reg-lastname'),
      regEmail:           document.getElementById('reg-email'),
      regPassword:        document.getElementById('reg-password'),
      regConfirm:         document.getElementById('reg-confirm'),
      agreeTerms:         document.getElementById('agree-terms'),
      registerBtn:        document.getElementById('register-btn'),
      passwordStrength:   document.getElementById('password-strength'),

      // Forgot password form
      forgotForm:         document.getElementById('forgot-form'),
      forgotEmail:        document.getElementById('forgot-email'),
      forgotBtn:          document.getElementById('forgot-btn'),

      // Google buttons
      googleLoginBtn:     document.getElementById('google-login-btn'),
      googleRegisterBtn:  document.getElementById('google-register-btn'),

      // Navigation links
      forgotPasswordLink: document.getElementById('forgot-password-link'),
      showRegister:       document.getElementById('show-register'),
      showLogin:          document.getElementById('show-login'),
      backToLogin:        document.getElementById('back-to-login'),
      backToLoginForgot:  document.getElementById('back-to-login-forgot'),
      backToLoginLink:    document.getElementById('back-to-login-link')
    };
  }

  // ── Helpers ───────────────────────────────────────────────────────────────

  function showScreen(screenEl) {
    [els.loginScreen, els.registerScreen, els.forgotScreen].forEach(s => {
      if (s) s.classList.add('hidden');
    });
    if (screenEl) screenEl.classList.remove('hidden');
  }

  function showAuth() {
    if (els.authContainer) els.authContainer.classList.remove('hidden');
    if (els.appShell) els.appShell.classList.add('hidden');
    if (els.onboardingContainer) els.onboardingContainer.classList.add('hidden');
  }

  function hideAuth() {
    if (els.authContainer) els.authContainer.classList.add('hidden');
  }

  function showApp() {
    if (els.appShell) els.appShell.classList.remove('hidden');
    if (els.authContainer) els.authContainer.classList.add('hidden');
    if (els.onboardingContainer) els.onboardingContainer.classList.add('hidden');
    if (els.splashScreen) els.splashScreen.classList.add('hidden');
  }

  function showOnboarding() {
    if (els.onboardingContainer) els.onboardingContainer.classList.remove('hidden');
    if (els.authContainer) els.authContainer.classList.add('hidden');
    if (els.appShell) els.appShell.classList.add('hidden');
    if (els.splashScreen) els.splashScreen.classList.add('hidden');
  }

  function setButtonLoading(btn, loading) {
    if (!btn) return;
    const textEl = btn.querySelector('.btn-text');
    const loaderEl = btn.querySelector('.btn-loader');
    if (textEl) textEl.classList.toggle('hidden', loading);
    if (loaderEl) loaderEl.classList.toggle('hidden', !loading);
    btn.disabled = loading;
  }

  // ── Password Strength Meter ───────────────────────────────────────────────

  function evaluatePasswordStrength(password) {
    const checks = {
      length:      password.length >= 8,
      uppercase:   /[A-Z]/.test(password),
      lowercase:   /[a-z]/.test(password),
      number:      /\d/.test(password),
      specialChar: /[^A-Za-z0-9]/.test(password)
    };

    const score = Object.values(checks).filter(Boolean).length;

    let label = '';
    let color = '';
    let percent = 0;

    if (score <= 1)      { label = 'Weak';     color = '#e74c3c'; percent = 20; }
    else if (score === 2) { label = 'Fair';     color = '#e67e22'; percent = 40; }
    else if (score === 3) { label = 'Good';     color = '#f1c40f'; percent = 60; }
    else if (score === 4) { label = 'Strong';   color = '#2ecc71'; percent = 80; }
    else                  { label = 'Very Strong'; color = '#27ae60'; percent = 100; }

    return { checks, score, label, color, percent };
  }

  function updateStrengthMeter(password) {
    if (!els.passwordStrength) return;
    const fill = els.passwordStrength.querySelector('.strength-fill');
    const text = els.passwordStrength.querySelector('.strength-text');

    if (!password) {
      if (fill) fill.style.width = '0%';
      if (fill) fill.style.background = 'transparent';
      if (text) text.textContent = '';
      return;
    }

    const result = evaluatePasswordStrength(password);

    if (fill) {
      fill.style.width = result.percent + '%';
      fill.style.background = result.color;
    }
    if (text) {
      text.textContent = result.label;
      text.style.color = result.color;
    }
  }

  // ── Password Visibility Toggle ────────────────────────────────────────────

  function initPasswordToggles() {
    document.addEventListener('click', (e) => {
      const toggleBtn = e.target.closest('.toggle-password');
      if (!toggleBtn) return;

      const targetId = toggleBtn.dataset.target;
      if (!targetId) return;
      const input = document.getElementById(targetId);
      if (!input) return;

      const eyeIcon = toggleBtn.querySelector('.eye-icon');
      if (input.type === 'password') {
        input.type = 'text';
        if (eyeIcon) eyeIcon.textContent = '🙈';
      } else {
        input.type = 'password';
        if (eyeIcon) eyeIcon.textContent = '👁';
      }
    });
  }

  // ── Form Navigation ───────────────────────────────────────────────────────

  function initFormNavigation() {
    // Show register from login
    if (els.showRegister) {
      els.showRegister.addEventListener('click', (e) => {
        e.preventDefault();
        showScreen(els.registerScreen);
      });
    }

    // Show login from register
    if (els.showLogin) {
      els.showLogin.addEventListener('click', (e) => {
        e.preventDefault();
        showScreen(els.loginScreen);
      });
    }

    // Show forgot password from login
    if (els.forgotPasswordLink) {
      els.forgotPasswordLink.addEventListener('click', (e) => {
        e.preventDefault();
        showScreen(els.forgotScreen);
      });
    }

    // Back to login (register)
    if (els.backToLogin) {
      els.backToLogin.addEventListener('click', () => showScreen(els.loginScreen));
    }

    // Back to login (forgot)
    if (els.backToLoginForgot) {
      els.backToLoginForgot.addEventListener('click', () => showScreen(els.loginScreen));
    }

    // Back to login link (forgot)
    if (els.backToLoginLink) {
      els.backToLoginLink.addEventListener('click', (e) => {
        e.preventDefault();
        showScreen(els.loginScreen);
      });
    }
  }

  // ── Login Handler ─────────────────────────────────────────────────────────

  function handleLogin(e) {
    e.preventDefault();
    const email = els.loginEmail?.value.trim();
    const password = els.loginPassword?.value;

    if (!email || !password) {
      window.Utils?.showToast('Please fill in all fields.', 'warning');
      return;
    }

    _rememberMe = els.rememberMe?.checked || false;
    setButtonLoading(els.loginBtn, true);

    const persistence = firebase.auth.Auth.Persistence.SESSION;
    const authPromise = _rememberMe
      ? window.Firebase.auth.setPersistence(firebase.auth.Auth.Persistence.LOCAL).then(() => window.Firebase.auth.signInWithEmailAndPassword(email, password))
      : window.Firebase.auth.signInWithEmailAndPassword(email, password);

    authPromise
      .catch((err) => {
        console.error('[Auth] Login error:', err);
        const messages = {
          'auth/user-not-found':         'No account found with this email.',
          'auth/wrong-password':         'Incorrect password.',
          'auth/invalid-credential':     'Invalid email or password.',
          'auth/too-many-requests':      'Too many attempts. Please try again later.',
          'auth/invalid-email':          'Please enter a valid email address.',
          'auth/user-disabled':          'This account has been disabled.'
        };
        window.Utils?.showToast(messages[err.code] || err.message || 'Login failed.', 'error');
      })
      .finally(() => {
        setButtonLoading(els.loginBtn, false);
      });
  }

  // ── Register Handler ──────────────────────────────────────────────────────

  function handleRegister(e) {
    e.preventDefault();
    const firstName = els.regFirstname?.value.trim();
    const lastName  = els.regLastname?.value.trim();
    const email     = els.regEmail?.value.trim();
    const password  = els.regPassword?.value;
    const confirm   = els.regConfirm?.value;
    const agreed    = els.agreeTerms?.checked;

    // Validation
    if (!firstName || !lastName || !email || !password || !confirm) {
      window.Utils?.showToast('Please fill in all fields.', 'warning');
      return;
    }

    if (password.length < 8) {
      window.Utils?.showToast('Password must be at least 8 characters.', 'warning');
      return;
    }

    if (password !== confirm) {
      window.Utils?.showToast('Passwords do not match.', 'warning');
      return;
    }

    if (!window.Utils?.isValidEmail(email)) {
      window.Utils?.showToast('Please enter a valid email address.', 'warning');
      return;
    }

    if (!agreed) {
      window.Utils?.showToast('You must agree to the Terms of Service.', 'warning');
      return;
    }

    setButtonLoading(els.registerBtn, true);

    window.Firebase.auth.createUserWithEmailAndPassword(email, password)
      .then(async (cred) => {
        // Update display name in Firebase Auth
        const displayName = `${firstName} ${lastName}`;
        await cred.user.updateProfile({ displayName });

        // Create user document in Firestore
        const userDoc = {
          uid:               cred.user.uid,
          email:             email,
          firstName:         firstName,
          lastName:          lastName,
          displayName:       displayName,
          createdAt:         firebase.firestore.FieldValue.serverTimestamp(),
          schoolId:          null,
          role:              'student',
          interests:         [],
          avatarUrl:         null,
          bio:               '',
          username:          null,
          level:             1,
          xp:                0,
          coins:             0,
          badges:            [],
          achievements:      [],
          friendsCount:      0,
          postsCount:        0,
          isOnboarded:       false
        };

        await window.Firebase.db.collection('users').doc(cred.user.uid).set(userDoc);

        window.Utils?.showToast('Account created successfully!', 'success');
      })
      .catch((err) => {
        console.error('[Auth] Register error:', err);
        const messages = {
          'auth/email-already-in-use':  'An account with this email already exists.',
          'auth/weak-password':         'Password is too weak.',
          'auth/invalid-email':         'Please enter a valid email address.',
          'auth/too-many-requests':     'Too many attempts. Please try again later.',
          'auth/operation-not-allowed': 'Account creation is currently disabled.'
        };
        window.Utils?.showToast(messages[err.code] || err.message || 'Registration failed.', 'error');
      })
      .finally(() => {
        setButtonLoading(els.registerBtn, false);
      });
  }

  // ── Google OAuth ──────────────────────────────────────────────────────────

  function handleGoogleSignIn(e) {
    e.preventDefault();
    const provider = new firebase.auth.GoogleAuthProvider();
    provider.addScope('profile');
    provider.addScope('email');

    window.Firebase.auth.signInWithPopup(provider)
      .then(async (result) => {
        const user = result.user;
        const isNewUser = result.additionalUserInfo?.isNewUser;

        if (isNewUser) {
          // Split display name into first / last
          const parts = (user.displayName || '').split(' ');
          const firstName = parts[0] || '';
          const lastName = parts.slice(1).join(' ') || '';

          const userDoc = {
            uid:               user.uid,
            email:             user.email,
            firstName:         firstName,
            lastName:          lastName,
            displayName:       user.displayName || '',
            createdAt:         firebase.firestore.FieldValue.serverTimestamp(),
            schoolId:          null,
            role:              'student',
            interests:         [],
            avatarUrl:         user.photoURL || null,
            bio:               '',
            username:          null,
            level:             1,
            xp:                0,
            coins:             0,
            badges:            [],
            achievements:      [],
            friendsCount:      0,
            postsCount:        0,
            isOnboarded:       false
          };

          await window.Firebase.db.collection('users').doc(user.uid).set(userDoc);
        }

        window.Utils?.showToast('Signed in with Google!', 'success');
      })
      .catch((err) => {
        console.error('[Auth] Google sign-in error:', err);
        if (err.code !== 'auth/popup-closed-by-user' && err.code !== 'auth/cancelled-popup-request') {
          const messages = {
            'auth/popup-blocked':    'Pop-up was blocked. Please allow pop-ups for this site.',
            'auth/cancelled-popup-request': 'Sign-in was cancelled.',
            'auth/account-exists-with-different-credential': 'An account already exists with a different sign-in method.'
          };
          window.Utils?.showToast(messages[err.code] || err.message || 'Google sign-in failed.', 'error');
        }
      });
  }

  // ── Forgot Password ───────────────────────────────────────────────────────

  function handleForgotPassword(e) {
    e.preventDefault();
    const email = els.forgotEmail?.value.trim();

    if (!email) {
      window.Utils?.showToast('Please enter your email address.', 'warning');
      return;
    }

    if (!window.Utils?.isValidEmail(email)) {
      window.Utils?.showToast('Please enter a valid email address.', 'warning');
      return;
    }

    setButtonLoading(els.forgotBtn, true);

    window.Firebase.auth.sendPasswordResetEmail(email)
      .then(() => {
        window.Utils?.showToast('Password reset email sent! Check your inbox.', 'success');
        showScreen(els.loginScreen);
      })
      .catch((err) => {
        console.error('[Auth] Forgot password error:', err);
        const messages = {
          'auth/user-not-found':    'No account found with this email.',
          'auth/invalid-email':     'Please enter a valid email address.',
          'auth/too-many-requests': 'Too many attempts. Please try again later.'
        };
        window.Utils?.showToast(messages[err.code] || err.message || 'Failed to send reset email.', 'error');
      })
      .finally(() => {
        setButtonLoading(els.forgotBtn, false);
      });
  }

  // ── Sign Out ──────────────────────────────────────────────────────────────

  async function signOut() {
    try {
      // Delete FCM token on sign-out
      if (window.Firebase?.deleteFCMToken) {
        await window.Firebase.deleteFCMToken();
      }

      await window.Firebase.auth.signOut();

      // Clear local state
      _currentUser = null;
      _authUser = null;
      localStorage.removeItem('giolynk_user');
      sessionStorage.removeItem('giolynk_user');

      showAuth();
      showScreen(els.loginScreen);

      window.Utils?.showToast('Signed out successfully.', 'info');
    } catch (err) {
      console.error('[Auth] Sign-out error:', err);
      window.Utils?.showToast('Failed to sign out.', 'error');
    }
  }

  // ── Auth State Change Handler ─────────────────────────────────────────────

  function onAuthStateChanged(user) {
    // Hide splash screen regardless of outcome
    if (els.splashScreen) els.splashScreen.classList.add('hidden');

    if (!user) {
      // No authenticated user → show login
      _authUser = null;
      _currentUser = null;
      showAuth();
      showScreen(els.loginScreen);
      return;
    }

    // User is authenticated
    _authUser = user;

    // Fetch Firestore user document
    window.Firebase.db.collection('users').doc(user.uid).get()
      .then((doc) => {
        if (doc.exists) {
          _currentUser = { uid: doc.id, ...doc.data() };

          // Cache user data locally
          const storage = _rememberMe || localStorage.getItem('giolynk_user') ? localStorage : sessionStorage;
          storage.setItem('giolynk_user', JSON.stringify(_currentUser));

          // Check onboarding status
          if (!_currentUser.isOnboarded) {
            showOnboarding();
            // Dispatch event so app.js / onboarding logic can pick it up
            window.dispatchEvent(new CustomEvent('auth:onboardingRequired', { detail: _currentUser }));
          } else {
            showApp();
            window.dispatchEvent(new CustomEvent('auth:ready', { detail: _currentUser }));

            // Request notification permission (non-blocking)
            if (window.Firebase?.requestNotificationPermission) {
              window.Firebase.requestNotificationPermission().catch(() => {});
            }
          }
        } else {
          // Firestore doc missing (edge case) → treat as needing onboarding
          console.warn('[Auth] Firestore user doc missing for uid:', user.uid);
          _currentUser = null;
          showAuth();
        }
      })
      .catch((err) => {
        console.error('[Auth] Error fetching user doc:', err);
        // On network error, try loading from cache
        const cached = localStorage.getItem('giolynk_user') || sessionStorage.getItem('giolynk_user');
        if (cached) {
          try {
            _currentUser = JSON.parse(cached);
            if (_currentUser.isOnboarded) {
              showApp();
              window.dispatchEvent(new CustomEvent('auth:ready', { detail: _currentUser }));
            } else {
              showOnboarding();
            }
          } catch (_) {
            showAuth();
          }
        } else {
          showAuth();
        }
      });
  }

  // ── Initialization ────────────────────────────────────────────────────────

  function init() {
    cacheDOM();
    initPasswordToggles();
    initFormNavigation();

    // Bind form submit handlers
    if (els.loginForm)    els.loginForm.addEventListener('submit', handleLogin);
    if (els.registerForm) els.registerForm.addEventListener('submit', handleRegister);
    if (els.forgotForm)   els.forgotForm.addEventListener('submit', handleForgotPassword);

    // Google sign-in buttons
    if (els.googleLoginBtn)    els.googleLoginBtn.addEventListener('click', handleGoogleSignIn);
    if (els.googleRegisterBtn) els.googleRegisterBtn.addEventListener('click', handleGoogleSignIn);

    // Password strength meter
    if (els.regPassword) {
      els.regPassword.addEventListener('input', () => {
        updateStrengthMeter(els.regPassword.value);
      });
    }

    // Set auth persistence
    _rememberMe = localStorage.getItem('giolynk_user') !== null;
    if (els.rememberMe) els.rememberMe.checked = _rememberMe;

    // Listen for auth state changes
    window.Firebase.auth.onAuthStateChanged(onAuthStateChanged);
  }

  // ── Public API ────────────────────────────────────────────────────────────

  window.Auth = {
    init,
    signOut,
    getCurrentUser()  { return _currentUser; },
    getAuthUser()     { return _authUser; },
    setCurrentUser(u) { _currentUser = u; },
    showAuth,
    hideAuth,
    showOnboarding,
    showApp,
    showScreen,
    evaluatePasswordStrength,
    updateStrengthMeter
  };
})();