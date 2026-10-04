// Which account uses which of a home's API keys (docs/ACCOUNTS.md), so that revoking a device's key
// at home also ends its account's membership. The cloud learns a key from the key an invitation
// made (join_result) and from each sealed request the home accepted with it (only the key's holder
// can seal one). A shared device's key may belong to several accounts. The controller says which
// keys still exist (a "keys" message, docs/RELAY.md). Both run in the home's Durable Object, in the
// order the controller sent them (home-relay.js), so a request answered just before a key was
// revoked cannot record the revoked key again.

const KEY_ID = /^[0-9a-f]{8}$/;
const MAX_KEYS = 1000;

function iso(ms = Date.now()) {
  return new Date(ms).toISOString();
}

function log(event, fields) {
  console.log(JSON.stringify({ event, ...fields }));
}

export function validKeyId(value) {
  return typeof value === "string" && KEY_ID.test(value);
}

export function validKeyList(ids) {
  return Array.isArray(ids) && ids.length <= MAX_KEYS && ids.every(validKeyId);
}

// Records that `userId` used `keyId`, unless it is known already. `announced`: the controller's
// last list of key ids (a Set), or null when it never sent one (drivers before 0.11.0); a key
// missing from it is not recorded.
export async function recordUsedKey(env, homeId, userId, keyId, announced) {
  if (!validKeyId(keyId) || (announced && !announced.has(keyId))) {
    return false;
  }
  const known = await env.DB.prepare("SELECT 1 AS found FROM member_keys WHERE home_id = ? AND key_id = ? AND user_id = ?").bind(homeId, keyId, userId).first();
  if (!known) {
    await env.DB.prepare("INSERT OR IGNORE INTO member_keys (home_id, key_id, user_id, added_at) SELECT ?, ?, ?, ? WHERE EXISTS (SELECT 1 FROM members WHERE home_id = ? AND user_id = ?)")
      .bind(homeId, keyId, userId, iso(), homeId, userId)
      .run();
  }
  return true;
}

// The controller's list of the key ids that exist, as one transaction: members (never the owner)
// who had keys and have none left in it leave the home, and the other keys are forgotten, with the
// browsers registered for their alerts (ADR-050). Returns the accounts that left.
export async function syncKeys(env, homeId, ids) {
  const list = JSON.stringify(ids);
  const [{ results: left }, { results: gone }] = await env.DB.batch([
    env.DB.prepare(
      "DELETE FROM members WHERE home_id = ?1 AND user_id <> COALESCE((SELECT owner_id FROM homes WHERE id = ?1), '') " +
        "AND EXISTS (SELECT 1 FROM member_keys WHERE member_keys.home_id = ?1 AND member_keys.user_id = members.user_id) " +
        "AND NOT EXISTS (SELECT 1 FROM member_keys WHERE member_keys.home_id = ?1 AND member_keys.user_id = members.user_id AND member_keys.key_id IN (SELECT value FROM json_each(?2))) " +
        "RETURNING user_id"
    ).bind(homeId, list),
    env.DB.prepare("DELETE FROM member_keys WHERE home_id = ?1 AND key_id NOT IN (SELECT value FROM json_each(?2)) RETURNING key_id").bind(homeId, list),
    env.DB.prepare("DELETE FROM push_subscriptions WHERE home_id = ?1 AND key_id IS NOT NULL AND key_id NOT IN (SELECT value FROM json_each(?2))").bind(homeId, list),
  ]);
  if (gone.length || left.length) {
    log("keys_revoked_at_home", { home: homeId, keys: [...new Set(gone.map((row) => row.key_id))], members_left: left.map((row) => row.user_id) });
  }
  return left.map((row) => row.user_id);
}
