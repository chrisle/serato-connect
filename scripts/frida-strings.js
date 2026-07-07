/**
 * Find OSC-related strings inside Serato's binary and dump nearby code refs.
 *
 * Usage:
 *   ~/Library/Python/3.14/bin/frida -p <pid> --realm=native -q -l scripts/frida-strings.js
 */

function findInModule(mod, needle) {
  const pattern = Array.from(needle).map(c => c.charCodeAt(0).toString(16).padStart(2, '0')).join(' ');
  const matches = Memory.scanSync(mod.base, mod.size, pattern);
  return matches;
}

function dumpRange(mod, results, label, max) {
  console.log(`-- "${label}" matches=${results.length}`);
  for (let i = 0; i < Math.min(max, results.length); i++) {
    const addr = results[i].address;
    const off = addr.sub(mod.base);
    let str;
    try { str = addr.readUtf8String(80); } catch (_) { str = '(unreadable)'; }
    console.log(`   ${addr}  off=0x${off.toString(16)}  ${JSON.stringify(str)}`);
  }
}

const mod = Process.enumerateModules()[0];
console.log(`MAIN=${mod.name}  base=${mod.base}`);

const needles = [
  '/StreamMgmt/Authorize/Request',
  '/StreamMgmt/Authorize/Response',
  '/StreamMgmt/Pairing/Pair',
  '/StreamMgmt/Pairing/StatusChanged',
  '/Error/',
  'Malformed',
  'osc::MalformedMessage',
  'readDataCallback',
  'Authorize',
  'Pairing',
  '%b%i%i',
  '%s%s%i',
];

for (const n of needles) {
  try {
    const m = findInModule(mod, n);
    dumpRange(mod, m, n, 6);
  } catch (e) {
    console.log(`!! ${n} -> ${e.message}`);
  }
}

console.log('-- DONE --');
