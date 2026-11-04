// tests/core/stubs/soak_options.js — WP-CORE
// Load before soak_spawner.js. It takes the spawner's options from $SOAK_STUB as JSON, so a test can state in one line what is
// wrong with its sim. Numbers JSON cannot carry are written as strings, such as 'NaN'.
window.__soak = JSON.parse(process.env.SOAK_STUB || '{}');
