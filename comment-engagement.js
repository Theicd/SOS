;(function initCommentEngagement(window) {
  const App = window.NostrApp || (window.NostrApp = {});
  const STORAGE_KEY_PREFIX = 'nostr_comment_reactions_';
  const REACTION_TYPES = ['like', 'love', 'laugh', 'angry', 'sad']; // חלק ריאקציות לתגובות – סט אימוג'ים מקובל | HYPER CORE TECH

  App.commentReactionsByComment = App.commentReactionsByComment instanceof Map ? App.commentReactionsByComment : new Map();
  App.commentReactionsLastSyncTs = typeof App.commentReactionsLastSyncTs === 'number' ? App.commentReactionsLastSyncTs : 0;
  App._commentReactionSubscribers = App._commentReactionSubscribers || new Set();
  App._commentReactionEventsSeen = App._commentReactionEventsSeen || new Set(); // dedup לפי event.id

  function storageKey() {
    const pk = typeof App.publicKey === 'string' ? App.publicKey.toLowerCase() : '';
    return pk ? `${STORAGE_KEY_PREFIX}${pk}` : null;
  }

  function emptyCounts() {
    return { like: 0, love: 0, laugh: 0, angry: 0, sad: 0 };
  }

  function persist() {
    const key = storageKey();
    if (!key) return;
    const payload = { lastSyncTs: App.commentReactionsLastSyncTs || 0, comments: {} };
    App.commentReactionsByComment.forEach((state, commentId) => {
      if (!commentId || !state) return;
      const { counts, myReaction, reactors, eventIds } = state;
      payload.comments[commentId] = {
        counts,
        myReaction,
        reactors: Object.fromEntries(reactors || []),
        eventIds: Array.from(eventIds || []).slice(-300), // הגבלת רשימת אירועים לפילטר כפילויות
      };
    });
    try {
      window.localStorage.setItem(key, JSON.stringify(payload));
    } catch (err) {
      console.warn('Persist comment reactions failed', err);
    }
  }

  function restore() {
    const key = storageKey();
    if (!key) return;
    try {
      const raw = window.localStorage.getItem(key);
      if (!raw) return;
      const parsed = JSON.parse(raw);
      const lastSync = parsed?.lastSyncTs || 0;
      if (typeof lastSync === 'number') {
        App.commentReactionsLastSyncTs = lastSync;
      }
      const comments = parsed?.comments || {};
      Object.keys(comments).forEach((cid) => {
        const entry = comments[cid] || {};
        const reactors = new Map(Object.entries(entry.reactors || {}));
        const counts = Object.assign(emptyCounts(), entry.counts || {});
        const eventIds = new Set(Array.isArray(entry.eventIds) ? entry.eventIds : []);
        // תיקון ספירה לפי reactors אם צריך
        const recalculated = emptyCounts();
        reactors.forEach((reaction) => {
          if (REACTION_TYPES.includes(reaction)) {
            recalculated[reaction] = (recalculated[reaction] || 0) + 1;
          }
        });
        const finalCounts = { ...counts, ...recalculated };
        App.commentReactionsByComment.set(cid, {
          counts: finalCounts,
          myReaction: entry.myReaction || '',
          reactors,
          eventIds,
        });
        (entry.eventIds || []).forEach((id) => App._commentReactionEventsSeen.add(id));
      });
    } catch (err) {
      console.warn('Restore comment reactions failed', err);
    }
  }

  restore();

  function getCommentReactionState(commentId) {
    const state = App.commentReactionsByComment.get(commentId);
    if (state) return state;
    const next = { counts: emptyCounts(), myReaction: '', reactors: new Map(), eventIds: new Set() };
    App.commentReactionsByComment.set(commentId, next);
    return next;
  }

  function notifySubscribers(commentId) {
    App._commentReactionSubscribers.forEach((cb) => {
      try { cb(commentId); } catch (_) {}
    });
    if (typeof App.refreshCommentsForParent === 'function' && App.commentParentById?.has?.(commentId)) {
      const parent = App.commentParentById.get(commentId);
      try { App.refreshCommentsForParent(parent); } catch (_) {}
    }
  }

  function handleReactionEvent(event) {
    if (!event || event.kind !== 7 || !Array.isArray(event.tags)) return;
    if (event.id && App._commentReactionEventsSeen.has(event.id)) {
      return;
    }
    const actor = typeof event.pubkey === 'string' ? event.pubkey.toLowerCase() : '';
    let commentId = '';
    event.tags.forEach((tag) => {
      if (Array.isArray(tag) && tag[0] === 'e' && typeof tag[1] === 'string') {
        commentId = tag[1];
      }
    });
    if (!commentId) return;
    const content = typeof event.content === 'string' ? event.content.trim() : '';
    const isRemoval = content === '-';
    const reaction = isRemoval ? '' : content.toLowerCase();
    if (reaction && !REACTION_TYPES.includes(reaction)) {
      return;
    }
    const state = getCommentReactionState(commentId);
    const prev = state.reactors.get(actor) || '';
    if (event.id) {
      state.eventIds.add(event.id);
      App._commentReactionEventsSeen.add(event.id);
    }
    if (prev === reaction) {
      // no-op
    } else {
      if (prev && state.counts[prev] > 0) {
        state.counts[prev] -= 1;
      }
      if (reaction) {
        state.counts[reaction] = (state.counts[reaction] || 0) + 1;
        state.reactors.set(actor, reaction);
      } else {
        state.reactors.delete(actor);
      }
    }
    const me = typeof App.publicKey === 'string' ? App.publicKey.toLowerCase() : '';
    if (actor && me && actor === me) {
      state.myReaction = reaction;
    }
    const ts = typeof event.created_at === 'number' ? event.created_at : Math.floor(Date.now() / 1000);
    if (ts > (App.commentReactionsLastSyncTs || 0)) {
      App.commentReactionsLastSyncTs = ts;
    }
    persist();
    notifySubscribers(commentId);
  }

  function publishReaction(commentId, commentAuthor, reaction) {
    if (!commentId || !App.pool || !Array.isArray(App.relayUrls)) return;
    const kind = 7;
    const content = reaction ? reaction : '-';
    const tags = [['e', commentId]];
    if (commentAuthor) {
      tags.push(['p', commentAuthor]);
    }
    if (App.NETWORK_TAG) {
      tags.push(['t', App.NETWORK_TAG]);
    }
    const ev = {
      kind,
      created_at: Math.floor(Date.now() / 1000),
      content,
      tags,
    };
    if (typeof App.signAndPublishEvent === 'function') {
      App.signAndPublishEvent(ev).catch((err) => console.warn('publishReaction failed', err));
    }
  }

  function toggleCommentReaction(commentId, commentAuthor, reaction) {
    const state = getCommentReactionState(commentId);
    const next = state.myReaction === reaction ? '' : reaction;
    publishReaction(commentId, commentAuthor, next);
  }

  function subscribeCommentReactions(commentIds = []) {
    try {
      if (!Array.isArray(commentIds) || commentIds.length === 0 || !App.pool || !Array.isArray(App.relayUrls)) {
        return;
      }
      if (!(App._commentReactionsSubscribed instanceof Set)) {
        App._commentReactionsSubscribed = new Set();
      }
      const toSubscribe = commentIds.filter((id) => typeof id === 'string' && id && !App._commentReactionsSubscribed.has(id));
      if (!toSubscribe.length) return;
      toSubscribe.forEach((id) => App._commentReactionsSubscribed.add(id));
      const sinceTs = App.commentReactionsLastSyncTs || 0;
      const chunkSize = 50;
      for (let i = 0; i < toSubscribe.length; i += chunkSize) {
        const chunk = toSubscribe.slice(i, i + chunkSize);
        const filter = { kinds: [7], '#e': chunk, limit: 800 };
        if (sinceTs) filter.since = sinceTs;
        try {
          const sub = App.pool.subscribeMany(App.relayUrls, [filter], {
            onevent: (ev) => handleReactionEvent(ev),
            oneose: () => { try { sub?.close?.(); } catch (_) {} },
          });
          setTimeout(() => { try { sub?.close?.(); } catch (_) {} }, 10000);
        } catch (err) {
          console.warn('subscribeCommentReactions chunk failed', err);
        }
      }
    } catch (err) {
      console.warn('subscribeCommentReactions outer failed', err);
    }
  }

  App.getCommentReactionState = getCommentReactionState;
  App.toggleCommentReaction = toggleCommentReaction;
  App.subscribeCommentReactions = subscribeCommentReactions;
  App.handleCommentReactionEvent = handleReactionEvent;
  App.onCommentReaction = function onCommentReaction(ev) { handleReactionEvent(ev); };
  App.subscribeCommentReactionUpdates = function subscribeCommentReactionUpdates(cb) {
    if (typeof cb !== 'function') return () => {};
    App._commentReactionSubscribers.add(cb);
    return () => App._commentReactionSubscribers.delete(cb);
  };
})(window);
