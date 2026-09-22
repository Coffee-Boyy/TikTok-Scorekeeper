import test from "node:test";
import assert from "node:assert/strict";
import { extractLinkEventRoster, extractPageBootstrap, extractRoomRoster } from "../src/guests.js";

test("extracts cohosts and multi-guest users from the authenticated room response", () => {
  const result = extractRoomRoster({
    data: {
      owner: { id_str: "100", display_id: "host", nickname: "Host" },
      social_interaction: {
        cohost: { linked_users: [{ user_id_str: "200", display_id: "cohost", nickname: "Co-host" }] },
        multi_live: {
          room_multi_guest_linkmic_info: {
            multi_guest_linkmic_info: {
              linked_users: [
                { user_id_str: "100", display_id: "host", nickname: "Host", linkmic_id_str: "1" },
                { user_id_str: "300", display_id: "guest", nickname: "Guest", linkmic_id_str: "2" }
              ]
            }
          }
        }
      }
    }
  });

  assert.equal(result.host.userId, "100");
  assert.deepEqual(result.guests.map(user => user.userId).sort(), ["200", "300"]);
  assert.equal(result.guests.find(user => user.userId === "300").handle, "guest");
});

test("extracts named users from link-layer business content", () => {
  const users = extractLinkEventRoster({
    businessContent: {
      cohostContent: {
        listChangeBizContent: {
          guestUserInfos: {
            first: { userIdStr: "900", displayId: "dolly", nickname: "Dolly", linkmicIdStr: "44" }
          }
        }
      }
    }
  });
  assert.deepEqual(users[0], {
    userId: "900",
    handle: "dolly",
    name: "Dolly",
    linkMicId: "44",
    source: "link-guest"
  });
});

test("keeps ID-only linked users so gifts can still be attributed", () => {
  const users = extractLinkEventRoster({
    listChangeContent: { list: { linkedList: [{ user: { userId: "777" }, linkmicId: "9" }] } }
  }, "100", "host");
  assert.equal(users[0].userId, "777");
  assert.match(users[0].name, /777/);
});

test("reads TikTok's current multi-guest backup roster and excludes the host", () => {
  const result = extractRoomRoster({ data: { multi_guest_linkmic_info: { linked_users: [
    { user: { id_str: "100", display_id: "host", nickname: "Host" } },
    { linkmic_id_str: "mic-2", user: { id_str: "200", display_id: "arliz", nickname: "Arliz" } }
  ] } } }, "host");
  assert.deepEqual(result.guests.map(user => [user.userId, user.name, user.linkMicId]), [["200", "Arliz", "mic-2"]]);
});

test("reads linked_user_list and group-change link-layer messages", () => {
  const room = extractRoomRoster({ data: {
    owner: { id_str: "100", display_id: "host" },
    link_mic: { linked_user_list: [{ user: { id_str: "200", display_id: "arliz" } }] }
  } });
  assert.equal(room.guests[0].handle, "arliz");
  const event = extractLinkEventRoster({ groupChangeContent: { groupUser: { user: [
    { allUser: { linkedList: [{ user: { userId: "100" } }, { user: { userId: "200" }, linkmicId: "mic-2" }] } }
  ] } } }, "100", "host");
  assert.deepEqual(event.map(user => user.userId), ["200"]);
});

test("extracts Group LIVE members used by agency-style streams", () => {
  const result = extractRoomRoster({
    data: {
      owner: { id_str: "100", display_id: "rcdolly07", nickname: "RC DOLLY" },
      group_live_session: {
        is_group_live_session: true,
        group_live_members: [
          { user_id: "7211537473100350001", nickname: "EBIE TANG" },
          { user_id: "7430747408827270002", nickname: "RC TRAINEE" }
        ]
      }
    }
  });
  assert.deepEqual(result.guests.map(user => user.userId), [
    "7211537473100350001",
    "7430747408827270002"
  ]);
  assert.equal(result.guests[0].source, "room-group-live");
});

test("extracts active room identity from TikTok's SIGI page bootstrap", () => {
  assert.deepEqual(extractPageBootstrap({
    user: {
      id: "7474875501757252609",
      uniqueId: "sireneyesteam",
      nickname: "OST-Siren Eyes",
      roomId: "7688161593868520200"
    },
    liveRoom: { status: 2, streamId: "2137740161972174940" }
  }), {
    roomId: "7688161593868520200",
    streamId: "2137740161972174940",
    host: {
      userId: "7474875501757252609",
      handle: "sireneyesteam",
      name: "OST-Siren Eyes",
      linkMicId: "",
      source: "page-bootstrap"
    }
  });
  assert.equal(extractPageBootstrap({ user: { roomId: "1" }, liveRoom: { status: 4 } }), null);
});
