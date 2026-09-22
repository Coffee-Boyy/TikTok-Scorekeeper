function text(value) {
  return value === undefined || value === null ? "" : String(value);
}

function first(...values) {
  return values.map(text).find(Boolean) || "";
}

function values(value) {
  if (Array.isArray(value)) return value;
  if (value && typeof value === "object") return Object.values(value);
  return [];
}

function at(object, ...path) {
  return path.reduce((value, key) => value?.[key], object);
}

function normalizeUser(candidate, source) {
  if (!candidate || typeof candidate !== "object") return null;
  const nested = candidate.user || candidate.user_info || candidate.userInfo || candidate.owner || candidate.value || {};
  const user = nested.user || nested.user_info || nested.userInfo || nested;
  const userId = first(
    candidate.user_id_str,
    candidate.userIdStr,
    candidate.user_id,
    candidate.userId,
    candidate.id_str,
    candidate.idStr,
    user.user_id_str,
    user.userIdStr,
    user.user_id,
    user.userId,
    user.id_str,
    user.idStr,
    user.id
  );
  const handle = first(
    candidate.display_id,
    candidate.displayId,
    candidate.unique_id,
    candidate.uniqueId,
    user.display_id,
    user.displayId,
    user.unique_id,
    user.uniqueId
  ).replace(/^@/, "");
  const name = first(
    candidate.nickname,
    candidate.nick_name,
    candidate.nickName,
    user.nickname,
    user.nick_name,
    user.nickName,
    handle,
    userId ? `TikTok guest ${userId.slice(-6)}` : ""
  );
  const linkMicId = first(candidate.linkmic_id_str, candidate.linkmicIdStr, candidate.linkmic_id, candidate.linkmicId);
  if (!userId && !handle) return null;
  return { userId, handle, name, linkMicId, source };
}

function pushUsers(target, source, sourceName) {
  for (const item of values(source)) {
    const normalized = normalizeUser(item, sourceName);
    if (normalized) target.push(normalized);
  }
}

function deduplicate(users, hostUserId = "", hostHandle = "") {
  const byKey = new Map();
  const normalizedHostHandle = text(hostHandle).replace(/^@/, "").toLowerCase();
  for (const user of users) {
    if (hostUserId && user.userId === text(hostUserId)) continue;
    if (normalizedHostHandle && user.handle.toLowerCase() === normalizedHostHandle) continue;
    const key = user.userId ? `id:${user.userId}` : `handle:${user.handle.toLowerCase()}`;
    const current = byKey.get(key);
    byKey.set(key, current ? {
      ...current,
      ...user,
      userId: user.userId || current.userId,
      handle: user.handle || current.handle,
      name: user.name || current.name,
      linkMicId: user.linkMicId || current.linkMicId,
      source: current.source === user.source ? current.source : `${current.source},${user.source}`
    } : user);
  }
  return [...byKey.values()];
}

export function extractPageBootstrap(liveRoomUserInfo, fallbackHostHandle = "") {
  const user = liveRoomUserInfo?.user || {};
  const liveRoom = liveRoomUserInfo?.liveRoom || {};
  const roomId = first(user.roomId, user.room_id, liveRoom.roomId, liveRoom.room_id);
  const status = Number(liveRoom.status || 0);
  if (!roomId || status !== 2) return null;
  return {
    roomId,
    streamId: first(liveRoom.streamId, liveRoom.stream_id),
    host: {
      userId: first(user.id, user.userId, user.user_id),
      handle: first(user.uniqueId, user.unique_id, fallbackHostHandle).replace(/^@/, ""),
      name: first(user.nickname, user.uniqueId, fallbackHostHandle),
      linkMicId: "",
      source: "page-bootstrap"
    }
  };
}

export function extractRoomRoster(response, fallbackHostHandle = "") {
  const room = response?.data?.data || response?.data || response?.room || response || {};
  const owner = room.owner || room.room?.owner || {};
  const host = normalizeUser(owner, "room-owner") || {
    userId: first(room.owner_user_id, room.ownerUserId),
    handle: text(fallbackHostHandle).replace(/^@/, ""),
    name: text(fallbackHostHandle).replace(/^@/, ""),
    linkMicId: "",
    source: "room-owner"
  };
  const users = [];

  pushUsers(users, at(room, "social_interaction", "cohost", "linked_users"), "room-cohost");
  pushUsers(users, at(room, "socialInteraction", "cohost", "linkedUsers"), "room-cohost");
  pushUsers(users, at(room, "social_interaction", "multi_live", "room_multi_guest_linkmic_info", "multi_guest_linkmic_info", "linked_users"), "room-multiguest");
  pushUsers(users, at(room, "socialInteraction", "multiLive", "roomMultiGuestLinkmicInfo", "multiGuestLinkmicInfo", "linkedUsers"), "room-multiguest");
  pushUsers(users, at(room, "link_mic", "linked_users"), "room-linkmic");
  pushUsers(users, at(room, "link_mic", "linked_user_list"), "room-linkmic");
  pushUsers(users, at(room, "linkMic", "linkedUsers"), "room-linkmic");
  pushUsers(users, at(room, "linkMic", "linkedUserList"), "room-linkmic");
  pushUsers(users, at(room, "multi_guest_linkmic_info", "linked_users"), "room-multiguest-backup");
  pushUsers(users, at(room, "multiGuestLinkmicInfo", "linkedUsers"), "room-multiguest-backup");
  pushUsers(users, at(room, "group_live_session", "group_live_members"), "room-group-live");
  pushUsers(users, at(room, "groupLiveSession", "groupLiveMembers"), "room-group-live");

  const battleInfo = room.link_mic?.battle_info || room.linkMic?.battleInfo;
  pushUsers(users, battleInfo?.anchors_info || battleInfo?.anchorsInfo, "room-battle");
  pushUsers(users, battleInfo?.battle_settings?.battle_users || battleInfo?.battleSettings?.battleUsers, "room-battle");

  return {
    host,
    guests: deduplicate(users, host.userId, host.handle)
  };
}

export function extractLinkEventRoster(event, hostUserId = "", hostHandle = "") {
  const users = [];
  const list = event?.listChangeContent?.list || event?.list_change_content?.list;
  pushUsers(users, list?.linkedList || list?.linked_list, "link-layer");

  const cohostList = event?.businessContent?.cohostContent?.listChangeBizContent ||
    event?.business_content?.cohost_content?.list_change_biz_content;
  pushUsers(users, cohostList?.userInfos || cohostList?.user_infos, "link-cohost");
  pushUsers(users, cohostList?.guestUserInfos || cohostList?.guest_user_infos, "link-guest");

  pushUsers(users, event?.userStates || event?.user_states, "link-state");
  pushUsers(users, event?.linkedUsers || event?.linked_users, "link-method");
  pushUsers(users, event?.linkedListChangeContent?.linkedUsers || event?.linked_list_change_content?.linked_users, "link-method");
  pushUsers(users, event?.listChangeContent?.linkedUsers || event?.list_change_content?.linked_users, "link-method");
  for (const group of values(event?.groupChangeContent?.groupUser?.user || event?.group_change_content?.group_user?.user)) {
    pushUsers(users, group?.allUser?.linkedList || group?.all_user?.linked_list, "link-group");
  }
  pushUsers(users, event?.anchorsInfo || event?.anchors_info, "link-battle");

  return deduplicate(users, hostUserId, hostHandle);
}
