/**
 * AC5 — Authoritative membership / block / remove state (hardening).
 * When SOS_ACCESS_CONTROL_V2=false: no membership enforcement (Package 886 legacy).
 * When V2=true: official clients use deterministic reconstructed MembershipState only.
 *
 * Architecture:
 * Kind 39003 is parameterized-replaceable (d=groupId:memberPubkey). Multi-issuer
 * relay tips are NOT authoritative. Application event-set + deterministic
 * reconstruction is authority. Same-revision multi-issuer forks → CONFLICT
 * (fail-closed) until a later ROOT checkpoint resolves. No first-seen-wins.
 * Relays are transport. No private keys.
 */
(function initMembershipState(window) {
  'use strict';

  const App = window.NostrApp || (window.NostrApp = {});

  const MEMBERSHIP_EVENT_KIND = 39003;
  const MEMBERSHIP_KIND_CLASS = 'parameterized-replaceable';
  const MEMBERSHIP_PARAMETERIZED_REPLACEABLE_INTENTIONAL = true;
  const MEMBERSHIP_D_TAG_RULE = 'd === groupId + ":" + memberPubkey (lowercase)';
  const MEMBERSHIP_D_TAG_REQUIRED = true;

  const MEMBERSHIP_EVENT_MODEL_ANALYSIS =
    'A=param-replaceable+app event-set+deterministic reconstruct; B=immutable log; C=root-only; D=embed in 39001. ' +
    'Relay replaceable key is (author,kind,d) so multi-issuer parallel tips exist.';
  const MULTI_ISSUER_REPLACEABLE_STREAM_PROBLEM = true;
  const SELECTED_MEMBERSHIP_EVENT_MODEL =
    'A_application_event_set_deterministic_reconstruct: kind 39003 d=groupId:memberPubkey; ' +
    'ingest all strict-valid events; reconstruct from highest root checkpoint then unique exact_+1 chain; ' +
    'same-revision forks → CONFLICT; root ROOT_SET_STATE/RESOLVE_CONFLICT supersedes; relay non-authoritative';
  const WHY_SELECTED_MODEL_IS_UNAMBIGUOUS =
    'Reconstruction is a pure function of the verified event set + current GROUP_CONTROL; ' +
    'arrival order never selects a winner; CONFLICT is explicit until root checkpoint';

  const MEMBERSHIP_FIRST_SEEN_WINS = false;
  const MEMBERSHIP_CONFLICT_STATE_SUPPORTED = true;
  const CONFLICT_CANDIDATES_RETAINED = true;
  const MEMBERSHIP_RECONSTRUCTION_DETERMINISTIC = true;
  const MEMBERSHIP_LOCAL_CACHE_IS_AUTHORITY = false;
  const PARAM_REPLACEABLE_COLD_START_SAFE = true;
  const PARAM_REPLACEABLE_COLD_START_RATIONALE =
    'Cold start fetches per-author latest tips (different issuers retained). Reconstruction never ' +
    'applies an incomplete delegated chain: missing revision gaps stop at highest contiguous unique ' +
    'prefix from highest root checkpoint (or rev0). Incomplete history → root checkpoint or UNKNOWN, ' +
    'never arrival-order tip. Same-author older replaces are safe because gaps fail closed.';

  const SCHEMA_NAME = 'sos-group-member';
  const SCHEMA_VERSION = 1;

  /** Public/canonical statuses + internal CONFLICT. */
  const STATUS = Object.freeze({
    ACTIVE: 'ACTIVE',
    BLOCKED: 'BLOCKED',
    REMOVED: 'REMOVED',
    UNKNOWN: 'UNKNOWN',
    CONFLICT: 'CONFLICT',
  });

  const TRANSITION = Object.freeze({
    GRANT_ACTIVE: 'GRANT_ACTIVE',
    BLOCK: 'BLOCK',
    UNBLOCK: 'UNBLOCK',
    REMOVE: 'REMOVE',
    BOOTSTRAP_ACTIVE: 'BOOTSTRAP_ACTIVE',
    ROOT_SET_STATE: 'ROOT_SET_STATE',
    RESOLVE_CONFLICT: 'RESOLVE_CONFLICT',
  });

  const ROOT_CHECKPOINT_TRANSITIONS = Object.freeze([
    TRANSITION.ROOT_SET_STATE,
    TRANSITION.RESOLVE_CONFLICT,
  ]);

  /** Transition → required capability (any-of). */
  const MEMBERSHIP_TRANSITION_CAPABILITY_MATRIX = Object.freeze({
    GRANT_ACTIVE: Object.freeze(['ROOT_ADMIN', 'MANAGE_MEMBERS']),
    BOOTSTRAP_ACTIVE: Object.freeze(['ROOT_ADMIN']),
    BLOCK: Object.freeze(['ROOT_ADMIN', 'MANAGE_BLOCKLIST', 'MANAGE_MEMBERS']),
    UNBLOCK: Object.freeze(['ROOT_ADMIN', 'MANAGE_BLOCKLIST', 'MANAGE_MEMBERS']),
    REMOVE: Object.freeze(['ROOT_ADMIN', 'MANAGE_MEMBERS']),
    ROOT_SET_STATE: Object.freeze(['ROOT_ADMIN']),
    RESOLVE_CONFLICT: Object.freeze(['ROOT_ADMIN']),
  });

  const MEMBERSHIP_ORDERING_SOURCE = 'memberRevision + deterministic reconstruct';
  const MEMBERSHIP_REVISION_RULE =
    'delegated: unique exact_+1 from reconstructed tip; root checkpoint: revision > prior tip (normally +1)';
  const MEMBERSHIP_EPOCH_RULE =
    'live events prefer membershipEpoch === control.membershipEpoch; prior-epoch retained per-member until new-epoch event exists';
  const MEMBERSHIP_EPOCH_SEMANTICS =
    'membershipEpoch is a root-authorized roster generation counter on GROUP_CONTROL. ' +
    'Normal GRANT/BLOCK/UNBLOCK/REMOVE MUST NOT bump it. Rollover to epoch E activates per-member only when ' +
    'that member has ≥1 valid epoch-E event (root ROOT_SET_STATE preferred); members without epoch-E events ' +
    'keep prior-epoch reconstruction (no silent drop). Partial global rollover never wipes the roster.';
  const MEMBERSHIP_EPOCH_NORMAL_MUTATION_BUMPS = false;
  const EPOCH_ROLLOVER_CANNOT_SILENTLY_DROP_MEMBERS = true;
  const MEMBERSHIP_EPOCH_ROLLOVER_MODEL =
    'Root bumps GROUP_CONTROL.membershipEpoch and publishes per-member ROOT_SET_STATE at the new epoch; ' +
    'rollover is root-authorized; a member migrates only after their new-epoch checkpoint/event exists';
  const MEMBERSHIP_EPOCH_ROLLOVER_ROOT_AUTHORIZED = true;
  const PARTIAL_EPOCH_ROLLOVER_ACTIVATES = false;
  const PREVIOUS_MEMBERSHIP_EPOCH_EVENT_SEMANTICS =
    'Prior-epoch events remain live for a member until that member has any valid event at the current ' +
    'control.membershipEpoch; then only current-epoch events reconstruct that member. Historical otherwise.';

  const MEMBERSHIP_RECONSTRUCTION_ALGORITHM =
    '1) collect strict-valid events for (group,member); 2) select live epoch slice (current if any, else prior); ' +
    '3) highest root checkpoint (ROOT_SET_STATE|RESOLVE_CONFLICT) = base; 4) walk revision base+1..; ' +
    '5) if exactly one distinct valid successor at rev → apply; 6) if ≥2 distinct → CONFLICT + retain candidates; ' +
    '7) later higher root checkpoint supersedes conflict; 8) revision gaps stop chain (fail closed to base prefix)';

  const LATE_CONFLICT_EVENT_BEHAVIOR =
    'Always re-ingest into event set and recompute; late same-rev fork enters/keeps CONFLICT unless a higher ' +
    'root checkpoint already supersedes that revision. No silent ignore of security-relevant forks.';

  const DELEGATED_MEMBERSHIP_PERSISTENCE_MODEL = 'current_verified_control_state';
  const HISTORICAL_MEMBERSHIP_AUTH_PROOF = 'none_safe_without_embedded_control_attestation';
  const MEMBERSHIP_HISTORY_DEPENDS_ON_UNRELIABLE_RELAY_HISTORY = false;
  const PERMANENT_DELEGATED_MEMBERSHIP_PERSISTENCE_REQUIRES_FUTURE_AUTH_PROOF = true;
  const ROOT_MEMBERSHIP_PERSISTENCE_MODEL = 'current_rootAdminPubkey_match';

  const BLOCKLIST_SOURCE_OF_TRUTH =
    'dual-authority fail-closed: membership tip AND GROUP_CONTROL.blockedPubkeys must agree for access';
  const BLOCKLIST_MEMBERSHIP_CONSISTENCY_RULE =
    'Access granted only when status=ACTIVE AND pubkey∉blockedPubkeys; any partial/disagree → deny';
  const BLOCK_TRANSACTION_PROTOCOL =
    'BLOCK phase1: GROUP_CONTROL adds pubkey to blockedPubkeys; phase2: membership tip → BLOCKED. ' +
    'Until both agree BLOCKED+listed, target denied.';
  const UNBLOCK_TRANSACTION_PROTOCOL =
    'UNBLOCK phase1: membership tip → ACTIVE (may still be listed); phase2: remove from blockedPubkeys ' +
    '(or reverse order). Target denied until BOTH status=ACTIVE AND pubkey∉blockedPubkeys.';
  const BLOCK_TRANSACTION_RECOVERY_MODEL =
    'Resume missing phase: publish outstanding control update and/or membership tip; gated checks stay ' +
    'denied until both phases agree. Root/manager may repair either side.';
  const REMOVE_TRANSACTION_PROTOCOL =
    'REMOVE phase1: membership tip → REMOVED (delegated caps ineffective immediately); ' +
    'phase2: GROUP_CONTROL removes capability assignments for pubkey.';
  const BLOCKED_CAPABILITY_STORAGE_MODEL =
    'retained_in_GROUP_CONTROL_map_but_disabled_while_BLOCKED (effective caps suppressed); UNBLOCK may restore';
  const REMOVED_MEMBER_CAPABILITY_CLEANUP_REQUIRED = true;
  const REMOVED_USER_REJOIN_MODEL =
    'REMOVED cannot self-rejoin; new GRANT_ACTIVE (invite-bound or manager grant) → ACTIVE at next revision';

  const INVITE_MEMBERSHIP_GRANT_SIGNER_MODEL =
    'Client-only: ROOT or MANAGE_MEMBERS signs GRANT_MEMBER_ACTIVE (AC9 SIGN_ADMIN_TYPED) after valid redeem; ' +
    'no browser system key; if no authorized signer present → no auto-grant';

  const MEMBERSHIP_GATED_ACTIONS = Object.freeze([
    'post_create',
    'comment_reply',
    'reaction',
    'invite_create',
    'invite_redeem',
    'group_p2p_signal',
    'group_media_publish',
    'delegated_capability_use',
  ]);
  const NON_MEMBERSHIP_GATED_ACTIONS = Object.freeze([
    'public_read_feed',
    'direct_private_chat',
    'guest_browse',
    'own_profile_view',
  ]);
  const BLOCKED_USER_PUBLIC_READ_POLICY = 'allow_public_read (no private-read conversion)';
  const REMOVED_USER_PUBLIC_READ_POLICY = 'allow_public_read (no private-read conversion)';

  const CACHE_PREFIX = 'sos_membership_v2_';

  /**
   * Per-member event set + reconstructed tip.
   * @type {Map<string, {
   *   events: Map<string, object>,
   *   record: object|null,
   *   conflictCandidates: object[]
   * }>}
   */
  const members = new Map();

  function isV2() {
    return window.SOS_ACCESS_CONTROL_V2 === true;
  }

  function normalizePubkey(value) {
    if (typeof value !== 'string') return '';
    const t = value.trim().toLowerCase().replace(/^0x/, '');
    return /^[0-9a-f]{64}$/.test(t) ? t : '';
  }

  function resolveGroupId() {
    if (typeof App.NETWORK_TAG === 'string' && App.NETWORK_TAG.trim()) return App.NETWORK_TAG.trim();
    return 'israel-network';
  }

  function canonicalD(groupId, memberPubkey) {
    return String(groupId) + ':' + normalizePubkey(memberPubkey);
  }

  function getGCS() {
    return App.GroupControlState || window.SosGroupControlState || null;
  }

  function getVerifiedControlOrNull() {
    const GCS = getGCS();
    if (!GCS || typeof GCS.getVerifiedControlState !== 'function') return null;
    if (typeof GCS.getStatus === 'function' && GCS.getStatus() !== 'VERIFIED') return null;
    const st = GCS.getVerifiedControlState();
    if (!st || st.verified !== true) return null;
    if (st.groupId !== resolveGroupId()) return null;
    return st;
  }

  function readTag(event, name) {
    if (!event || !Array.isArray(event.tags)) return '';
    for (let i = 0; i < event.tags.length; i++) {
      const t = event.tags[i];
      if (Array.isArray(t) && t[0] === name && t[1] != null) return String(t[1]);
    }
    return '';
  }

  function eventHasNetworkTag(event, groupId) {
    if (!event || !Array.isArray(event.tags)) return false;
    const want = String(groupId || '');
    return event.tags.some((t) => Array.isArray(t) && t[0] === 't' && String(t[1]) === want);
  }

  function strictVerify(event) {
    try {
      if (typeof App.verifyEventStrict === 'function') return App.verifyEventStrict(event) === true;
      if (window.NostrEventIntegrity && typeof window.NostrEventIntegrity.verifyEventStrict === 'function') {
        return window.NostrEventIntegrity.verifyEventStrict(event) === true;
      }
      if (window.NostrTools && typeof window.NostrTools.verifyEvent === 'function') {
        return window.NostrTools.verifyEvent(event) === true;
      }
    } catch (_) {}
    return false;
  }

  function isRootAdmin(pubkey, controlState) {
    const pk = normalizePubkey(pubkey);
    const state = controlState || getVerifiedControlOrNull();
    if (!pk || !state) return false;
    return pk === normalizePubkey(state.rootAdminPubkey);
  }

  function issuerCaps(issuerPubkey, controlState) {
    const pk = normalizePubkey(issuerPubkey);
    const state = controlState || getVerifiedControlOrNull();
    if (!pk || !state) return [];
    if (pk === normalizePubkey(state.rootAdminPubkey)) {
      return ['ROOT_ADMIN', 'MANAGE_MEMBERS', 'MANAGE_BLOCKLIST', 'MANAGE_ADMINS', 'MANAGE_PERMISSIONS'];
    }
    const list = (state.capabilities && state.capabilities[pk]) || [];
    return Array.isArray(list) ? list.slice() : [];
  }

  function issuerMayTransition(issuerPubkey, transition, controlState) {
    const needed = MEMBERSHIP_TRANSITION_CAPABILITY_MATRIX[transition];
    if (!needed) return false;
    const caps = issuerCaps(issuerPubkey, controlState);
    if (caps.indexOf('ROOT_ADMIN') !== -1) return true;
    return needed.some((c) => c !== 'ROOT_ADMIN' && caps.indexOf(c) !== -1);
  }

  function isRootCheckpointTransition(transition) {
    return ROOT_CHECKPOINT_TRANSITIONS.indexOf(transition) !== -1;
  }

  function parseContent(event) {
    try {
      const raw = typeof event.content === 'string' ? JSON.parse(event.content) : null;
      if (!raw || raw.schema !== SCHEMA_NAME) return null;
      if (Number(raw.version) !== SCHEMA_VERSION) return null;
      return raw;
    } catch (_) {
      return null;
    }
  }

  function memberKey(memberPubkey) {
    return resolveGroupId() + ':' + normalizePubkey(memberPubkey);
  }

  function ensureMemberBucket(pk) {
    const key = memberKey(pk);
    let bucket = members.get(key);
    if (!bucket) {
      bucket = { events: new Map(), record: null, conflictCandidates: [] };
      members.set(key, bucket);
    }
    return bucket;
  }

  function candidateMeta(event, body, issuer) {
    return Object.freeze({
      eventId: String(event.id || ''),
      memberRevision: Number(body.memberRevision),
      issuerPubkey: issuer,
      status: body.status,
      transition: body.transition,
      controlEpochAtIssue: Number(body.controlEpochAtIssue),
      membershipEpoch: Number(body.membershipEpoch),
      inviteEventId: body.inviteEventId || null,
      createdAt: Number(body.createdAt) || event.created_at,
      isRootCheckpoint: isRootCheckpointTransition(body.transition),
    });
  }

  function contentFingerprint(body) {
    return [
      body.status,
      body.transition,
      body.memberRevision,
      body.membershipEpoch,
      body.controlEpochAtIssue,
      body.issuerPubkey,
      body.inviteEventId || '',
    ].join('|');
  }

  function expectedNextStatus(prevStatus, transition, explicitStatus) {
    if (isRootCheckpointTransition(transition)) {
      if ([STATUS.ACTIVE, STATUS.BLOCKED, STATUS.REMOVED].indexOf(explicitStatus) !== -1) {
        return explicitStatus;
      }
      return null;
    }
    if (transition === TRANSITION.GRANT_ACTIVE || transition === TRANSITION.BOOTSTRAP_ACTIVE) {
      return STATUS.ACTIVE;
    }
    if (transition === TRANSITION.BLOCK) return STATUS.BLOCKED;
    if (transition === TRANSITION.UNBLOCK) return STATUS.ACTIVE;
    if (transition === TRANSITION.REMOVE) return STATUS.REMOVED;
    return null;
  }

  function transitionAllowedFrom(prevStatus, transition) {
    if (isRootCheckpointTransition(transition)) {
      // Root may set state from any non-root-protected context including CONFLICT/UNKNOWN.
      return (
        prevStatus === STATUS.UNKNOWN ||
        prevStatus === STATUS.ACTIVE ||
        prevStatus === STATUS.BLOCKED ||
        prevStatus === STATUS.REMOVED ||
        prevStatus === STATUS.CONFLICT
      );
    }
    if (prevStatus === STATUS.CONFLICT) return false;
    if (transition === TRANSITION.GRANT_ACTIVE || transition === TRANSITION.BOOTSTRAP_ACTIVE) {
      return prevStatus === STATUS.UNKNOWN || prevStatus === STATUS.REMOVED || prevStatus === STATUS.ACTIVE;
    }
    if (transition === TRANSITION.BLOCK) {
      return prevStatus === STATUS.ACTIVE || prevStatus === STATUS.UNKNOWN;
    }
    if (transition === TRANSITION.UNBLOCK) {
      return prevStatus === STATUS.BLOCKED;
    }
    if (transition === TRANSITION.REMOVE) {
      return prevStatus === STATUS.ACTIVE || prevStatus === STATUS.BLOCKED || prevStatus === STATUS.UNKNOWN;
    }
    return false;
  }

  /**
   * Structural + crypto + issuer auth validation (chain-independent).
   * Does not require exact_+1 against local tip — reconstruction owns ordering.
   */
  function validateMembershipEventStructural(event, controlState) {
    if (!event || event.kind !== MEMBERSHIP_EVENT_KIND) return { ok: false, code: 'BAD_KIND' };
    if (!strictVerify(event)) return { ok: false, code: 'STRICT_VERIFY_FAILED' };

    const groupId = resolveGroupId();
    if (!eventHasNetworkTag(event, groupId)) return { ok: false, code: 'CROSS_GROUP' };

    const d = readTag(event, 'd');
    if (!d) return { ok: false, code: 'MISSING_D_TAG' };

    const body = parseContent(event);
    if (!body) return { ok: false, code: 'BAD_SCHEMA' };
    if (String(body.groupId) !== groupId) return { ok: false, code: 'CROSS_GROUP_BODY' };

    const memberPubkey = normalizePubkey(body.memberPubkey);
    if (!memberPubkey) return { ok: false, code: 'BAD_MEMBER' };
    if (d !== canonicalD(groupId, memberPubkey)) return { ok: false, code: 'WRONG_D_TAG' };

    const pTag = normalizePubkey(readTag(event, 'p'));
    if (pTag && pTag !== memberPubkey) return { ok: false, code: 'P_TAG_MISMATCH' };

    const status = body.status;
    if ([STATUS.ACTIVE, STATUS.BLOCKED, STATUS.REMOVED].indexOf(status) === -1) {
      return { ok: false, code: 'BAD_STATUS' };
    }
    const transition = body.transition;
    if (!MEMBERSHIP_TRANSITION_CAPABILITY_MATRIX[transition]) {
      return { ok: false, code: 'BAD_TRANSITION' };
    }

    const rev = Number(body.memberRevision);
    if (!Number.isInteger(rev) || rev < 1) return { ok: false, code: 'BAD_REVISION' };

    const expected = expectedNextStatus(STATUS.UNKNOWN, transition, status);
    // For non-checkpoint, status must match transition semantics (prev checked in reconstruct).
    if (!isRootCheckpointTransition(transition)) {
      const byTransition = expectedNextStatus(STATUS.ACTIVE, transition, status);
      // soft check: status must be one of the transition's possible next statuses
      const okStatus =
        (transition === TRANSITION.GRANT_ACTIVE || transition === TRANSITION.BOOTSTRAP_ACTIVE) &&
        status === STATUS.ACTIVE
          ? true
          : transition === TRANSITION.BLOCK && status === STATUS.BLOCKED
            ? true
            : transition === TRANSITION.UNBLOCK && status === STATUS.ACTIVE
              ? true
              : transition === TRANSITION.REMOVE && status === STATUS.REMOVED
                ? true
                : false;
      if (!okStatus) return { ok: false, code: 'STATUS_TRANSITION_MISMATCH' };
    } else if (status !== expected) {
      return { ok: false, code: 'STATUS_TRANSITION_MISMATCH' };
    }
    void expected;

    const state = controlState || getVerifiedControlOrNull();
    if (!isV2()) return { ok: false, code: 'V2_REQUIRED' };
    if (!state) return { ok: false, code: 'NO_VERIFIED_CONTROL' };

    const issuer = normalizePubkey(event.pubkey);
    if (!issuer) return { ok: false, code: 'NO_ISSUER' };
    if (body.issuerPubkey && normalizePubkey(body.issuerPubkey) !== issuer) {
      return { ok: false, code: 'ISSUER_SPOOF' };
    }

    if (memberPubkey === normalizePubkey(state.rootAdminPubkey)) {
      if (status === STATUS.BLOCKED || status === STATUS.REMOVED) {
        return { ok: false, code: 'ROOT_PROTECTED' };
      }
    }

    if (issuer === memberPubkey) {
      if (
        transition === TRANSITION.GRANT_ACTIVE ||
        transition === TRANSITION.BOOTSTRAP_ACTIVE ||
        isRootCheckpointTransition(transition)
      ) {
        return { ok: false, code: 'SELF_GRANT' };
      }
      if (transition === TRANSITION.UNBLOCK) return { ok: false, code: 'SELF_UNBLOCK' };
      if (transition === TRANSITION.BLOCK || transition === TRANSITION.REMOVE) {
        return { ok: false, code: 'SELF_TARGET_FORBIDDEN' };
      }
    }

    if (!issuerMayTransition(issuer, transition, state)) {
      return { ok: false, code: 'UNAUTHORIZED_ISSUER' };
    }

    if (isRootCheckpointTransition(transition) && !isRootAdmin(issuer, state)) {
      return { ok: false, code: 'ROOT_CHECKPOINT_REQUIRED' };
    }

    return {
      ok: true,
      code: 'STRUCTURAL_OK',
      body,
      memberPubkey,
      issuer,
      groupId,
      meta: candidateMeta(event, body, issuer),
    };
  }

  /** @deprecated name kept for gate compat — structural validate only. */
  function validateMembershipTransition(event, controlState) {
    const v = validateMembershipEventStructural(event, controlState);
    if (!v.ok) return v;
    // Chain acceptance is via accept/reconstruct; expose record-shaped preview.
    return {
      ok: true,
      code: 'STRUCTURAL_OK',
      record: Object.freeze({
        groupId: v.groupId,
        memberPubkey: v.memberPubkey,
        status: v.body.status,
        memberRevision: Number(v.body.memberRevision),
        controlEpochAtIssue: Number(v.body.controlEpochAtIssue),
        membershipEpoch: Number(v.body.membershipEpoch),
        issuerPubkey: v.issuer,
        transition: v.body.transition,
        inviteEventId: v.body.inviteEventId || null,
        createdAt: Number(v.body.createdAt) || event.created_at,
      }),
    };
  }

  function selectLiveEvents(eventList, controlState) {
    const currentEpoch = Number(controlState && controlState.membershipEpoch);
    const atCurrent = eventList.filter((e) => Number(e.meta.membershipEpoch) === currentEpoch);
    if (atCurrent.length > 0) return { events: atCurrent, epoch: currentEpoch, carriedForward: false };
    // Carry prior-epoch events so rollover cannot silently drop members.
    if (!eventList.length) return { events: [], epoch: currentEpoch, carriedForward: false };
    let maxPrior = -1;
    eventList.forEach((e) => {
      const ep = Number(e.meta.membershipEpoch);
      if (ep < currentEpoch && ep > maxPrior) maxPrior = ep;
    });
    if (maxPrior < 0) return { events: [], epoch: currentEpoch, carriedForward: false };
    return {
      events: eventList.filter((e) => Number(e.meta.membershipEpoch) === maxPrior),
      epoch: maxPrior,
      carriedForward: true,
    };
  }

  function reconstructMember(memberPubkey, controlState) {
    const pk = normalizePubkey(memberPubkey);
    const state = controlState || getVerifiedControlOrNull();
    const bucket = ensureMemberBucket(pk);
    const all = [];
    bucket.events.forEach((stored) => {
      all.push(stored);
    });

    if (!state) {
      bucket.record = null;
      bucket.conflictCandidates = [];
      return { status: STATUS.UNKNOWN, record: null, conflictCandidates: [] };
    }

    const live = selectLiveEvents(all, state);
    const events = live.events.slice();

    // Highest root checkpoint
    let baseStatus = STATUS.UNKNOWN;
    let baseRev = 0;
    let baseMeta = null;
    const rootCheckpoints = events.filter(
      (e) => e.meta.isRootCheckpoint && isRootAdmin(e.meta.issuerPubkey, state)
    );
    rootCheckpoints.forEach((stored) => {
      if (stored.meta.memberRevision > baseRev) {
        baseRev = stored.meta.memberRevision;
        baseStatus = stored.meta.status;
        baseMeta = stored.meta;
      }
    });

    // Multiple distinct root checkpoints at same max revision → CONFLICT
    if (baseRev > 0) {
      const rootsAtBase = rootCheckpoints.filter((e) => e.meta.memberRevision === baseRev);
      const fps = new Set(rootsAtBase.map((e) => contentFingerprint(e.body)));
      if (fps.size > 1) {
        const candidates = rootsAtBase.map((e) => e.meta);
        const record = Object.freeze({
          groupId: resolveGroupId(),
          memberPubkey: pk,
          status: STATUS.CONFLICT,
          memberRevision: baseRev,
          membershipEpoch: live.epoch,
          conflictRevision: baseRev,
          issuerPubkey: null,
          transition: null,
          carriedForward: live.carriedForward,
        });
        bucket.record = record;
        bucket.conflictCandidates = Object.freeze(candidates.slice());
        return { status: STATUS.CONFLICT, record, conflictCandidates: candidates };
      }
    }

    let status = baseStatus;
    let rev = baseRev;
    let lastMeta = baseMeta;

    // Max revision present
    let maxRev = baseRev;
    events.forEach((e) => {
      if (e.meta.memberRevision > maxRev) maxRev = e.meta.memberRevision;
    });

    for (let r = baseRev + 1; r <= maxRev; r++) {
      const atRev = events.filter((e) => e.meta.memberRevision === r);
      if (atRev.length === 0) {
        // Gap: stop; do not skip. Higher events remain unapplied.
        break;
      }

      // Root checkpoint at this revision supersedes
      const roots = atRev.filter((e) => e.meta.isRootCheckpoint && isRootAdmin(e.meta.issuerPubkey, state));
      if (roots.length > 0) {
        const uniq = [];
        const seenFp = new Set();
        roots.forEach((e) => {
          const fp = contentFingerprint(e.body);
          if (!seenFp.has(fp)) {
            seenFp.add(fp);
            uniq.push(e);
          }
        });
        if (uniq.length > 1) {
          const candidates = uniq.map((e) => e.meta);
          const record = Object.freeze({
            groupId: resolveGroupId(),
            memberPubkey: pk,
            status: STATUS.CONFLICT,
            memberRevision: r,
            membershipEpoch: live.epoch,
            conflictRevision: r,
            issuerPubkey: null,
            transition: null,
            carriedForward: live.carriedForward,
          });
          bucket.record = record;
          bucket.conflictCandidates = Object.freeze(candidates.slice());
          return { status: STATUS.CONFLICT, record, conflictCandidates: candidates };
        }
        status = uniq[0].meta.status;
        rev = r;
        lastMeta = uniq[0].meta;
        continue;
      }

      // Delegated / normal events: valid successors from current status only
      const valid = [];
      const seenFp = new Set();
      atRev.forEach((e) => {
        if (e.meta.isRootCheckpoint) return;
        if (!transitionAllowedFrom(status, e.meta.transition)) return;
        const next = expectedNextStatus(status, e.meta.transition, e.meta.status);
        if (next !== e.meta.status) return;
        const fp = contentFingerprint(e.body) + '|' + e.meta.eventId;
        // Deduplicate identical content from same logical op (different ids still conflict)
        const contentFp = contentFingerprint(e.body);
        if (seenFp.has(contentFp)) {
          // identical content — treat as same candidate (retain first id)
          return;
        }
        seenFp.add(contentFp);
        valid.push(e);
      });

      if (valid.length === 0) {
        // Events at r but none valid from status — stop (fail closed)
        break;
      }
      if (valid.length > 1) {
        const candidates = valid.map((e) => e.meta);
        const record = Object.freeze({
          groupId: resolveGroupId(),
          memberPubkey: pk,
          status: STATUS.CONFLICT,
          memberRevision: r,
          membershipEpoch: live.epoch,
          conflictRevision: r,
          issuerPubkey: null,
          transition: null,
          carriedForward: live.carriedForward,
        });
        bucket.record = record;
        bucket.conflictCandidates = Object.freeze(candidates.slice());
        return { status: STATUS.CONFLICT, record, conflictCandidates: candidates };
      }

      status = valid[0].meta.status;
      rev = r;
      lastMeta = valid[0].meta;
    }

    if (status === STATUS.UNKNOWN || !lastMeta) {
      bucket.record = null;
      bucket.conflictCandidates = [];
      return { status: STATUS.UNKNOWN, record: null, conflictCandidates: [] };
    }

    const record = Object.freeze({
      groupId: resolveGroupId(),
      memberPubkey: pk,
      status,
      memberRevision: rev,
      controlEpochAtIssue: lastMeta.controlEpochAtIssue,
      membershipEpoch: lastMeta.membershipEpoch,
      issuerPubkey: lastMeta.issuerPubkey,
      transition: lastMeta.transition,
      inviteEventId: lastMeta.inviteEventId,
      createdAt: lastMeta.createdAt,
      carriedForward: live.carriedForward,
    });
    bucket.record = record;
    bucket.conflictCandidates = Object.freeze([]);
    return { status, record, conflictCandidates: [] };
  }

  function recomputeAll(controlState) {
    const state = controlState || getVerifiedControlOrNull();
    members.forEach((_bucket, key) => {
      const pk = key.split(':').pop();
      reconstructMember(pk, state);
    });
  }

  function getMemberState(pubkey) {
    const pk = normalizePubkey(pubkey);
    if (!pk) return STATUS.UNKNOWN;
    if (!isV2()) return STATUS.UNKNOWN;
    const state = getVerifiedControlOrNull();
    if (state && pk === normalizePubkey(state.rootAdminPubkey)) {
      return STATUS.ACTIVE;
    }
    const bucket = members.get(memberKey(pk));
    if (!bucket || !bucket.record) return STATUS.UNKNOWN;
    return bucket.record.status || STATUS.UNKNOWN;
  }

  function getConflictCandidates(pubkey) {
    const bucket = members.get(memberKey(pubkey));
    if (!bucket) return Object.freeze([]);
    return bucket.conflictCandidates || Object.freeze([]);
  }

  function isActiveMember(pubkey) {
    return getMemberState(pubkey) === STATUS.ACTIVE;
  }
  function isBlockedMember(pubkey) {
    return getMemberState(pubkey) === STATUS.BLOCKED;
  }
  function isRemovedMember(pubkey) {
    return getMemberState(pubkey) === STATUS.REMOVED;
  }
  function isConflictMember(pubkey) {
    return getMemberState(pubkey) === STATUS.CONFLICT;
  }

  function inBlockedPubkeys(pubkey, controlState) {
    const pk = normalizePubkey(pubkey);
    const state = controlState || getVerifiedControlOrNull();
    if (!pk || !state) return false;
    return (state.blockedPubkeys || []).indexOf(pk) !== -1;
  }

  /**
   * Dual-authority access: ACTIVE only if tip ACTIVE and not listed.
   * Partial BLOCK/UNBLOCK always denies.
   */
  function membershipAccessAllowed(pubkey, controlState) {
    const pk = normalizePubkey(pubkey);
    const state = controlState || getVerifiedControlOrNull();
    const st = getMemberState(pk);
    if (st !== STATUS.ACTIVE) return false;
    if (inBlockedPubkeys(pk, state)) return false;
    return true;
  }

  function membershipAllowsDelegatedCapability(pubkey) {
    if (!isV2()) return true;
    const pk = normalizePubkey(pubkey);
    if (!pk) return false;
    const state = getVerifiedControlOrNull();
    if (state && pk === normalizePubkey(state.rootAdminPubkey)) return true;
    const st = getMemberState(pk);
    if (st === STATUS.BLOCKED || st === STATUS.REMOVED || st === STATUS.CONFLICT) return false;
    if (st === STATUS.UNKNOWN) return false;
    if (st === STATUS.ACTIVE) return membershipAccessAllowed(pk, state);
    return false;
  }

  function canPerformMemberAction(pubkey, action) {
    if (!isV2()) return { ok: true, code: 'LEGACY_V2_OFF' };
    const pk = normalizePubkey(pubkey);
    if (!pk) return { ok: false, code: 'NO_PRINCIPAL' };
    if (NON_MEMBERSHIP_GATED_ACTIONS.indexOf(action) !== -1) {
      return { ok: true, code: 'NOT_GATED' };
    }
    if (MEMBERSHIP_GATED_ACTIONS.indexOf(action) === -1) {
      return { ok: true, code: 'UNLISTED_ALLOW' };
    }
    const state = getVerifiedControlOrNull();
    if (state && pk === normalizePubkey(state.rootAdminPubkey)) {
      return { ok: true, code: 'ROOT' };
    }
    const st = getMemberState(pk);
    if (st === STATUS.CONFLICT) return { ok: false, code: 'CONFLICT' };
    if (action === 'invite_redeem') {
      if (st === STATUS.BLOCKED) return { ok: false, code: 'BLOCKED' };
      if (inBlockedPubkeys(pk, state)) return { ok: false, code: 'BLOCKLIST_PARTIAL' };
      if (st === STATUS.ACTIVE) return { ok: true, code: 'ACTIVE' };
      if (st === STATUS.REMOVED || st === STATUS.UNKNOWN) return { ok: true, code: 'REDEEM_CANDIDATE' };
      return { ok: false, code: 'UNKNOWN_MEMBER' };
    }
    if (st === STATUS.ACTIVE) {
      if (!membershipAccessAllowed(pk, state)) return { ok: false, code: 'BLOCKLIST_PARTIAL' };
      return { ok: true, code: 'ACTIVE' };
    }
    if (st === STATUS.BLOCKED) return { ok: false, code: 'BLOCKED' };
    if (st === STATUS.REMOVED) return { ok: false, code: 'REMOVED' };
    // Listed but no tip yet (BLOCK phase1): deny
    if (inBlockedPubkeys(pk, state)) return { ok: false, code: 'BLOCKLIST_PARTIAL' };
    return { ok: false, code: 'UNKNOWN_MEMBER' };
  }

  function currentReconstructedRevision(memberPubkey) {
    const bucket = members.get(memberKey(memberPubkey));
    if (!bucket || !bucket.record) return 0;
    return Number(bucket.record.memberRevision) || 0;
  }

  function buildMembershipDraft(opts) {
    const groupId = resolveGroupId();
    const memberPubkey = normalizePubkey(opts && opts.memberPubkey);
    const transition = opts && opts.transition;
    if (!memberPubkey) throw Object.assign(new Error('NO_MEMBER'), { code: 'NO_MEMBER' });
    const control = getVerifiedControlOrNull();
    if (!control) throw Object.assign(new Error('NO_VERIFIED_CONTROL'), { code: 'NO_VERIFIED_CONTROL' });

    const prevStatus =
      (opts && opts.prevStatus) ||
      (getMemberState(memberPubkey) === STATUS.CONFLICT
        ? STATUS.CONFLICT
        : getMemberState(memberPubkey));

    let status;
    if (isRootCheckpointTransition(transition)) {
      status = opts && opts.status;
      if ([STATUS.ACTIVE, STATUS.BLOCKED, STATUS.REMOVED].indexOf(status) === -1) {
        throw Object.assign(new Error('BAD_STATUS'), { code: 'BAD_STATUS' });
      }
      if (!transitionAllowedFrom(prevStatus, transition)) {
        throw Object.assign(new Error('BAD_TRANSITION'), { code: 'BAD_TRANSITION' });
      }
    } else {
      status = expectedNextStatus(prevStatus, transition, null);
      if (!status) throw Object.assign(new Error('BAD_TRANSITION'), { code: 'BAD_TRANSITION' });
      if (!transitionAllowedFrom(prevStatus, transition)) {
        throw Object.assign(new Error('BAD_TRANSITION'), { code: 'BAD_TRANSITION' });
      }
    }

    if (memberPubkey === normalizePubkey(control.rootAdminPubkey)) {
      if (status === STATUS.BLOCKED || status === STATUS.REMOVED) {
        throw Object.assign(new Error('ROOT_PROTECTED'), { code: 'ROOT_PROTECTED' });
      }
    }

    const prevRev = currentReconstructedRevision(memberPubkey);
    let memberRevision;
    if (opts && Number.isInteger(opts.memberRevision) && opts.memberRevision > 0) {
      memberRevision = opts.memberRevision;
    } else {
      memberRevision = prevRev + 1;
    }
    if (isRootCheckpointTransition(transition) && memberRevision <= prevRev && prevStatus === STATUS.CONFLICT) {
      // Must advance past conflict revision
      memberRevision = prevRev + 1;
    }

    const issuerPubkey = normalizePubkey((opts && opts.issuerPubkey) || App.publicKey);
    const body = {
      schema: SCHEMA_NAME,
      version: SCHEMA_VERSION,
      groupId,
      memberPubkey,
      status,
      memberRevision,
      controlEpochAtIssue: control.controlEpoch,
      // Normal mutations do NOT bump membershipEpoch
      membershipEpoch: control.membershipEpoch,
      issuerPubkey,
      transition,
      createdAt: Math.floor(Date.now() / 1000),
    };
    if (opts && opts.inviteEventId) body.inviteEventId = String(opts.inviteEventId).toLowerCase();
    if (opts && opts.reason) body.reason = String(opts.reason).slice(0, 200);
    const d = canonicalD(groupId, memberPubkey);
    return {
      kind: MEMBERSHIP_EVENT_KIND,
      created_at: body.createdAt,
      tags: [
        ['d', d],
        ['p', memberPubkey],
        ['t', groupId],
        ['t', 'sos-group-member'],
        ['status', status],
        ['member-revision', String(memberRevision)],
        ['membership-epoch', String(body.membershipEpoch)],
        ['control-epoch', String(body.controlEpochAtIssue)],
      ],
      content: JSON.stringify(body),
      pubkey: issuerPubkey,
    };
  }

  function acceptMembershipEvent(event, controlState) {
    const v = validateMembershipEventStructural(event, controlState);
    if (!v.ok) return v;
    const state = controlState || getVerifiedControlOrNull();
    const bucket = ensureMemberBucket(v.memberPubkey);
    // Idempotent store by event id
    bucket.events.set(String(event.id), {
      event,
      body: v.body,
      meta: v.meta,
    });
    const result = reconstructMember(v.memberPubkey, state);
    persistCache();
    if (result.status === STATUS.CONFLICT) {
      return {
        ok: true,
        code: 'CONFLICT',
        record: result.record,
        conflictCandidates: result.conflictCandidates,
      };
    }
    return { ok: true, code: 'STORED', record: result.record };
  }

  /** Ingest many events (any order); deterministic reconstruct. */
  function ingestMembershipEvents(eventList, controlState) {
    const state = controlState || getVerifiedControlOrNull();
    const list = Array.isArray(eventList) ? eventList : [];
    const outcomes = [];
    list.forEach((ev) => {
      const v = validateMembershipEventStructural(ev, state);
      if (!v.ok) {
        outcomes.push({ ok: false, code: v.code, eventId: ev && ev.id });
        return;
      }
      const bucket = ensureMemberBucket(v.memberPubkey);
      bucket.events.set(String(ev.id), { event: ev, body: v.body, meta: v.meta });
      outcomes.push({ ok: true, code: 'INGESTED', memberPubkey: v.memberPubkey, eventId: ev.id });
    });
    // Recompute all touched members
    const touched = new Set(outcomes.filter((o) => o.ok).map((o) => o.memberPubkey));
    touched.forEach((pk) => reconstructMember(pk, state));
    persistCache();
    return outcomes;
  }

  function clearTips() {
    members.clear();
    try {
      localStorage.removeItem(CACHE_PREFIX + resolveGroupId());
      // Also clear legacy v1 cache key
      localStorage.removeItem('sos_membership_v1_' + resolveGroupId());
    } catch (_) {}
  }

  function persistCache() {
    try {
      const rows = [];
      members.forEach((bucket) => {
        bucket.events.forEach((stored) => {
          rows.push({ event: stored.event });
        });
      });
      localStorage.setItem(
        CACHE_PREFIX + resolveGroupId(),
        JSON.stringify({ v: 2, rows, updatedAt: Date.now() })
      );
    } catch (_) {}
  }

  function loadCache() {
    try {
      const raw = localStorage.getItem(CACHE_PREFIX + resolveGroupId());
      if (!raw) return;
      const parsed = JSON.parse(raw);
      const rows = Array.isArray(parsed && parsed.rows) ? parsed.rows : [];
      const events = rows.map((r) => r && r.event).filter(Boolean);
      // Cache is optimization only — re-ingest through structural validate + reconstruct
      ingestMembershipEvents(events, null);
    } catch (_) {}
  }

  function listByStatus(status) {
    const out = [];
    members.forEach((bucket) => {
      if (bucket.record && bucket.record.status === status) {
        out.push(bucket.record.memberPubkey);
      }
    });
    return out.sort();
  }

  function getKnownMemberPubkeys() {
    const out = [];
    members.forEach((bucket) => {
      if (bucket && bucket.record && bucket.record.memberPubkey) {
        out.push(bucket.record.memberPubkey);
      }
    });
    return out.sort();
  }

  /**
   * Dual-authority health relative to membership tip + blockedPubkeys.
   * ACTIVE+listed is fail-closed partial (block phase1 or unblock phase1) — UI offers both recoveries.
   * @returns {'CONSISTENT'|'PARTIAL_BLOCK'|'PARTIAL_UNBLOCK'|'CONFLICT'|'N_A'}
   */
  function getBlocklistConsistency(pubkey) {
    const pk = normalizePubkey(pubkey);
    if (!pk) return 'N_A';
    const st = getMemberState(pk);
    if (st === STATUS.CONFLICT) return 'CONFLICT';
    const listed = inBlockedPubkeys(pk);
    if (st === STATUS.BLOCKED && listed) return 'CONSISTENT';
    if (st === STATUS.BLOCKED && !listed) return 'PARTIAL_UNBLOCK';
    if (st === STATUS.ACTIVE && listed) return 'PARTIAL_BLOCK';
    if (st === STATUS.ACTIVE && !listed) return 'CONSISTENT';
    if (st === STATUS.REMOVED) return listed ? 'PARTIAL_BLOCK' : 'CONSISTENT';
    if (listed) return 'PARTIAL_BLOCK';
    return 'N_A';
  }

  function getActiveMembers() {
    return listByStatus(STATUS.ACTIVE).filter((pk) => membershipAccessAllowed(pk));
  }
  function getBlockedMembers() {
    return listByStatus(STATUS.BLOCKED);
  }
  function getRemovedMembers() {
    return listByStatus(STATUS.REMOVED);
  }
  function getConflictMembers() {
    return listByStatus(STATUS.CONFLICT);
  }
  function getMemberCounts() {
    return {
      active: getActiveMembers().length,
      blocked: getBlockedMembers().length,
      removed: getRemovedMembers().length,
      conflict: getConflictMembers().length,
      known: members.size,
    };
  }
  function getActiveMemberCount() {
    return getActiveMembers().length;
  }
  function getKnownMemberCount() {
    return members.size;
  }

  function buildGrantFromInvite(inviteEvent, redeemerPubkey) {
    const redeemer = normalizePubkey(redeemerPubkey);
    if (!redeemer) throw Object.assign(new Error('NO_REDEEMER'), { code: 'NO_REDEEMER' });
    if (!inviteEvent || !inviteEvent.id) {
      throw Object.assign(new Error('NO_INVITE'), { code: 'NO_INVITE' });
    }
    return buildMembershipDraft({
      memberPubkey: redeemer,
      transition: TRANSITION.GRANT_ACTIVE,
      inviteEventId: inviteEvent.id,
      reason: 'invite_redeem',
    });
  }

  function buildPreexistingMemberCandidates(pubkeys) {
    const list = Array.isArray(pubkeys) ? pubkeys : [];
    return list
      .map((p) => normalizePubkey(p))
      .filter(Boolean)
      .map((memberPubkey) => ({
        memberPubkey,
        statusProposal: STATUS.ACTIVE,
        requiresRootApproval: true,
        autoAuthorized: false,
      }));
  }

  function getMemberSnapshot(pubkey) {
    const pk = normalizePubkey(pubkey);
    const bucket = members.get(memberKey(pk));
    if (!bucket) return null;
    return Object.freeze({
      status: getMemberState(pk),
      record: bucket.record,
      conflictCandidates: (bucket.conflictCandidates || []).slice(),
      eventIds: Array.from(bucket.events.keys()).sort(),
    });
  }

  /** AC9: signed tip event for typed membership signer revision binding. */
  function getVerifiedMemberTipEvent(pubkey) {
    const pk = normalizePubkey(pubkey);
    const bucket = members.get(memberKey(pk));
    if (!bucket || !bucket.record) return null;
    const rev = Number(bucket.record.memberRevision);
    const status = bucket.record.status;
    let found = null;
    bucket.events.forEach((stored) => {
      if (
        stored &&
        stored.meta &&
        Number(stored.meta.memberRevision) === rev &&
        stored.meta.status === status &&
        stored.event
      ) {
        found = stored.event;
      }
    });
    if (!found) return null;
    try {
      return JSON.parse(JSON.stringify(found));
    } catch (_e) {
      return found;
    }
  }

  let cacheLoaded = false;
  function ensureCache() {
    if (cacheLoaded) return;
    cacheLoaded = true;
    if (isV2()) loadCache();
  }

  const api = {
    MEMBERSHIP_EVENT_KIND,
    MEMBERSHIP_KIND_CLASS,
    MEMBERSHIP_PARAMETERIZED_REPLACEABLE_INTENTIONAL,
    MEMBERSHIP_D_TAG_RULE,
    MEMBERSHIP_D_TAG_REQUIRED,
    MEMBERSHIP_EVENT_MODEL_ANALYSIS,
    MULTI_ISSUER_REPLACEABLE_STREAM_PROBLEM,
    SELECTED_MEMBERSHIP_EVENT_MODEL,
    WHY_SELECTED_MODEL_IS_UNAMBIGUOUS,
    MEMBERSHIP_FIRST_SEEN_WINS,
    MEMBERSHIP_CONFLICT_STATE_SUPPORTED,
    CONFLICT_CANDIDATES_RETAINED,
    MEMBERSHIP_RECONSTRUCTION_ALGORITHM,
    MEMBERSHIP_RECONSTRUCTION_DETERMINISTIC,
    LATE_CONFLICT_EVENT_BEHAVIOR,
    MEMBERSHIP_LOCAL_CACHE_IS_AUTHORITY,
    PARAM_REPLACEABLE_COLD_START_SAFE,
    PARAM_REPLACEABLE_COLD_START_RATIONALE,
    SCHEMA_NAME,
    SCHEMA_VERSION,
    STATUS,
    TRANSITION,
    ROOT_CHECKPOINT_TRANSITIONS,
    MEMBERSHIP_TRANSITION_CAPABILITY_MATRIX,
    MEMBERSHIP_ORDERING_SOURCE,
    MEMBERSHIP_REVISION_RULE,
    MEMBERSHIP_EPOCH_RULE,
    MEMBERSHIP_EPOCH_SEMANTICS,
    MEMBERSHIP_EPOCH_NORMAL_MUTATION_BUMPS,
    EPOCH_ROLLOVER_CANNOT_SILENTLY_DROP_MEMBERS,
    MEMBERSHIP_EPOCH_ROLLOVER_MODEL,
    MEMBERSHIP_EPOCH_ROLLOVER_ROOT_AUTHORIZED,
    PARTIAL_EPOCH_ROLLOVER_ACTIVATES,
    PREVIOUS_MEMBERSHIP_EPOCH_EVENT_SEMANTICS,
    DELEGATED_MEMBERSHIP_PERSISTENCE_MODEL,
    HISTORICAL_MEMBERSHIP_AUTH_PROOF,
    MEMBERSHIP_HISTORY_DEPENDS_ON_UNRELIABLE_RELAY_HISTORY,
    PERMANENT_DELEGATED_MEMBERSHIP_PERSISTENCE_REQUIRES_FUTURE_AUTH_PROOF,
    ROOT_MEMBERSHIP_PERSISTENCE_MODEL,
    BLOCKLIST_SOURCE_OF_TRUTH,
    BLOCKLIST_MEMBERSHIP_CONSISTENCY_RULE,
    BLOCK_TRANSACTION_PROTOCOL,
    UNBLOCK_TRANSACTION_PROTOCOL,
    BLOCK_TRANSACTION_RECOVERY_MODEL,
    REMOVE_TRANSACTION_PROTOCOL,
    BLOCKED_CAPABILITY_STORAGE_MODEL,
    REMOVED_MEMBER_CAPABILITY_CLEANUP_REQUIRED,
    REMOVED_USER_REJOIN_MODEL,
    INVITE_MEMBERSHIP_GRANT_SIGNER_MODEL,
    MEMBERSHIP_GATED_ACTIONS,
    NON_MEMBERSHIP_GATED_ACTIONS,
    BLOCKED_USER_PUBLIC_READ_POLICY,
    REMOVED_USER_PUBLIC_READ_POLICY,
    isV2,
    normalizePubkey,
    resolveGroupId,
    canonicalD,
    getMemberState,
    getConflictCandidates,
    isActiveMember,
    isBlockedMember,
    isRemovedMember,
    isConflictMember,
    canPerformMemberAction,
    membershipAllowsDelegatedCapability,
    membershipAccessAllowed,
    buildMembershipDraft,
    validateMembershipTransition,
    validateMembershipEventStructural,
    acceptMembershipEvent,
    ingestMembershipEvents,
    reconstructMember,
    recomputeAll,
    clearTips,
    loadCache,
    ensureCache,
    getActiveMembers,
    getBlockedMembers,
    getRemovedMembers,
    getConflictMembers,
    getKnownMemberPubkeys,
    getBlocklistConsistency,
    getMemberCounts,
    getActiveMemberCount,
    getKnownMemberCount,
    getMemberSnapshot,
    getVerifiedMemberTipEvent,
    buildGrantFromInvite,
    buildPreexistingMemberCandidates,
    issuerMayTransition,
    getVerifiedControlOrNull,
    isRootAdmin,
    strictVerify,
    readTag,
    inBlockedPubkeys,
  };

  Object.freeze(api);
  App.MembershipState = api;
  window.SosMembershipState = api;
})(typeof window !== 'undefined' ? window : globalThis);
