-- Scene links (ADR-051, src/core/scene_links.lua, src/api/handlers/scene_links.lua): admins make,
-- replace and remove a scene's link; the controller keeps a hash of its secret only; a scene that
-- opens doors or gates never has one; a run comes over the relay (`link`), checked in constant time,
-- limited per link, run as a member's key and kept in the history.

local Mock = require("c4mock")
local T = require("helpers")
local Json = require("src.core.json")
local Harness = require("relay_harness")

local tests = {}

local STORE = "directorlink_scene_links"
local NIGHT = {
    name = "Good night",
    icon = "moon",
    steps = {
        { type = "lights", device_ids = { 20, 21 }, set = { on = false } },
        { type = "blinds", room_id = 11, set = { position = 0 } },
    },
}
local GATE_STEP = { type = "relays", device_ids = { 70 }, set = { action = "pulse" } }

-- A driver with an admin key, a scene, and Remote Access on and connected (the relay accepted the
-- home: linked). Options: remote = false for no relay at all.
local function start(options)
    options = options or {}
    local mock = Mock.startDriver(nil, nil, nil, options.prepare)
    local key = T.pair(mock, "Owner phone")
    local keyId = T.http(mock, "GET", "/v1/api-keys/current", { key = key }).json.id
    local connection, home
    if options.remote ~= false then
        local _
        _, connection = Harness.connected({ mock = mock })
        home = T.http(mock, "GET", "/v1/remote", { key = key }).json.home_id
    end
    local scene = T.http(mock, "POST", "/v1/scenes", { key = key, body = options.scene or NIGHT })
    T.eq(scene.status, 201, scene.body)
    return { mock = mock, key = key, keyId = keyId, connection = connection, home = home, scene = scene.json }
end

local function makeLink(s, sceneId, body)
    return T.http(s.mock, "POST", "/v1/scenes/" .. (sceneId or s.scene.id) .. "/link", { key = s.key, body = body })
end

local counter = 0

-- A run as the account service passes it on; returns the driver's answer.
local function run(s, linkId, secret)
    counter = counter + 1
    local reply = Harness.relayRequest(s.mock, s.connection, { type = "link", id = "link-" .. counter, link = linkId, secret = secret })
    T.eq(reply.type, "link_result")
    T.eq(reply.id, "link-" .. counter, "the answer names its request")
    return reply
end

local function stored(mock)
    local value = mock.persist[STORE]
    return type(value) == "string" and Json.decode(value:gsub("^json:", "")) or nil
end

local function history(s, kind)
    return T.http(s.mock, "GET", "/v1/activity?kind=" .. (kind or "scene,access"), { key = s.key }).json.items
end

local function createKey(s, role)
    local created = T.http(s.mock, "POST", "/v1/api-keys", { key = s.key, body = { name = role .. " phone", role = role } })
    T.eq(created.status, 201, created.body)
    return created.json.key
end

