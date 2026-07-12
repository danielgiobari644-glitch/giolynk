/**
 * GIOLYNK - Utility Functions
 * A collection of pure helpers and DOM utilities used throughout the app.
 */
(function () {
  'use strict';

  window.Utils = {

    /* ─────────────────────────────── Timing ─────────────────────────────── */

    /**
     * Debounce – delay execution until `delay` ms after the last call.
     */
    debounce(fn, delay = 300) {
      let timer;
      return function (...args) {
        clearTimeout(timer);
        timer = setTimeout(() => fn.apply(this, args), delay);
      };
    },

    /**
     * Throttle – execute at most once every `limit` ms.
     */
    throttle(fn, limit = 300) {
      let inThrottle = false;
      return function (...args) {
        if (!inThrottle) {
          fn.apply(this, args);
          inThrottle = true;
          setTimeout(() => { inThrottle = false; }, limit);
        }
      };
    },

    /* ─────────────────────────────── Date / Time ────────────────────────── */

    /**
     * Human-readable relative time.
     * Returns strings like "2m ago", "1h ago", "Yesterday", "Jan 15".
     */
    formatTimeAgo(date) {
      if (!date) return '';
      const d = date instanceof Date ? date : new Date(date);
      if (isNaN(d.getTime())) return '';

      const now = Date.now();
      const diff = now - d.getTime();
      const seconds = Math.floor(diff / 1000);
      const minutes = Math.floor(seconds / 60);
      const hours = Math.floor(minutes / 60);

      if (seconds < 60) return 'just now';
      if (minutes < 60) return `${minutes}m ago`;
      if (hours < 24) return `${hours}h ago`;

      const today = new Date();
      const yesterday = new Date(today);
      yesterday.setDate(yesterday.getDate() - 1);

      if (d.toDateString() === today.toDateString()) return 'Today';
      if (d.toDateString() === yesterday.toDateString()) return 'Yesterday';

      const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
        'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
      const monthName = months[d.getMonth()];
      const day = d.getDate();
      const year = d.getFullYear();

      // Same year → "Jan 15", otherwise "Jan 15, 2024"
      if (year === today.getFullYear()) {
        return `${monthName} ${day}`;
      }
      return `${monthName} ${day}, ${year}`;
    },

    /**
     * Format time as "HH:MM AM/PM".
     */
    formatTime(date) {
      if (!date) return '';
      const d = date instanceof Date ? date : new Date(date);
      if (isNaN(d.getTime())) return '';

      let hours = d.getHours();
      const minutes = d.getMinutes();
      const ampm = hours >= 12 ? 'PM' : 'AM';
      hours = hours % 12 || 12;
      const mm = minutes < 10 ? `0${minutes}` : minutes;
      return `${hours}:${mm} ${ampm}`;
    },

    /**
     * Format date as "Mon DD, YYYY" (e.g. "Jan 15, 2024").
     */
    formatDate(date) {
      if (!date) return '';
      const d = date instanceof Date ? date : new Date(date);
      if (isNaN(d.getTime())) return '';

      const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
        'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
      return `${months[d.getMonth()]} ${String(d.getDate()).padStart(2, '0')}, ${d.getFullYear()}`;
    },

    /* ─────────────────────────────── Strings ────────────────────────────── */

    /**
     * Truncate a string to `len` characters, adding an ellipsis if needed.
     */
    truncate(str, len = 100) {
      if (!str) return '';
      if (typeof str !== 'string') str = String(str);
      return str.length > len ? str.slice(0, len).trim() + '…' : str;
    },

    /**
     * Generate a random ID string (URL-safe, 20 chars).
     */
    generateId() {
      const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
      let id = '';
      const array = new Uint8Array(20);
      (window.crypto || window.msCrypto).getRandomValues(array);
      for (let i = 0; i < 20; i++) {
        id += chars[array[i] % chars.length];
      }
      return id;
    },

    /**
     * Basic XSS prevention – escape HTML entities.
     */
    sanitizeHTML(str) {
      if (!str) return '';
      const map = {
        '&': '&amp;',
        '<': '&lt;',
        '>': '&gt;',
        '"': '&quot;',
        "'": '&#x27;',
        '/': '&#x2F;'
      };
      return String(str).replace(/[&<>"'/]/g, (c) => map[c]);
    },

    /**
     * Get initials from a display name: "John Doe" → "JD".
     */
    getInitials(name) {
      if (!name) return '?';
      return name
        .trim()
        .split(/\s+/)
        .filter(Boolean)
        .map((word) => word[0])
        .join('')
        .toUpperCase()
        .slice(0, 2);
    },

    /* ─────────────────────────────── Clipboard ──────────────────────────── */

    /**
     * Copy text to clipboard with a fallback for older browsers.
     * Returns a Promise that resolves on success.
     */
    async copyToClipboard(text) {
      try {
        if (navigator.clipboard && navigator.clipboard.writeText) {
          await navigator.clipboard.writeText(text);
          return true;
        }
        // Fallback: hidden textarea + execCommand
        const textarea = document.createElement('textarea');
        textarea.value = text;
        textarea.style.position = 'fixed';
        textarea.style.left = '-9999px';
        document.body.appendChild(textarea);
        textarea.select();
        const ok = document.execCommand('copy');
        document.body.removeChild(textarea);
        return ok;
      } catch (err) {
        console.error('[Utils] copyToClipboard failed:', err);
        return false;
      }
    },

    /* ─────────────────────────────── Numbers ────────────────────────────── */

    /**
     * Format large numbers: 1200 → "1.2K", 1500000 → "1.5M", etc.
     */
    formatNumber(num) {
      if (num === null || num === undefined) return '0';
      const n = Number(num);
      if (isNaN(n)) return '0';
      if (n < 1000) return String(n);

      const suffixes = ['', 'K', 'M', 'B', 'T'];
      const tier = Math.min(
        Math.floor(Math.log10(Math.abs(n)) / 3),
        suffixes.length - 1
      );
      const scaled = n / Math.pow(10, tier * 3);
      const formatted = scaled % 1 === 0 ? String(scaled) : scaled.toFixed(1).replace(/\.0$/, '');
      return `${formatted}${suffixes[tier]}`;
    },

    /**
     * Validate an email address with a simple regex.
     */
    isValidEmail(email) {
      if (!email || typeof email !== 'string') return false;
      // Covers 99.9% of valid emails without being overly strict
      return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim());
    },

    /* ─────────────────────────────── File Sizes ─────────────────────────── */

    /**
     * Convert bytes to a human-readable file size.
     * e.g. 1024 → "1 KB", 1048576 → "1 MB".
     */
    getFileSize(bytes) {
      if (bytes === 0) return '0 B';
      const units = ['B', 'KB', 'MB', 'GB', 'TB'];
      const i = Math.min(
        Math.floor(Math.log(bytes) / Math.log(1024)),
        units.length - 1
      );
      const size = (bytes / Math.pow(1024, i)).toFixed(i === 0 ? 0 : 1);
      return `${size} ${units[i]}`;
    },

    /* ─────────────────────────────── Image Compression ──────────────────── */

    /**
     * Compress an image file before upload.
     * Returns a Promise that resolves with a base64 data URL string.
     * @param {File} file        – The image file to compress.
     * @param {number} maxWidth  – Maximum width (default 1200).
     * @param {number} quality   – JPEG quality 0-1 (default 0.7).
     */
    compressImage(file, maxWidth = 1200, quality = 0.7) {
      return new Promise((resolve, reject) => {
        // Reject non-image files
        if (!file || !file.type.startsWith('image/')) {
          reject(new Error('compressImage: file is not an image.'));
          return;
        }

        const reader = new FileReader();
        reader.onerror = () => reject(new Error('Failed to read file.'));
        reader.onload = (e) => {
          const img = new Image();
          img.onerror = () => reject(new Error('Failed to load image.'));
          img.onload = () => {
            const canvas = document.createElement('canvas');
            let { width, height } = img;

            // Scale down if wider than maxWidth
            if (width > maxWidth) {
              const ratio = maxWidth / width;
              width = maxWidth;
              height = Math.round(height * ratio);
            }

            canvas.width = width;
            canvas.height = height;

            const ctx = canvas.getContext('2d');
            ctx.drawImage(img, 0, 0, width, height);

            // Use JPEG for compression; fall back to PNG for transparent images
            let mimeType = 'image/jpeg';
            if (file.type === 'image/png') {
              // Check for transparency – if alpha is all 255, still use JPEG
              const data = ctx.getImageData(0, 0, width, height).data;
              let hasAlpha = false;
              for (let i = 3; i < data.length; i += 4) {
                if (data[i] < 255) { hasAlpha = true; break; }
              }
              if (hasAlpha) mimeType = 'image/png';
            }

            const base64 = canvas.toDataURL(mimeType, quality);
            resolve(base64);
          };
          img.src = e.target.result;
        };
        reader.readAsDataURL(file);
      });
    },

    /* ─────────────────────────────── Toast Notifications ────────────────── */

    /**
     * Show a toast notification.
     * @param {string} message – The message text.
     * @param {string} type    – 'success' | 'error' | 'info' | 'warning'.
     * @param {number} duration – Auto-dismiss time in ms (default 3000).
     */
    showToast(message, type = 'info', duration = 3000) {
      let container = document.getElementById('toast-container');
      if (!container) {
        container = document.createElement('div');
        container.id = 'toast-container';
        container.className = 'toast-container';
        document.body.appendChild(container);
      }

      const icons = {
        success: '✅',
        error: '❌',
        warning: '⚠️',
        info: 'ℹ️'
      };

      const toast = document.createElement('div');
      toast.className = `toast toast-${type}`;
      toast.innerHTML = `
        <span class="toast-icon">${icons[type] || icons.info}</span>
        <span class="toast-message">${this.sanitizeHTML(message)}</span>
        <button class="toast-close" aria-label="Close">&times;</button>
      `;

      // Close button
      toast.querySelector('.toast-close').addEventListener('click', () => {
        toast.classList.add('toast-exit');
        setTimeout(() => toast.remove(), 300);
      });

      container.appendChild(toast);

      // Auto dismiss
      if (duration > 0) {
        setTimeout(() => {
          if (toast.parentNode) {
            toast.classList.add('toast-exit');
            setTimeout(() => toast.remove(), 300);
          }
        }, duration);
      }
    },

    /* ─────────────────────────────── Confirm Dialog ─────────────────────── */

    /**
     * Show a confirm dialog and return a Promise<boolean>.
     * Uses the #confirm-dialog element from the HTML.
     */
    showConfirm(title, message) {
      return new Promise((resolve) => {
        const dialog = document.getElementById('confirm-dialog');
        const titleEl = document.getElementById('confirm-title');
        const messageEl = document.getElementById('confirm-message');
        const okBtn = document.getElementById('confirm-ok');
        const cancelBtn = document.getElementById('confirm-cancel');

        if (!dialog || !okBtn || !cancelBtn) {
          // Fallback to native confirm
          resolve(window.confirm(`${title}\n${message}`));
          return;
        }

        if (titleEl) titleEl.textContent = title;
        if (messageEl) messageEl.textContent = message;

        dialog.classList.remove('hidden');

        const cleanup = (result) => {
          dialog.classList.add('hidden');
          okBtn.removeEventListener('click', onOk);
          cancelBtn.removeEventListener('click', onCancel);
          resolve(result);
        };

        const onOk = () => cleanup(true);
        const onCancel = () => cleanup(false);

        okBtn.addEventListener('click', onOk);
        cancelBtn.addEventListener('click', onCancel);
      });
    },

    /* ─────────────────────────────── Device / Network ───────────────────── */

    /**
     * Detect device type based on screen width.
     */
    getDeviceType() {
      const width = window.innerWidth;
      if (width < 768) return 'mobile';
      if (width < 1024) return 'tablet';
      return 'desktop';
    },

    /**
     * Check if the browser currently reports online status.
     */
    isOnline() {
      return navigator.onLine === true;
    }
  };
})();