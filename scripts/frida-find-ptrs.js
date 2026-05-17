/**
 * Look for absolute 8-byte little-endian pointers to OSC path strings within
 * Serato's data segments. A handler dispatch table often stores the path as
 * a `const char*` literal — finding the pointer locates the table.
 */

const mod = Process.enumerateModules()[0];
console.log(`MAIN ${mod.name} base=${mod.base}`);

function findStr(s) {
  const pat = Array.from(s).map(c => c.charCodeAt(0).toString(16).padStart(2, '0')).join(' ');
  return Memory.scanSync(mod.base, mod.size, pat);
}

const targets = [
  '/StreamMgmt/Authorize/Request',
  '/StreamMgmt/Authorize/Response',
  '/StreamMgmt/Pairing/Pair',
  '/StreamMgmt/Pairing/StatusChanged',
];

for (const s of targets) {
  const m = findStr(s);
  if (!m.length) { console.log(`!! no string ${s}`); continue; }
  const strAddr = m[0].address;
  console.log(`\n== "${s}" at ${strAddr}`);

  // Encode as 8-byte LE pattern
  const bytes = [];
  let v = strAddr;
  for (let i = 0; i < 8; i++) {
    bytes.push(v.and(ptr(0xff)).toUInt32().toString(16).padStart(2, '0'));
    v = v.shr(8);
  }
  const pat = bytes.join(' ');

  let hits;
  try {
    hits = Memory.scanSync(mod.base, mod.size, pat);
  } catch (e) {
    console.log(`  scan error: ${e.message}`);
    continue;
  }
  console.log(`   ${hits.length} pointer hits`);
  for (const h of hits.slice(0, 20)) {
    const off = h.address.sub(mod.base);
    console.log(`     ptr-at ${h.address}  mod-off=0x${off.toString(16)}`);
    // Read 8 bytes BEFORE and 8 bytes AFTER for context
    try {
      const prev = h.address.sub(8).readU64();
      const next = h.address.add(8).readU64();
      console.log(`        prev_qword=${prev}  next_qword=${next}`);
    } catch (_) {}
  }
}

console.log('\n-- DONE --');
