#!/usr/bin/env node
require('../dist/src/cli.js').main(process.argv.slice(2)).catch((err) => {
  console.error(err && err.stack ? err.stack : err);
  process.exit(1);
});
