(function initProfileEngagement(window) {
  // חלק אנגייג'מנט פרופיל (profile-engagement.js) – מטפל בטעינת לייקים ותגובות לפוסטים בפרופיל כדי להציג מונים זהים לפיד
  const App = window.NostrApp || (window.NostrApp = {});

  // חלק בדיקת מפות (profile-engagement.js) – מוודא שמבני הנתונים לאגירת לייקים ותגובות קיימים עבור כל פוסט מבוקש
  function ensureEngagementMaps(postIds) {
    if (!(App.likesByEventId instanceof Map)) {
      App.likesByEventId = new Map();
    }
    if (!(App.commentsByParent instanceof Map)) {
      App.commentsByParent = new Map();
    }
    postIds.forEach((id) => {
      if (!id) {
        return;
      }
      if (!App.likesByEventId.has(id)) {
        App.likesByEventId.set(id, new Set());
      }
      if (!App.commentsByParent.has(id)) {
        App.commentsByParent.set(id, new Map());
      }
    });
  }

  // חלק עזר (profile-engagement.js) – מפצל מערך לחבילות קטנות לטובת בקשות relays יעילות
  function chunkArray(source, size) {
    const chunks = [];
    for (let index = 0; index < source.length; index += size) {
      chunks.push(source.slice(index, index + size));
    }
    return chunks;
  }

  // חלק שאילתת ריליים (profile-engagement.js) – מנסה להשתמש בכל ה-API האפשריים של SimplePool כדי להחזיר אירועים
  async function listEventsThroughPool(filters) {
    const pool = App.pool;
    const relays = Array.isArray(App.relayUrls) ? App.relayUrls : [];
    if (!pool || relays.length === 0) {
      return [];
    }
    if (typeof pool.list === 'function') {
      return pool.list(relays, filters);
    }
    if (typeof pool.listMany === 'function') {
      return pool.listMany(relays, filters);
    }
    if (typeof pool.querySync === 'function') {
      const primaryFilter = Array.isArray(filters) && filters.length ? filters[0] : filters;
      const result = await pool.querySync(relays, primaryFilter);
      if (!result) {
        return [];
      }
      if (Array.isArray(result)) {
        return result;
      }
      if (Array.isArray(result.events)) {
        return result.events;
      }
      return [];
    }
    return [];
  }

  // חלק משיכת אירועים (profile-engagement.js) – שולח בקשות relays עבור kind ספציפי עם פילטר '#e'
  async function fetchEngagementEvents(kind, postIds, baseFilter, limitMultiplier) {
    if (!Array.isArray(postIds) || postIds.length === 0) {
      return [];
    }
    if (!App.pool || !Array.isArray(App.relayUrls) || App.relayUrls.length === 0) {
      return [];
    }

    const results = [];
    const batches = chunkArray(postIds, 40);
    for (const batch of batches) {
      const filter = Object.assign(
        {
          kinds: [kind],
          '#e': batch,
          limit: Math.min(800, Math.max(50, batch.length * limitMultiplier)),
        },
        baseFilter,
      );
      try {
        const events = await listEventsThroughPool([filter]);
        if (Array.isArray(events) && events.length) {
          results.push(...events);
        }
      } catch (err) {
        console.warn(`Failed fetching kind ${kind} engagement batch`, err);
      }
    }
    return results;
  }

  // חלק עדכון מפות (profile-engagement.js) – משלב לייקים שקיבלנו למבנה הנתונים המרכזי
  function integrateLikes(events, postIdSet) {
    if (!Array.isArray(events)) {
      return;
    }
    if (!(App.profileLikeTimeline instanceof Map)) {
      App.profileLikeTimeline = new Map();
    }
    if (!(App.profileLikeTimelineByParent instanceof Map)) {
      App.profileLikeTimelineByParent = new Map();
    }

    events.forEach((event) => {
      if (!event || event.kind !== 7 || !Array.isArray(event.tags)) {
        return;
      }
      const liker = typeof event.pubkey === 'string' ? event.pubkey.toLowerCase() : null;
      const isUnlike = typeof event.content === 'string' && event.content.trim() === '-';
      event.tags.forEach((tag) => {
        if (!Array.isArray(tag)) {
          return;
        }
        if (tag[0] !== 'e' || !postIdSet.has(tag[1])) {
          return;
        }
        if (!App.likesByEventId.has(tag[1])) {
          App.likesByEventId.set(tag[1], new Set());
        }
        const likeSet = App.likesByEventId.get(tag[1]);
        if (!liker) {
          return;
        }
        if (!App.profileLikeTimelineByParent.has(tag[1])) {
          App.profileLikeTimelineByParent.set(tag[1], new Map());
        }
        const timelineByParent = App.profileLikeTimelineByParent.get(tag[1]);
        const likeKey = `${tag[1]}::${liker}`;
        if (isUnlike) {
          likeSet.delete(liker);
          App.profileLikeTimeline.delete(likeKey);
          timelineByParent.delete(liker);
        } else {
          likeSet.add(liker);
          if (typeof event.created_at === 'number') {
            App.profileLikeTimeline.set(likeKey, {
              parentId: tag[1],
              pubkey: liker,
              created_at: event.created_at,
            });
            timelineByParent.set(liker, event.created_at);
          }
        }
      });
    });
  }

  // חלק עדכון מפות (profile-engagement.js) – משלב תגובות למפת התגובות לפי מזהה פוסט אב
  function integrateComments(events, postIdSet, extractParentId) {
    if (!Array.isArray(events)) {
      return;
    }
    if (!(App.profileCommentTimeline instanceof Map)) {
      App.profileCommentTimeline = new Map();
    }
    events.forEach((event) => {
      const parentId = extractParentId(event);
      if (!parentId || !postIdSet.has(parentId)) {
        return;
      }
      if (!App.commentsByParent.has(parentId)) {
        App.commentsByParent.set(parentId, new Map());
      }
      const commentMap = App.commentsByParent.get(parentId);
      commentMap.set(event.id, event);
      if (event?.id && typeof event.created_at === 'number') {
        App.profileCommentTimeline.set(event.id, event);
      }
    });
  }

  // חלק תזרים נתונים (profile-engagement.js) – טוען לייקים ותגובות עבור מערך פוסטים שנבחר
  async function hydrateEngagementForPosts(posts = [], extractParentId) {
    if (!Array.isArray(posts) || posts.length === 0) {
      return;
    }

    const postIds = posts
      .map((event) => (event && typeof event.id === 'string' ? event.id : null))
      .filter(Boolean);
    if (!postIds.length) {
      return;
    }

    App.profileLikeTimeline = new Map();
    App.profileLikeTimelineByParent = new Map();
    App.profileCommentTimeline = new Map();

    ensureEngagementMaps(postIds);

    if (!App.pool || !Array.isArray(App.relayUrls) || App.relayUrls.length === 0) {
      return;
    }

    const postIdSet = new Set(postIds);
    const baseFilter = {};
    if (App.NETWORK_TAG) {
      baseFilter['#t'] = [App.NETWORK_TAG];
    }

    const [commentEvents, likeEvents] = await Promise.all([
      fetchEngagementEvents(1, postIds, baseFilter, 40),
      fetchEngagementEvents(7, postIds, baseFilter, 25),
    ]);

    const parentResolver =
      typeof extractParentId === 'function'
        ? extractParentId
        : (event) => {
            if (!event || !Array.isArray(event.tags)) {
              return null;
            }
            let fallback = null;
            for (const tag of event.tags) {
              if (!Array.isArray(tag)) {
                continue;
              }
              if (tag[0] === 'e' && typeof tag[1] === 'string') {
                const marker = tag[3];
                if (marker === 'root') {
                  return tag[1];
                }
                if (!fallback) {
                  fallback = tag[1];
                }
              }
            }
            return fallback;
          };

    integrateComments(commentEvents, postIdSet, parentResolver);
    integrateLikes(likeEvents, postIdSet);
  }

  App.hydrateEngagementForPosts = hydrateEngagementForPosts;
})(window);