function tests.an_admin_makes_a_link_and_only_its_hash_is_kept()
    local s = start()
    local made = makeLink(s, nil, { label = "  Arriving home " })
    T.eq(made.status, 201, made.body)
    local link = made.json
    T.truthy(link.link_id:match("^%x%x%x%x%x%x%x%x$"), "an id of 8 hex digits")
    T.truthy(#link.secret == 40 and link.secret:match("^[0-9a-f]+$"), "a secret of 160 bits: " .. tostring(link.secret))
    T.eq(link.scene_id, s.scene.id)
    T.eq(link.scene_name, "Good night")
    T.eq(link.label, "Arriving home", "trimmed")
    T.eq(link.home_id, s.home)
    T.eq(link.replaced, false)
    T.eq(link.last_used_at, Json.null)
    T.eq(link.url, "https://api.directorlink.io/run/" .. s.home .. "." .. link.link_id .. "#" .. link.secret, "the secret after #, never sent by a browser")

    -- Kept: the hash, never the secret, in the store, the list, the log or the history.
    local raw = s.mock.persist[STORE]
    T.notContains(raw, link.secret, "the store has no secret")
    local record = stored(s.mock).links[1]
    T.eq(record.alg, "sha256")
    T.eq(record.hash, C4:Hash("SHA256", link.secret, { return_encoding = "HEX" }):lower())
    T.eq(record.home, s.home)
    local list = T.http(s.mock, "GET", "/v1/scene-links", { key = s.key })
    T.eq(list.status, 200, list.body)
    T.eq(#list.json.items, 1)
    T.eq(list.json.items[1].link_id, link.link_id)
    T.eq(list.json.items[1].scene_name, "Good night")
    T.eq(list.json.remote_access, true)
    T.eq(list.json.home_linked, true)
    T.notContains(list.body, link.secret)
    T.eq(T.http(s.mock, "GET", "/v1/scenes/" .. s.scene.id .. "/link", { key = s.key }).json.link_id, link.link_id)
    T.notContains(T.http(s.mock, "GET", "/v1/logs?limit=500", { key = s.key }).body, link.secret, "nor the log")
    local entry = history(s, "access")[1]
    T.eq(entry.action, "link_created")
    T.eq(entry.what, "Good night")
    T.eq(entry.note, "Arriving home")
    T.eq(entry.who.type, "key")
    T.eq(entry.ids.link_id, link.link_id)
    T.eq(T.http(s.mock, "GET", "/v1/system", { key = s.key }).json.features.scene_links, true)
end

function tests.links_are_for_admins_and_need_remote_access_and_a_linked_home()
    local s = start({ remote = false })
    local refused = makeLink(s)
    T.eq(refused.status, 409)
    T.eq(refused.json.code, "REMOTE_ACCESS_OFF")
    -- On, but the relay has not accepted the home yet.
    Properties["Remote Access"] = "On"
    OnPropertyChanged("Remote Access")
    refused = makeLink(s)
    T.eq(refused.status, 409)
    T.eq(refused.json.code, "HOME_NOT_LINKED")
    local list = T.http(s.mock, "GET", "/v1/scene-links", { key = s.key }).json
    T.eq(list.remote_access, true)
    T.eq(list.home_linked, false)

    local member = createKey(s, "member")
    for _, request in ipairs({ { "GET", "/v1/scene-links" }, { "POST", "/v1/scenes/" .. s.scene.id .. "/link" }, { "GET", "/v1/scenes/" .. s.scene.id .. "/link" }, { "DELETE", "/v1/scenes/" .. s.scene.id .. "/link" } }) do
        T.eq(T.http(s.mock, request[1], request[2], { key = member }).status, 403, request[1] .. " " .. request[2])
    end
    T.eq(makeLink(s, "deadbeef").status, 404)
    T.eq(makeLink(s, "nothex").status, 400)
    T.eq(T.http(s.mock, "GET", "/v1/scenes/" .. s.scene.id .. "/link", { key = s.key }).status, 404, "no link yet")
end

function tests.a_label_is_optional_and_checked()
    local s = start()
    T.eq(makeLink(s, nil, { label = "" }).json.label, Json.null)
    T.eq(makeLink(s).json.label, Json.null, "no body")
    T.eq(makeLink(s, nil, { label = string.rep("x", 65) }).status, 400)
    T.eq(makeLink(s, nil, { label = 5 }).status, 400)
    T.eq(makeLink(s, nil, { secret = "mine" }).status, 400, "nobody chooses the secret")
end

function tests.a_scene_link_runs_the_scene_as_a_member_and_goes_into_the_history()
    local s = start()
    local link = makeLink(s, nil, { label = "NFC by the door" }).json
    local before = #s.mock.commands
    local reply = run(s, link.link_id, link.secret)
    T.eq(reply.ok, true)
    T.eq(reply.result, "ran")
    T.truthy(#s.mock.commands > before, "the scene's devices got their commands")

    local entry = history(s, "scene")[1]
    T.eq(entry.action, "run")
    T.eq(entry.what, "Good night")
    T.eq(entry.who.type, "link")
    T.eq(entry.who.link_id, link.link_id)
    T.eq(entry.who.name, "NFC by the door")
    T.eq(entry.ids.scene_id, s.scene.id)
    T.eq(entry.ids.link_id, link.link_id)
    T.eq(entry.outcome, "ran")
    T.truthy(entry.counts.ran > 0)
    T.truthy(T.http(s.mock, "GET", "/v1/scene-links", { key = s.key }).json.items[1].last_used_at ~= Json.null, "when it was last used")
    T.contains(s.mock.properties["Last Automation"], "a scene link (NFC by the door)")
    T.notContains(T.http(s.mock, "GET", "/v1/logs?limit=500", { key = s.key }).body, link.secret, "the secret is never logged")
    -- Upper-case hex is the same secret.
    T.eq(run(s, link.link_id, link.secret:upper()).ok, true)
end

function tests.a_run_that_skips_devices_says_partly()
    local s = start({ scene = { name = "Mixed", steps = { { type = "lights", device_ids = { 20, 21 }, set = { on = true } } } } })
    local link = makeLink(s).json
    -- One of its lights was removed in Composer since.
    Mock.removeDevice(s.mock.project, 21)
    ExecuteCommand("LUA_ACTION", { ACTION = "REFRESH_PROJECT" })
    T.eq(run(s, link.link_id, link.secret).result, "partly")
    local entry = history(s, "scene")[1]
    T.eq(entry.counts.ran, 1)
    T.eq(entry.counts.skipped, 1)
end

-- A level for a room goes to its dimmers only (ADR-077, 2026-10-09): the switch it leaves as it is
-- was not to be set, so the run "ran".
function tests.switches_a_level_for_a_room_leaves_as_they_are_do_not_make_a_run_partly()
    local s = start({ scene = { name = "Evening", steps = { { type = "lights", room_id = 11, set = { brightness = 50 } } } } })
    local link = makeLink(s).json
    local before = #s.mock.commands
    T.eq(run(s, link.link_id, link.secret).result, "ran")
    for index = before + 1, #s.mock.commands do
        T.truthy(s.mock.commands[index].device ~= 21, "the switch stays as it is")
    end
    local entry = history(s, "scene")[1]
    T.eq(entry.outcome, "ran")
    T.same(entry.counts, { ran = 1, skipped = 1, failed = 0, on_off_only = 1 })
end

function tests.a_wrong_secret_or_an_unknown_link_are_refused_alike()
    local s = start()
    local link = makeLink(s).json
    local before = #s.mock.commands
    local wrong = link.secret:sub(1, 39) .. (link.secret:sub(40) == "0" and "1" or "0")
    for _, case in ipairs({
        { link.link_id, wrong },
        { link.link_id, link.secret:sub(1, 39) },
        { link.link_id, link.secret .. "0" },
        { link.link_id, string.rep("z", 40) },
        { link.link_id, 42 },
        { "00000000", link.secret },
        { "ABCDEF12", link.secret },
        { 7, link.secret },
    }) do
        local reply = run(s, case[1], case[2])
        T.eq(reply.ok, false)
        T.eq(reply.code, "NOT_FOUND")
        T.eq(reply.result, nil)
    end
    T.eq(#s.mock.commands, before, "nothing ran")
    T.eq(#history(s, "scene"), 0, "refusals are not runs")
    -- Logged without the secret, and not once per refusal.
    local logs = T.http(s.mock, "GET", "/v1/logs?limit=500", { key = s.key }).body
    T.notContains(logs, link.secret)
    T.notContains(logs, wrong)
    local _, refusals = logs:gsub("refused a scene link run", "")
    T.eq(refusals, 1, "a flood of wrong secrets does not fill the log")
end

function tests.runs_of_one_link_are_limited()
    local s = start()
    local link = makeLink(s).json
    local other = T.http(s.mock, "POST", "/v1/scenes", { key = s.key, body = { name = "Morning", steps = { { type = "lights", room_id = 10, set = { on = true } } } } }).json
    local second = makeLink(s, other.id).json
    for index = 1, 6 do
        T.eq(run(s, link.link_id, link.secret).ok, true, "run " .. index)
    end
    local limited = run(s, link.link_id, link.secret)
    T.eq(limited.ok, false)
    T.eq(limited.code, "RATE_LIMITED")
    T.truthy(limited.retry_s >= 1 and limited.retry_s <= 60)
    T.eq(run(s, second.link_id, second.secret).ok, true, "per link: another scene's link still runs")
    T.eq(#history(s, "scene"), 7, "six runs and the other link's, not the refused one")
    -- A minute later it runs again.
    local realTime = os.time
    os.time = function(...)
        if select("#", ...) > 0 then
            return realTime(...)
        end
        return realTime() + 61
    end
    local ok, reply = pcall(run, s, link.link_id, link.secret)
    os.time = realTime
    T.truthy(ok, tostring(reply))
    T.eq(reply.ok, true)
end

function tests.replacing_a_link_ends_the_old_one_at_once()
    local s = start()
    local first = makeLink(s, nil, { label = "Old" }).json
    local second = makeLink(s, nil, { label = "New" })
    T.eq(second.status, 201)
    T.eq(second.json.replaced, true)
    T.truthy(second.json.link_id ~= first.link_id, "a new id")
    T.truthy(second.json.secret ~= first.secret, "a new secret")
    T.eq(#T.http(s.mock, "GET", "/v1/scene-links", { key = s.key }).json.items, 1, "one link a scene")
    T.eq(run(s, first.link_id, first.secret).code, "NOT_FOUND", "the old link")
    T.eq(run(s, second.json.link_id, first.secret).code, "NOT_FOUND", "the old secret with the new id")
    T.eq(run(s, second.json.link_id, second.json.secret).ok, true)
    T.eq(history(s, "access")[1].action, "link_replaced")
end

function tests.an_admin_removes_a_link()
    local s = start()
    local link = makeLink(s, nil, { label = "Siri" }).json
    T.eq(T.http(s.mock, "DELETE", "/v1/scenes/" .. s.scene.id .. "/link", { key = s.key }).status, 204)
    T.eq(T.http(s.mock, "DELETE", "/v1/scenes/" .. s.scene.id .. "/link", { key = s.key }).status, 404)
    T.eq(run(s, link.link_id, link.secret).code, "NOT_FOUND")
    local entry = history(s, "access")[1]
    T.eq(entry.action, "link_removed")
    T.eq(entry.note, "Siri")
    T.eq(entry.who.type, "key")
    T.eq(entry.reason, nil, "an admin removed it")
end

function tests.a_scene_that_opens_doors_or_gates_never_has_a_link()
    local withGate = { name = "Welcome", steps = { { type = "lights", room_id = 10, set = { on = true } }, GATE_STEP } }
    local s = start({ scene = withGate })
    local refused = makeLink(s)
    T.eq(refused.status, 409)
    T.eq(refused.json.code, "SCENE_OPENS_DOORS")
    T.eq(stored(s.mock), nil, "nothing kept")
end

function tests.adding_a_door_step_removes_the_link()
    local s = start()
    local link = makeLink(s, nil, { label = "Shortcut" }).json
    local steps = { NIGHT.steps[1], NIGHT.steps[2], GATE_STEP }
    local changed = T.http(s.mock, "PATCH", "/v1/scenes/" .. s.scene.id, { key = s.key, body = { steps = steps, version = s.scene.version } })
    T.eq(changed.status, 200, changed.body)
    T.eq(T.http(s.mock, "GET", "/v1/scenes/" .. s.scene.id .. "/link", { key = s.key }).status, 404, "the link went")
    T.eq(run(s, link.link_id, link.secret).code, "NOT_FOUND")
    local entry = history(s, "access")[1]
    T.eq(entry.action, "link_removed")
    T.eq(entry.reason, "doors")
    T.eq(entry.what, "Good night")
    T.eq(entry.who.type, "key", "the admin whose change removed it")
    -- A change without doors keeps it.
    local again = makeLink(s, (T.http(s.mock, "POST", "/v1/scenes", { key = s.key, body = NIGHT }).json.id)).json
    local other = T.http(s.mock, "GET", "/v1/scenes/" .. again.scene_id, { key = s.key }).json
    T.eq(T.http(s.mock, "PATCH", "/v1/scenes/" .. other.id, { key = s.key, body = { name = "Night" } }).status, 200)
    T.eq(run(s, again.link_id, again.secret).ok, true)
end

function tests.a_run_checks_the_scene_again()
    local s = start()
    local link = makeLink(s).json
    -- Changed behind the API's back (as DirectorLink 1.6.0 would, after a downgrade).
    local Scenes = require("src.core.scenes")
    local scene = Scenes.find(s.scene.id)
    scene.steps[#scene.steps + 1] = GATE_STEP
    T.truthy(Scenes.update(s.scene.id, { steps = scene.steps }))
    local before = #s.mock.commands
    local reply = run(s, link.link_id, link.secret)
    T.eq(reply.code, "NOT_FOUND")
    T.eq(#s.mock.commands, before, "nothing ran, the gate least of all")
    T.eq(#T.http(s.mock, "GET", "/v1/scene-links", { key = s.key }).json.items, 0, "and the link went")
    T.eq(history(s, "access")[1].reason, "doors")
end

function tests.deleting_a_scene_removes_its_link()
    local s = start()
    local link = makeLink(s).json
    T.eq(T.http(s.mock, "DELETE", "/v1/scenes/" .. s.scene.id, { key = s.key }).status, 204)
    T.eq(#T.http(s.mock, "GET", "/v1/scene-links", { key = s.key }).json.items, 0)
    T.eq(run(s, link.link_id, link.secret).code, "NOT_FOUND")
    local entry = history(s, "access")[1]
    T.eq(entry.action, "link_removed")
    T.eq(entry.reason, "scene_gone")
    T.eq(entry.what, "Good night")
end

function tests.composer_removes_every_link()
    local s = start()
    local link = makeLink(s).json
    local other = T.http(s.mock, "POST", "/v1/scenes", { key = s.key, body = { name = "Morning", steps = { { type = "lights", room_id = 10, set = { on = true } } } } }).json
    makeLink(s, other.id)
    ExecuteCommand("LUA_ACTION", { ACTION = "REMOVE_SCENE_LINKS" })
    T.eq(#T.http(s.mock, "GET", "/v1/scene-links", { key = s.key }).json.items, 0)
    T.eq(run(s, link.link_id, link.secret).code, "NOT_FOUND")
    local entry = history(s, "access")[1]
    T.eq(entry.action, "links_removed")
    T.eq(entry.count, 2)
    T.eq(entry.who.type, "composer")
end

function tests.a_new_remote_identity_removes_every_link()
    local s = start()
    makeLink(s)
    ExecuteCommand("LUA_ACTION", { ACTION = "RESET_REMOTE_IDENTITY" })
    T.eq(#T.http(s.mock, "GET", "/v1/scene-links", { key = s.key }).json.items, 0, "their addresses named the old home")
    local entry = history(s, "access")[1]
    T.eq(entry.action, "links_removed")
    T.eq(entry.reason, "new_identity")
end

function tests.links_survive_an_update_and_a_store_without_them_loads()
    local s = start()
    local link = makeLink(s).json
    local updated = Mock.updateDriver(s.mock)
    local key = s.key
    T.eq(#T.http(updated, "GET", "/v1/scene-links", { key = key }).json.items, 1)
    local _, connection = Harness.connected({ mock = updated })
    local reply = Harness.relayRequest(updated, connection, { type = "link", id = "after-update", link = link.link_id, secret = link.secret })
    T.eq(reply.ok, true)

    -- A 1.6.0 store has no links: none, and nothing breaks.
    local fresh = Mock.startDriver()
    local admin = T.pair(fresh)
    local list = T.http(fresh, "GET", "/v1/scene-links", { key = admin })
    T.eq(list.status, 200)
    T.eq(#list.json.items, 0)
end

function tests.stored_links_that_no_longer_apply_go_at_start()
    local s = start()
    local link = makeLink(s).json
    -- Under an older DirectorLink, the scene got a gate.
    local scenes = Json.decode(s.mock.persist["directorlink_scenes"]:gsub("^json:", ""))
    scenes.scenes[1].steps[#scenes.scenes[1].steps + 1] = GATE_STEP
    s.mock.persist["directorlink_scenes"] = "json:" .. Json.encode(scenes)
    local updated = Mock.updateDriver(s.mock)
    T.eq(#T.http(updated, "GET", "/v1/scene-links", { key = s.key }).json.items, 0)
    T.eq(stored(updated).links[1], nil)
    T.truthy(link.link_id)

    -- A store that could not be read is not overwritten by a start, and changes wait for a restart.
    local broken = start()
    makeLink(broken)
    broken.mock.persist[STORE] = "json:{not json"
    local again = Mock.updateDriver(broken.mock)
    T.eq(again.persist[STORE], "json:{not json", "left as it was")
    Harness.connected({ mock = again })
    local refused = T.http(again, "POST", "/v1/scenes/" .. broken.scene.id .. "/link", { key = broken.key })
    T.eq(refused.status, 503)
    T.eq(refused.json.code, "UNAVAILABLE")
    T.eq(again.persist[STORE], "json:{not json", "still")
end

function tests.the_hello_says_the_driver_takes_link_runs()
    local mock = Mock.startDriver()
    local _, _, _, frames = Harness.connected({ mock = mock })
    local hello = Json.decode(frames[1].payload)
    T.eq(hello.type, "hello")
    -- And since 1.9.0 the key ids whose browsers the account service dropped (ADR-062), and `users`
    -- (ADR-061): which keys share an account, members approving joins; since 1.10.0 `resend`
    -- (ADR-072): a request sent again after a lost connection runs once; since 1.10.1 `alert_acks`
    -- (ADR-073): its alerts are kept until the relay answers them, and sent again.
    T.same(hello.features, { "scene_links", "alerts_gone", "users", "resend", "alert_acks" })
end

-- ---- Backups --------------------------------------------------------------------------------

local function backupAndRestore(s, mutate, context)
    local Backup = require("src.core.backup")
    local document = Json.decode(Json.encode(Backup.export(require("src.core.registry"))))
    if mutate then
        mutate(document)
    end
    local plan, problem = Backup.plan(document, context or { registry = require("src.core.registry"), restorer = s.keyId, controller = Backup.controllerId() })
    T.truthy(plan, problem and problem.detail)
    T.truthy(Backup.apply(plan))
    return plan, document
end

function tests.backups_hold_the_links_hashes_and_bring_them_back()
    local s = start()
    local link = makeLink(s, nil, { label = "Arriving" }).json
    local plan, document = backupAndRestore(s)
    local section = document.sections.scene_links
    T.eq(section.version, 1)
    T.eq(section.links[1].id, link.link_id)
    T.truthy(section.links[1].hash, "the hash")
    T.notContains(Json.encode(document), link.secret, "never the secret")
    T.eq(section.links[1].by, s.keyId, "and the key that made it")
    T.eq(plan.preview.counts.scene_links, 1)
    T.eq(run(s, link.link_id, link.secret).ok, true, "still works after the restore")

    -- The driver was removed and added again (or the controller replaced): the backup's keys come
    -- back, and its links with them.
    local fresh = Mock.startDriver()
    local admin = T.pair(fresh, "New phone")
    local Backup = require("src.core.backup")
    local again, problem = Backup.plan(document, { registry = require("src.core.registry"), restorer = T.http(fresh, "GET", "/v1/api-keys/current", { key = admin }).json.id, controller = Backup.controllerId() })
    T.truthy(again, problem and problem.detail)
    T.eq(again.preview.keys.action, "restore")
    T.eq(again.preview.counts.scene_links, 1)
    T.truthy(Backup.apply(again))
    local _, connection = Harness.connected({ mock = fresh })
    T.eq(run({ mock = fresh, connection = connection }, link.link_id, link.secret).ok, true, "the family's tags and Shortcuts work on")
end

-- With the keys kept (other devices are paired), the links stay as they are now, as the keys do: a
-- link removed or replaced since the backup was made never comes back, and its replacement stays.
function tests.a_restore_never_brings_back_a_link_removed_or_replaced_since()
    local s = start()
    local old = makeLink(s, nil, { label = "Old phone" }).json
    local Backup = require("src.core.backup")
    local document = Json.decode(Json.encode(Backup.export(require("src.core.registry"))))
    local new = makeLink(s, nil, { label = "New phone" }).json
    local plan, problem = Backup.plan(document, { registry = require("src.core.registry"), restorer = s.keyId, controller = Backup.controllerId() })
    T.truthy(plan, problem and problem.detail)
    T.eq(plan.preview.keys.action, "kept")
    T.eq(plan.preview.counts.scene_links, 1, "the one here")
    T.truthy(Backup.apply(plan))
    T.eq(run(s, old.link_id, old.secret).code, "NOT_FOUND", "the lost phone's link stays dead")
    T.eq(run(s, new.link_id, new.secret).ok, true, "the new one works")

    T.eq(T.http(s.mock, "DELETE", "/v1/scenes/" .. s.scene.id .. "/link", { key = s.key }).status, 204)
    T.truthy(Backup.apply((Backup.plan(document, { registry = require("src.core.registry"), restorer = s.keyId, controller = Backup.controllerId() }))))
    T.eq(run(s, old.link_id, old.secret).code, "NOT_FOUND", "removed since: not back")
    T.eq(#T.http(s.mock, "GET", "/v1/scene-links", { key = s.key }).json.items, 0)
end

function tests.a_restore_keeps_only_links_for_the_home_in_use_and_scenes_that_came_back()
    local s = start()
    local link = makeLink(s).json
    -- Another home's backup: its identity stays out unless asked for, and so do its links; the
    -- links here, for this home, stay.
    local plan = backupAndRestore(s, function(document)
        document.sections.remote_identity.home_id = string.rep("a", 32)
        document.sections.scene_links.links[1].home = string.rep("a", 32)
    end)
    T.eq(plan.preview.remote.action, "kept")
    T.eq(plan.preview.counts.scene_links, 1)
    T.eq(run(s, link.link_id, link.secret).ok, true)
    -- The same backup moving its identity here: the links here name the old home and go.
    local moved = backupAndRestore(s, function(document)
        document.sections.remote_identity.home_id = string.rep("a", 32)
    end, { registry = require("src.core.registry"), restorer = s.keyId, controller = require("src.core.backup").controllerId(), move_remote = true })
    T.eq(moved.preview.remote.action, "restore")
    T.eq(moved.preview.counts.scene_links, 0)

    -- A backup made before 1.7.0 (no links): the links here stay for the scenes that come back.
    local t = start()
    local kept = makeLink(t).json
    local before = backupAndRestore(t, function(document)
        document.sections.scene_links = nil
    end)
    T.eq(before.preview.counts.scene_links, 1)
    T.eq(run(t, kept.link_id, kept.secret).ok, true)
    local gone = backupAndRestore(t, function(document)
        document.sections.scene_links = nil
        document.sections.scenes.scenes = {}
        document.sections.schedules.schedules = {}
    end)
    T.eq(gone.preview.counts.scene_links, 0, "its scene did not come back")
    T.eq(run(t, kept.link_id, kept.secret).code, "NOT_FOUND")
end

-- ---- The key that made a link ----------------------------------------------------------------

local function adminKey(s, name)
    local created = T.http(s.mock, "POST", "/v1/api-keys", { key = s.key, body = { name = name, role = "admin" } })
    T.eq(created.status, 201, created.body)
    return created.json.key, created.json.id
end

function tests.revoking_the_key_that_made_a_link_ends_the_link()
    local s = start()
    local housekeeper, housekeeperId = adminKey(s, "Housekeeper phone")
    local theirs = T.http(s.mock, "POST", "/v1/scenes/" .. s.scene.id .. "/link", { key = housekeeper, body = { label = "Cleaning done" } }).json
    local other = T.http(s.mock, "POST", "/v1/scenes", { key = s.key, body = { name = "Morning", steps = { { type = "lights", room_id = 10, set = { on = true } } } } }).json
    local mine = makeLink(s, other.id).json
    local listed = T.http(s.mock, "GET", "/v1/scene-links", { key = s.key }).json.items
    local madeBy = {}
    for _, item in ipairs(listed) do
        madeBy[item.link_id] = item.made_by
    end
    T.eq(madeBy[theirs.link_id], housekeeperId, "the list says which key made each")
    T.eq(madeBy[mine.link_id], s.keyId)
    T.eq(stored(s.mock).links[1].by, housekeeperId, "kept with the link")

    T.eq(T.http(s.mock, "DELETE", "/v1/api-keys/" .. housekeeperId, { key = s.key }).status, 204)
    T.eq(run(s, theirs.link_id, theirs.secret).code, "NOT_FOUND", "their link stopped with their key")
    T.eq(run(s, mine.link_id, mine.secret).ok, true, "the others' links work on")
    local entries = history(s, "access")
    T.eq(entries[1].action, "link_removed")
    T.eq(entries[1].reason, "key_gone")
    T.eq(entries[1].what, "Good night")
    T.eq(entries[1].note, "Cleaning done")
    T.eq(entries[2].action, "revoked", "after the key itself")

    -- A key that removes itself (Forget key) takes its links along too.
    local again, againId = adminKey(s, "Tablet")
    local tablets = T.http(s.mock, "POST", "/v1/scenes/" .. s.scene.id .. "/link", { key = again }).json
    T.eq(T.http(s.mock, "DELETE", "/v1/api-keys/current", { key = again }).status, 204)
    T.eq(run(s, tablets.link_id, tablets.secret).code, "NOT_FOUND")
    T.truthy(againId)
end

function tests.a_link_ends_when_the_key_that_made_it_expires()
    local s = start()
    ExecuteCommand("LUA_ACTION", { ACTION = "NEW_PAIRING_CODE" })
    local paired = T.http(s.mock, "POST", "/v1/auth/pair", { body = { pairing_code = s.mock.properties["Pairing Code"], name = "DirectorLink Console", expires_in = 60 } })
    T.eq(paired.status, 201, paired.body)
    local link = T.http(s.mock, "POST", "/v1/scenes/" .. s.scene.id .. "/link", { key = paired.json.key }).json
    T.eq(run(s, link.link_id, link.secret).ok, true, "while the key lasts")
    local realTime = os.time
    os.time = function(...)
        if select("#", ...) > 0 then
            return realTime(...)
        end
        return realTime() + 61
    end
    local ok, reply = pcall(run, s, link.link_id, link.secret)
    os.time = realTime
    T.truthy(ok, tostring(reply))
    T.eq(reply.code, "NOT_FOUND", "the run finds its key gone")
    T.eq(#T.http(s.mock, "GET", "/v1/scene-links", { key = s.key }).json.items, 0)
    local entry = history(s, "access")[1]
    T.eq(entry.action, "link_removed")
    T.eq(entry.reason, "key_gone")
end

-- Revoke All API Keys is "nobody from before": every link goes, a link that names no key too (made
-- by a test build of 1.7.0, before the key was kept with it: only this ends those).
function tests.revoke_all_api_keys_ends_every_link()
    local s = start()
    local link = makeLink(s).json
    local legacy = stored(s.mock)
    legacy.links[1].by = nil
    s.mock.persist[STORE] = "json:" .. Json.encode(legacy)
    local updated = Mock.updateDriver(s.mock)
    local _, connection = Harness.connected({ mock = updated })
    s = { mock = updated, key = s.key, connection = connection }
    local other, otherId = adminKey(s, "Other admin")
    -- The home's owner's device goes by itself (another admin may not revoke it: ADR-054).
    T.eq(T.http(s.mock, "DELETE", "/v1/api-keys/current", { key = s.key }).status, 204)
    T.eq(run(s, link.link_id, link.secret).ok, true, "a link that names no key outlives a revoked key")
    T.eq(T.http(s.mock, "GET", "/v1/scene-links", { key = other }).json.items[1].made_by, Json.null)

    ExecuteCommand("LUA_ACTION", { ACTION = "REVOKE_API_KEYS" })
    T.eq(run(s, link.link_id, link.secret).code, "NOT_FOUND")
    T.eq(stored(s.mock).links[1], nil, "none kept")
    local admin = T.pair(s.mock, "New phone")
    local entries = T.http(s.mock, "GET", "/v1/activity?kind=access", { key = admin }).json.items
    local actions = {}
    for _, entry in ipairs(entries) do
        actions[#actions + 1] = entry.action .. (entry.reason and ("/" .. entry.reason) or "")
    end
    T.contains(table.concat(actions, ","), "links_removed/keys_revoked,all_revoked")
    T.truthy(otherId)
end

-- Remove All Scene Links whose store cannot be written: the links stay (as a restart would load
-- them), and History, the log and Composer say they were not removed.
function tests.remove_all_scene_links_that_cannot_be_saved_says_so()
    local s = start()
    local link = makeLink(s).json
    local original = C4.PersistSetValue
    C4.PersistSetValue = function(self, key, ...)
        if key == STORE then
            error("flash full")
        end
        return original(self, key, ...)
    end
    local ok, failure = pcall(ExecuteCommand, "LUA_ACTION", { ACTION = "REMOVE_SCENE_LINKS" })
    C4.PersistSetValue = original
    T.truthy(ok, tostring(failure))
    T.eq(run(s, link.link_id, link.secret).ok, true, "what runs is what the store holds")
    T.contains(s.mock.properties["Remote Status"], "Scene links not removed")
    local entry = history(s, "access")[1]
    T.eq(entry.action, "links_removed")
    T.eq(entry.outcome, "failed")
    T.contains(T.http(s.mock, "GET", "/v1/logs?limit=50", { key = s.key }).body, "scene links not removed")
    -- And once it can be written, they go.
    ExecuteCommand("LUA_ACTION", { ACTION = "REMOVE_SCENE_LINKS" })
    T.eq(run(s, link.link_id, link.secret).code, "NOT_FOUND")
    T.eq(history(s, "access")[1].outcome, nil)
end

-- ---- What a link may run ------------------------------------------------------------------------

-- Every step type a scene can have is either one a link may run or one it never runs: a type added
-- later must be put on one list before it can be in a linked scene.
function tests.every_step_type_is_allowed_or_refused_for_links()
    local Scenes = require("src.core.scenes")
    local SceneLinks = require("src.core.scene_links")
    for name in pairs(Scenes.TYPES) do
        T.truthy(SceneLinks.ALLOWED[name] or SceneLinks.REFUSED[name], "step type " .. name .. " is neither allowed nor refused for scene links")
        T.truthy(not (SceneLinks.ALLOWED[name] and SceneLinks.REFUSED[name]), name .. " is on both lists")
        T.eq(SceneLinks.linkable({ steps = { { type = name } } }), SceneLinks.ALLOWED[name] == true, name)
    end
    T.eq(SceneLinks.REFUSED.relays, true, "never doors or gates")
    T.eq(SceneLinks.linkable({ steps = { { type = "lights" }, { type = "garage_door" } } }), false, "a type on no list: no link")
    T.eq(SceneLinks.linkable({ steps = { { type = "lights" }, { type = "refrigerators" } } }), true)
end

function tests.a_run_that_found_nothing_to_run_says_so()
    -- A room-wide step in a room without such devices (they were removed in Composer since).
    local s = start({ scene = { name = "Empty room", steps = { { type = "fans", room_id = 10, set = { on = false } } } } })
    local link = makeLink(s).json
    local before = #s.mock.commands
    local reply = run(s, link.link_id, link.secret)
    T.eq(reply.ok, true)
    T.eq(reply.result, "nothing", "not \"ran\"")
    T.eq(#s.mock.commands, before)
end

return tests
