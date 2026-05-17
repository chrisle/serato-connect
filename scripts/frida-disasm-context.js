/**
 * Disassemble context around the OSC xref sites to understand what the
 * surrounding functions do. We want to see, for example, what happens
 * after Serato sends Authorize/Request — that should hint at how it expects
 * the response to be validated.
 */

const mod = Process.enumerateModules()[0];
console.log(`MAIN ${mod.name} base=${mod.base}`);

// Offsets discovered by frida-hook-xrefs.js
const sites = [
  { name: 'SENDER Authorize/Response',  off: 0xb78f98 },
  { name: 'SENDER StatusChanged',       off: 0xb78fc0 },
  { name: 'REGISTER Authorize/Response',off: 0xb79138 },
  { name: 'SENDER Authorize/Request',   off: 0xb791ac },
  { name: 'REGISTER StatusChanged',     off: 0xb7923c },
  { name: 'SENDER Pair',                off: 0xb79260 },
  { name: 'HANDLER Authorize/Response', off: 0xb78cfc },
  { name: 'HANDLER StatusChanged',      off: 0xb78ea8 },
];

function dis(label, off, before, after) {
  const addr = mod.base.add(off);
  console.log(`\n=== ${label} @ off=0x${off.toString(16)} (${addr}) ===`);
  for (let k = -before; k <= after; k++) {
    try {
      const ip = addr.add(k * 4);
      const ins = Instruction.parse(ip);
      const sym = DebugSymbol.fromAddress(ip);
      const sIns = ins.toString().padEnd(50);
      console.log(`  ${ip}  ${(k >= 0 ? '+' : '')}${k * 4}  ${sIns}  ${sym.name || ''}`);
    } catch (_) {}
  }
}

for (const s of sites) {
  dis(s.name, s.off, 8, 24);
}

// Also dump the FULL handler at 0xb78cfc — the receive handler for
// Authorize/Response — so we can read its logic top-to-bottom
console.log('\n=== FULL handler 0xb78cfc (Authorize/Response receive) ===');
const handlerStart = mod.base.add(0xb78cfc);
let pc = handlerStart;
for (let i = 0; i < 80; i++) {
  try {
    const ins = Instruction.parse(pc);
    const off = pc.sub(mod.base);
    console.log(`  off=0x${off.toString(16).padEnd(8)}  ${ins}`);
    if (ins.mnemonic === 'ret') break;
    pc = pc.add(4);
  } catch (e) {
    console.log(`  parse err at ${pc}: ${e.message}`);
    break;
  }
}

console.log('\n-- DONE --');
