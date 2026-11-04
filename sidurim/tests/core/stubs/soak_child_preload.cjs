// tests/core/stubs/soak_child_preload.cjs — WP-CORE
// Preloaded through NODE_OPTIONS, so it runs in the parent and in every child, and acts only in a child: at that moment the
// parent has checked its report path and no job has run. A throw here fails the job, which fails the test.
//   $SOAK_OLD_REPORT   A report that must still hold 'old'.
//   $SOAK_BREAK_OUT    The report's directory. It must be empty, and is replaced with a file, so the parent's write fails for
//                      certain, with no race.
'use strict';
const fs = require('node:fs');

const { SOAK_OLD_REPORT: old, SOAK_BREAK_OUT: dir } = process.env;
if (process.argv.includes('--child')) {
  if (old && fs.readFileSync(old, 'utf8') !== 'old') throw new Error('checking the report path changed the report');
  if (dir && fs.statSync(dir).isDirectory()) {
    if (fs.readdirSync(dir).length) throw new Error('checking the report path left a file behind');
    fs.rmSync(dir, { recursive: true });
    fs.writeFileSync(dir, '');
  }
}
