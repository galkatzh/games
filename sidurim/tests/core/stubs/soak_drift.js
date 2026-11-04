// tests/core/stubs/soak_drift.js — WP-CORE
// Load with soak_spawner.js: a sim whose state depends on something other than the seed, to prove the determinism gate.
// The forbidden call lives here, in a test stub, precisely because the lint keeps it out of js/.
window.__soakDrift = function () { return Math.random() * 1e-6; };
