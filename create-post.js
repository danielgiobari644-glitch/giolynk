'use strict';
/* GIOLYNK - Create Post Module */
window.CreatePost = {};

(function () {
  const db = () => window.Firebase.db;
  const auth = () => window.Firebase.auth;

  let _pollMode = false;
  let _mediaData = null;

  CreatePost.init = function () {
    const fab = document.getElementById('create-fab');
    const navCreate = document.getElementById('nav-create');
    const modal = document.getElementById('create-modal');
    const closeBtn = document.getElementById('close-create-modal');

    const openModal = (e) => {
      e?.stopPropagation();
      if (modal) modal.classList.remove('hidden');
      resetForm();
      renderCurrentUser();
    };

    const closeModal = () => {
      if (modal) modal.classList.add('hidden');
      resetForm();
    };

    if (fab) fab.addEventListener('click', openModal);
    if (navCreate) navCreate.addEventListener('click', openModal);
    if (closeBtn) closeBtn.addEventListener('click', closeModal);

    modal?.querySelector('.modal-backdrop')?.addEventListener('click', closeModal);

    document.addEventListener('openCreateModal', openModal);

    // Image button
    document.querySelector('[data-type="image"]')?.addEventListener('click', () => {
      document.getElementById('post-image-input').click();
    });

    // Poll button
    document.querySelector('[data-type="poll"]')?.addEventListener('click', function () {
      _pollMode = !_pollMode;
      const container = document.getElementById('poll-options-container');
      if (container) container.classList.toggle('hidden', !_pollMode);
      this.style.background = _pollMode ? 'var(--primary-bg)' : '';
    });

    // Add poll option
    document.getElementById('add-poll-option')?.addEventListener('click', function () {
      const container = document.getElementById('poll-options-container');
      if (!container) return;
      const inputs = container.querySelectorAll('.poll-option-input');
      if (inputs.length >= 6) { Utils.showToast('Maximum 6 options', 'warning'); return; }
      const input = document.createElement('input');
      input.type = 'text';
      input.className = 'poll-option-input';
      input.placeholder = 'Option ' + (inputs.length + 1);
      container.insertBefore(input, this);
    });

    // Image input change
    document.getElementById('post-image-input')?.addEventListener('change', async function () {
      const file = this.files[0];
      if (!file) return;
      if (file.size > 10 * 1024 * 1024) { Utils.showToast('Image too large (max 10MB)', 'error'); return; }
      try {
        const compressed = await Utils.compressImage(file, 1080, 0.8);
        _mediaData = compressed;
        const preview = document.getElementById('post-media-preview');
        if (preview) {
          preview.innerHTML = '<img src="' + compressed + '" alt="Preview"><button class="remove-media" id="remove-media-btn">&times;</button>';
          preview.classList.remove('hidden');
          document.getElementById('remove-media-btn')?.addEventListener('click', () => {
            _mediaData = null;
            preview.innerHTML = '';
            preview.classList.add('hidden');
            document.getElementById('post-image-input').value = '';
          });
        }
      } catch (err) {
        Utils.showToast('Failed to process image', 'error');
      }
    });

    // Submit post
    document.getElementById('submit-post-btn')?.addEventListener('click', handleSubmit);
  };

  function renderCurrentUser() {
    const user = Auth.getCurrentUser();
    const container = document.getElementById('create-post-user');
    if (!container || !user) return;
    const avatar = user.avatarUrl
      ? '<img src="' + user.avatarUrl + '" alt="Avatar">'
      : '<div class="post-avatar-placeholder">' + Utils.getInitials(user.displayName || 'U') + '</div>';
    container.innerHTML = avatar + '<span>' + Utils.sanitizeHTML(user.displayName || 'You') + '</span>';
  }

  function resetForm() {
    const input = document.getElementById('post-content-input');
    if (input) input.value = '';
    const preview = document.getElementById('post-media-preview');
    if (preview) { preview.innerHTML = ''; preview.classList.add('hidden'); }
    const pollContainer = document.getElementById('poll-options-container');
    if (pollContainer) {
      pollContainer.classList.add('hidden');
      const inputs = pollContainer.querySelectorAll('.poll-option-input');
      inputs.forEach((inp, i) => { if (i > 1) inp.remove(); else inp.value = ''; });
    }
    _pollMode = false;
    _mediaData = null;
    const imageInput = document.getElementById('post-image-input');
    if (imageInput) imageInput.value = '';
    const announceToggle = document.getElementById('post-announcement-toggle');
    if (announceToggle) announceToggle.checked = false;
  }

  async function handleSubmit() {
    const contentInput = document.getElementById('post-content-input');
    const content = contentInput?.value?.trim() || '';
    const user = Auth.getCurrentUser();

    if (!content && !_mediaData && !_pollMode) {
      Utils.showToast('Add some content to your post', 'warning');
      return;
    }

    const btn = document.getElementById('submit-post-btn');
    const btnText = btn?.querySelector('.btn-text');
    const btnLoader = btn?.querySelector('.btn-loader');
    if (btnText) btnText.classList.add('hidden');
    if (btnLoader) btnLoader.classList.remove('hidden');
    btn.disabled = true;

    try {
      const postData = {
        authorId: user.uid,
        content: Utils.sanitizeHTML(content),
        schoolId: user.schoolId || '',
        groupId: null,
        competitionId: null,
        imageUrl: _mediaData || null,
        videoUrl: null,
        type: 'text',
        likeCount: 0,
        commentCount: 0,
        shareCount: 0,
        pinned: false,
        isAnnouncement: document.getElementById('post-announcement-toggle')?.checked || false,
        createdAt: firebase.firestore.FieldValue.serverTimestamp(),
        updatedAt: firebase.firestore.FieldValue.serverTimestamp(),
        deleted: false
      };

      if (_mediaData) postData.type = 'image';

      // Poll data
      if (_pollMode) {
        const options = [];
        document.querySelectorAll('#poll-options-container .poll-option-input').forEach(inp => {
          const val = inp.value.trim();
          if (val) options.push({ text: val, votes: 0 });
        });
        if (options.length < 2) {
          Utils.showToast('Add at least 2 poll options', 'warning');
          btn.disabled = false;
          if (btnText) btnText.classList.remove('hidden');
          if (btnLoader) btnLoader.classList.add('hidden');
          return;
        }
        postData.poll = { options, totalVotes: 0, endsAt: null };
        postData.type = 'poll';
      }

      const docRef = await db().collection('posts').add(postData);

      // Update user post count
      await db().collection('users').doc(user.uid).update({
        postsCount: firebase.firestore.FieldValue.increment(1)
      });

      // Award XP
      Reputation.awardXP(user.uid, 5, 'Created a post');

      // Close modal
      document.getElementById('create-modal').classList.add('hidden');
      resetForm();

      // Notify feed
      document.dispatchEvent(new CustomEvent('postCreated', { detail: { postId: docRef.id } }));
      Utils.showToast('Post created!', 'success');

    } catch (err) {
      console.error('Create post error:', err);
      Utils.showToast('Failed to create post', 'error');
    } finally {
      btn.disabled = false;
      if (btnText) btnText.classList.remove('hidden');
      if (btnLoader) btnLoader.classList.add('hidden');
    }
  }
})();