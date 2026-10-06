// Checks that need no browser and no database. Run: npm run test:static
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = f => fs.readFileSync(path.join(root, f), 'utf8');
const pages = ['index.html', 'slicklab_tcc_orchestration_corrected.html', 'TCC_HyperInteractive_Integrated_Infrastructure.html'];
let passed = 0;
const failures = [];
const check = (name, ok, detail) => { if (ok) passed++; else { failures.push(name); console.log('  FAIL ' + name + (detail ? ' :: ' + JSON.stringify(detail) : '')); } };

// The schema shown, copied and downloaded by the HyperNexus page must be the tested file, byte for byte.
const sql = read('sql/TCC_Integrated_Nexus_Schema.sql');
const m = /<script type="text\/plain" id="schema-sql">\n([\s\S]*?)<\/script>/.exec(read(pages[2]));
check('HyperNexus embeds exactly sql/TCC_Integrated_Nexus_Schema.sql', !!m && m[1] === sql);
check('schema does not use the reserved word AUTHORIZATION as a column', !/[\s,(]authorization\s+text/i.test(sql));
check('schema is wrapped in one transaction', /^BEGIN;$/m.test(sql) && /^COMMIT;\s*$/m.test(sql));
check('schema holds no credentials', !/(password|secret|api_?key|token)\s*[=:]\s*\S|PASSWORD\s+'/i.test(sql));

for (const f of pages) {
  const html = read(f);
  // Each page must work as a single file with no network: no CDN, no fonts, no trackers.
  const external = [...html.matchAll(/(?:src|href|action)\s*=\s*["']?\s*(?:https?:)?\/\/[^"'\s>]+|url\(\s*["']?https?:[^)]+|@import[^;]+|\bfetch\(|XMLHttpRequest|sendBeacon|new\s+WebSocket/g)].map(x => x[0]);
  check(`${f}: loads nothing from another host`, external.length === 0, external);
  check(`${f}: has doctype, lang, viewport, title and description`, /^<!doctype html>/i.test(html) && /<html lang="en">/.test(html) && /name="viewport"/.test(html) && /<title>[^<]{5,}<\/title>/.test(html) && /name="description" content="[^"]{50,}"/.test(html));
  const ids = [...html.matchAll(/\sid="([^"]+)"/g)].map(x => x[1]);
  const dupes = ids.filter((x, i) => ids.indexOf(x) !== i);
  check(`${f}: element ids are unique`, dupes.length === 0, dupes);
  check(`${f}: no inline event-handler attributes`, !/\son[a-z]+\s*=\s*["']/i.test(html.replace(/<script[\s\S]*?<\/script>/g, '')));
  const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map(x => x[1]);
  check(`${f}: scripts run inside their own scope`, scripts.every(s => /^\s*\(\(\) => \{\s*'use strict';/.test(s) && /\}\)\(\);\s*$/.test(s)));
  for (const s of scripts) { try { new Function(s); passed++; } catch (e) { check(`${f}: script parses`, false, e.message); } }
  if (scripts.length) check(`${f}: tells the reader when JavaScript is off`, /<noscript>[^<]*<[a-z]+[^>]*>[^<]{20,}/.test(html));
  check(`${f}: stays under 100 KB`, Buffer.byteLength(html) < 100 * 1024, Buffer.byteLength(html));
}

const readme = read('README.md');
check('README names every shipped file', pages.every(p => readme.includes(p)) && readme.includes('sql/TCC_Integrated_Nexus_Schema.sql'));

console.log(`${passed} passed, ${failures.length} failed`);
if (failures.length) process.exit(1);
