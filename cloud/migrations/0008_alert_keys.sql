-- Alerts sealed to each device's key (ADR-050, docs/ACCOUNTS.md): a browser's push subscription now
-- names the key its device uses at the home. The controller decides who gets an alert and sends it
-- sealed to those keys ({"type":"notify"}, docs/RELAY.md); the cloud delivers each part only to the
-- browsers registered with that key by an account that uses it there (member_keys). A subscription
-- without a key id was registered by an app before 1.7.0: it gets what it got then (the admins'
-- offline and schedule alerts). `offline`: this browser wants the cloud's own alert when the home has
-- been offline (for admin keys; the controller cannot say it then).

ALTER TABLE push_subscriptions ADD COLUMN key_id TEXT;   -- 8 hex characters; NULL: before 1.7.0
ALTER TABLE push_subscriptions ADD COLUMN offline INTEGER NOT NULL DEFAULT 1;
CREATE INDEX push_subscriptions_by_key ON push_subscriptions (home_id, key_id);
