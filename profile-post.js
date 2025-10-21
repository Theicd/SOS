(function initProfilePostRenderer(window) {
  // חלק דף פרופיל (profile-post.js) – מספק רנדר זהה לפיד עבור הפוסטים האישיים
  const App = window.NostrApp || (window.NostrApp = {});

  // חלק בניית מדיה (profile-post.js) – יוצר HTML זהה לפיד עבור תמונות, וידאו ו-YouTube
  function createMediaHtml(links = []) {
    if (!Array.isArray(links) || links.length === 0) {
      return '';
    }

    return links
      .map((link) => {
        if (!link) return '';

        const youtubeMatch = link.match(/(?:https?:\/\/)?(?:www\.|m\.)?youtu(?:\.be|be\.com)\/(?:watch\?v=|embed\/|v\/)?([\w-]{11})/);
        if (youtubeMatch) {
          const youtubeId = youtubeMatch[1];
          const thumbUrl = `https://i.ytimg.com/vi/${youtubeId}/hqdefault.jpg`;
          return `
            <div class="feed-media feed-media--youtube" data-youtube-id="${youtubeId}">
              <img class="feed-media__thumb" src="${thumbUrl}" alt="תצוגה מקדימה של YouTube">
              <span class="feed-media__play"><i class="fa-solid fa-play"></i></span>
            </div>
          `;
        }

        if (link.startsWith('data:image') || link.split('?')[0].match(/\.(png|jpe?g|gif|webp|avif)$/i)) {
          return `<div class="feed-media"><img src="${link}" alt="תמונה מצורפת"></div>`;
        }

        if (link.startsWith('data:video') || link.match(/\.(mp4|webm|ogg)$/i)) {
          return `<div class="feed-media"><video src="${link}" controls playsinline></video></div>`;
        }

        if (/^https?:\/\//i.test(link)) {
          if (link.match(/\.(mp4|webm|ogg)$/i)) {
            return `<div class="feed-media"><video src="${link}" controls playsinline></video></div>`;
          }
          const pathWithoutQuery = link.split('?')[0];
          if (pathWithoutQuery.match(/\.(png|jpe?g|gif|webp|avif)$/i)) {
            return `<div class="feed-media"><img src="${link}" alt="תמונה מצורפת"></div>`;
          }
          let label = link;
          try {
            const parsed = new URL(link);
            label = `${parsed.hostname}${parsed.pathname}` || link;
          } catch (err) {
            console.warn('External media link parsing failed', err);
          }
          if (label.length > 60) {
            label = `${label.slice(0, 57)}...`;
          }
          const safeLabel = typeof App.escapeHtml === 'function' ? App.escapeHtml(label) : label;
          return `<div class="feed-media feed-media--link"><a href="${link}" target="_blank" rel="noopener noreferrer">${safeLabel}</a></div>`;
        }

        return '';
      })
      .filter(Boolean)
      .join('');
  }

  function ensureProfileContainer(containerId) {
    const list = document.getElementById(containerId);
    return list || null;
  }

  function formatTimestamp(seconds) {
    if (!seconds) {
      return '';
    }
    try {
      const date = new Date(seconds * 1000);
      return date.toLocaleString('he-IL', { dateStyle: 'short', timeStyle: 'short' });
    } catch (err) {
      return '';
    }
  }

  function buildPostTemplate(event, profileData, isReply) {
    const safeName = App.escapeHtml(profileData.name || `משתמש ${event.pubkey.slice(0, 8)}`);
    const lines = (event.content || '').split('\n');
    const mediaLinks = [];
    const textLines = [];
    lines.forEach((line) => {
      const trimmed = line.trim();
      if (!trimmed) return;
      if (trimmed.startsWith('http') || trimmed.startsWith('data:image') || trimmed.startsWith('data:video')) {
        mediaLinks.push(trimmed);
      } else {
        textLines.push(trimmed);
      }
    });
    const rawText = textLines.join('\n');
    const safeContent = App.escapeHtml(rawText).replace(/\n/g, '<br>');
    const isLongPost = textLines.length > 6 || rawText.length > 420;
    const contentClass = isLongPost
      ? 'feed-post__content feed-post__content--collapsed'
      : 'feed-post__content';
    const showMoreHtml = isLongPost
      ? `
        <button class="feed-post__show-more" type="button" data-show-more="${event.id}" aria-expanded="false">
          הצג עוד
        </button>
      `
      : '';

    const mediaHtml = typeof App.createMediaHtml === 'function'
      ? App.createMediaHtml(mediaLinks)
      : createMediaHtml(mediaLinks);
    const likeCount = App.likesByEventId?.get(event.id)?.size || 0;
    const commentCount = App.commentsByParent?.get(event.id)?.size || 0;
    const safeBio = profileData.bio ? App.escapeHtml(profileData.bio) : '';
    const metaParts = [];
    if (safeBio) {
      metaParts.push(safeBio);
    }
    if (event.created_at) {
      metaParts.push(formatTimestamp(event.created_at));
    }
    const metaHtml = metaParts.join(' • ');
    const avatarHtml = profileData.picture
      ? `<button class="feed-post__avatar" type="button" data-profile-link="${event.pubkey}"><img src="${profileData.picture}" alt="${safeName}"></button>`
      : `<button class="feed-post__avatar" type="button" data-profile-link="${event.pubkey}">${profileData.initials || 'AN'}</button>`;

    const isOwn = typeof App.publicKey === 'string' && event.pubkey === App.publicKey;
    const isAdminUser = App.adminPublicKeys instanceof Set && typeof App.publicKey === 'string'
      ? App.adminPublicKeys.has(App.publicKey.toLowerCase())
      : false;
    const canDelete = !isReply && (isOwn || isAdminUser);
    const deleteButtonHtml = canDelete
      ? `
        <button class="feed-post__action feed-post__action--delete" type="button" data-delete-post="${event.id}">
          <i class="fa-solid fa-trash"></i>
          <span>מחק</span>
        </button>
      `
      : '';

    const actionsHtml = isReply
      ? ''
      : `
        <div class="feed-post__actions">
          <button class="feed-post__action" type="button" data-like-button data-event-id="${event.id}">
            <i class="fa-regular fa-thumbs-up"></i>
            <span>אהבתי</span>
            <span class="feed-post__like-count" data-like-counter="${event.id}" ${likeCount ? '' : 'style=\"display:none;\"'}>${likeCount || ''}</span>
          </button>
          <button class="feed-post__action" type="button" data-share-post="${event.id}">
            <i class="fa-solid fa-share"></i>
            <span>שתף</span>
          </button>
          ${deleteButtonHtml}
        </div>
      `;

    const commentsToggleHtml = isReply
      ? ''
      : `
        <button class="feed-post__comments-toggle" type="button" data-comments-toggle="${event.id}">
          <i class="fa-regular fa-message"></i>
          <span>תגובות</span>
          <span class="feed-post__comment-count" data-comment-count="${event.id}" ${commentCount ? '' : 'style=\"display:none;\"'}>${commentCount || ''}</span>
        </button>
      `;

    const commentsSectionHtml = isReply
      ? ''
      : `
        <section class="feed-comments" data-comments-section="${event.id}" hidden>
          <div class="feed-comments__list" data-comments-list="${event.id}"></div>
          <form class="feed-comments__form" data-comment-form="${event.id}">
            <div class="feed-comments__composer">
              <div class="feed-comments__avatar">${getViewerAvatarHtml()}</div>
              <div class="feed-comments__input">
                <textarea rows="2" placeholder="כתוב תגובה..." required></textarea>
                <button class="feed-comments__submit" type="submit" aria-label="שלח תגובה">
                  <i class="fa-solid fa-paper-plane"></i>
                </button>
              </div>
            </div>
          </form>
        </section>
      `;

    return `
      <article class="feed-post${isReply ? ' feed-post--reply' : ''}" data-event-id="${event.id}">
        <header class="feed-post__header">
          ${avatarHtml}
          <div class="feed-post__info">
            <button class="feed-post__name" type="button" data-profile-link="${event.pubkey}">${safeName}</button>
            ${metaHtml ? `<span class="feed-post__meta">${metaHtml}</span>` : ''}
          </div>
        </header>
        ${safeContent ? `<div class="${contentClass}" data-post-content="${event.id}">${safeContent}</div>` : ''}
        ${showMoreHtml}
        ${mediaHtml ? `<div class="feed-post__media">${mediaHtml}</div>` : ''}
        <footer class="feed-post__stats">
          <span class="feed-post__likes" data-like-total="${event.id}">
            <i class="fa-solid fa-thumbs-up"></i>
            <span class="feed-post__like-counter" data-like-counter="${event.id}">${likeCount || ''}</span>
          </span>
          ${commentsToggleHtml}
        </footer>
        ${actionsHtml}
        ${commentsSectionHtml}
      </article>
    `;
  }

  function renderProfilePosts(events, containerId = 'profileTimeline') {
    const container = ensureProfileContainer(containerId);
    if (!container) {
      return;
    }
    container.innerHTML = '';
    const list = Array.isArray(events) ? events : [];
    if (list.length === 0) {
      const empty = document.createElement('li');
      empty.className = 'feed-post feed-post--empty';
      empty.textContent = 'לא נמצאו פוסטים עבור משתמש זה.';
      container.appendChild(empty);
      return;
    }
    const fragment = document.createDocumentFragment();
    const isReplyList = containerId.toLowerCase().includes('reply');
    list.forEach((event) => {
      const profileData = App.profileCache?.get(event.pubkey) || {
        name: `משתמש ${event.pubkey.slice(0, 8)}`,
        initials: typeof App.getInitials === 'function' ? App.getInitials(event.pubkey) : 'AN',
        picture: '',
      };
      const wrapper = document.createElement('li');
      wrapper.innerHTML = buildPostTemplate(event, profileData, isReplyList);
      fragment.appendChild(wrapper);
    });
    container.appendChild(fragment);

    wireProfileLinks(container);
    wireShowMore(container);
    wireLikeButtons(container);
    wireShareButtons(container);
    wireDeleteButtons(container);
    wireComments(container);
    tidyCounters(container);
    App.enhanceYouTubePlayers?.(container);
  }

  function wireShowMore(root) {
    if (!root) return;
    root.querySelectorAll('[data-show-more]').forEach((button) => {
      button.addEventListener('click', () => {
        const postId = button.getAttribute('data-show-more');
        const li = button.closest('li');
        const contentEl = li ? li.querySelector(`[data-post-content="${postId}"]`) : null;
        if (!contentEl) {
          return;
        }
        const expanded = contentEl.classList.toggle('feed-post__content--expanded');
        if (expanded) {
          contentEl.classList.remove('feed-post__content--collapsed');
          button.textContent = 'הצג פחות';
          button.setAttribute('aria-expanded', 'true');
        } else {
          contentEl.classList.add('feed-post__content--collapsed');
          button.textContent = 'הצג עוד';
          button.setAttribute('aria-expanded', 'false');
        }
      });
    });
  }

  function wireProfileLinks(root) {
    if (!root) return;
    root.querySelectorAll('[data-profile-link]').forEach((button) => {
      button.addEventListener('click', () => {
        const target = button.getAttribute('data-profile-link');
        if (target && typeof window.openProfileByPubkey === 'function') {
          window.openProfileByPubkey(target);
        }
      });
    });
  }

  function tidyCounters(root) {
    if (!root) return;
    root.querySelectorAll('[data-like-counter]').forEach((counter) => {
      if (!counter.textContent.trim()) {
        counter.style.display = 'none';
      } else {
        counter.style.display = '';
      }
    });
    root.querySelectorAll('[data-comment-count]').forEach((counter) => {
      if (!counter.textContent.trim()) {
        counter.style.display = 'none';
      } else {
        counter.style.display = '';
      }
    });
    root.querySelectorAll('.feed-media--youtube').forEach((el) => {
      el.addEventListener('click', () => {
        const videoId = el.getAttribute('data-youtube-id');
        if (!videoId) {
          return;
        }
        const iframe = document.createElement('iframe');
        iframe.src = `https://www.youtube.com/embed/${videoId}?autoplay=1`;
        iframe.allow = 'accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share';
        iframe.allowFullscreen = true;
        iframe.className = 'feed-media__player';
        el.innerHTML = '';
        el.appendChild(iframe);
      });
    });
  }

  function wireLikeButtons(root) {
    if (!root) return;
    root.querySelectorAll('[data-like-button]').forEach((button) => {
      if (button.dataset.listenerAttached === 'true') {
        return;
      }
      button.dataset.listenerAttached = 'true';
      button.addEventListener('click', () => {
        const eventId = button.getAttribute('data-event-id');
        if (eventId && typeof App.likePost === 'function') {
          App.likePost(eventId);
        }
      });
    });
  }

  function wireShareButtons(root) {
    if (!root) return;
    root.querySelectorAll('[data-share-post]').forEach((button) => {
      if (button.dataset.listenerAttached === 'true') {
        return;
      }
      button.dataset.listenerAttached = 'true';
      button.addEventListener('click', () => {
        const eventId = button.getAttribute('data-share-post');
        if (eventId && typeof App.sharePost === 'function') {
          App.sharePost(eventId);
        }
      });
    });
  }

  function wireDeleteButtons(root) {
    if (!root) return;
    root.querySelectorAll('[data-delete-post]').forEach((button) => {
      if (button.dataset.listenerAttached === 'true') {
        return;
      }
      button.dataset.listenerAttached = 'true';
      button.addEventListener('click', () => {
        const eventId = button.getAttribute('data-delete-post');
        if (eventId && typeof App.deletePost === 'function') {
          App.deletePost(eventId);
        }
      });
    });
  }

  function wireComments(root) {
    if (!root) return;
    root.querySelectorAll('[data-comments-toggle]').forEach((button) => {
      const parentId = button.getAttribute('data-comments-toggle');
      const article = button.closest('article');
      const section = article ? article.querySelector(`[data-comments-section="${parentId}"]`) : null;
      if (!section) {
        return;
      }
      if (button.dataset.listenerAttached === 'true') {
        const hidden = section.hasAttribute('hidden');
        if (hidden) {
          section.removeAttribute('hidden');
          if (typeof App.updateCommentsForParent === 'function') {
            App.updateCommentsForParent(parentId);
          }
        } else {
          section.setAttribute('hidden', '');
        }
        return;
      }
      button.dataset.listenerAttached = 'true';
      button.addEventListener('click', () => {
        const hidden = section.hasAttribute('hidden');
        if (hidden) {
          section.removeAttribute('hidden');
          if (typeof App.updateCommentsForParent === 'function') {
            App.updateCommentsForParent(parentId);
          }
        } else {
          section.setAttribute('hidden', '');
        }
      });
    });

    root.querySelectorAll('[data-comment-form]').forEach((form) => {
      const parentId = form.getAttribute('data-comment-form');
      if (form.dataset.listenerAttached === 'true') {
        return;
      }
      form.dataset.listenerAttached = 'true';
      form.addEventListener('submit', async (event) => {
        event.preventDefault();
        const textarea = form.querySelector('textarea');
        if (!textarea || !textarea.value.trim()) {
          return;
        }
        const content = textarea.value.trim();
        try {
          if (typeof App.postComment === 'function') {
            await App.postComment(parentId, content);
          }
          textarea.value = '';
          if (typeof App.updateCommentsForParent === 'function') {
            App.updateCommentsForParent(parentId);
          }
        } catch (err) {
          console.error('Failed submitting profile comment', err);
        }
      });
    });

    root.querySelectorAll('[data-like-button]').forEach((button) => {
      button.addEventListener('click', () => {
        const eventId = button.getAttribute('data-event-id');
        if (eventId && typeof App.likePost === 'function') {
          App.likePost(eventId);
        }
      });
    });
  }

  function getViewerAvatarHtml() {
    const viewerProfile = App.profile || {};
    const viewerName = viewerProfile.name || 'אני';
    if (viewerProfile.picture) {
      return `<img src="${viewerProfile.picture}" alt="${App.escapeHtml(viewerName)}">`;
    }
    const initials = typeof App.getInitials === 'function'
      ? App.getInitials(viewerName)
      : viewerName.slice(0, 2).toUpperCase();
    return `<span>${App.escapeHtml(initials)}</span>`;
  }

  App.renderProfilePosts = renderProfilePosts;
})(window);
