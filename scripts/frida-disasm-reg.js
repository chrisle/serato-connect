/**
 * Disassemble the registration sites in detail to understand WHAT is being
 * registered (and whether the registration is for SEND or RECV semantics).
 *
 * Sites:
 *   0xb79138  REGISTER Authorize/Response → handler 0xb78cfc
 *   0xb7923c  REGISTER StatusChanged      → handler 0xb78ea8
 *
 * For each, show 12 instructions before + 32 instructions after, plus
 * follow any BL targets so we see what register_*() function is actually
 * being called.
 */

const mod = Process.enumerateModules()[0];
console.log(`MAIN ${mod.name} base=${mod.base}`);

const sites = [
  { name: 'REG Authorize/Response',  off: 0xb79138, handler: 0xb78cfc },
  { name: 'REG StatusChanged',       off: 0xb7923c, handler: 0xb78ea8 },
  // Compare with senders for cross-reference
  { name: 'SEND Authorize/Request',  off: 0xb791ac, handler: null     },
  { name: 'SEND Authorize/Response', off: 0xb78f98, handler: null     },
  { name: 'SEND Pair',               off: 0xb79260, handler: null     },
  { name: 'SEND StatusChanged',      off: 0xb78fc0, handler: null     },
];

function disRange(label, baseOff, before, after) {
  const baseAddr = mod.base.add(baseOff);
  console.log(`\n=== ${label} @ off=0x${baseOff.toString(16)} (${baseAddr}) ===`);
  for (let k = -before; k <= after; k++) {
    const ip = baseAddr.add(k * 4);
    let line;
    try {
      const ins = Instruction.parse(ip);
      const sym = DebugSymbol.fromAddress(ip);
      const off = ip.sub(mod.base);
      line = `  ${(k >= 0 ? '+' : '')}${k * 4}\toff=0x${off.toString(16)}\t${ins.toString().padEnd(50)}\t${sym.name || ''}`;
    } catch (e) {
      line = `  parse err at ${ip}: ${e.message}`;
    }
    console.log(line);
  }
}

for (const s of sites) {
  disRange(s.name, s.off, 12, 32);
}

// For each REG site, follow the BL after the ADR x2 to see register_handler implementation
console.log('\n=== following register_handler() bodies ===');
for (const s of sites) {
  if (!s.handler) continue;
  // Walk forward from baseOff looking for next BL — that's likely the
  // register_handler call.
  for (let k = 0; k < 16; k++) {
    const ip = mod.base.add(s.off).add(k * 4);
    try {
      const ins = Instruction.parse(ip);
      if (ins.mnemonic !== 'bl') continue;
      const tgt = ptr(ins.operands[0].value.toString());
      const tgtOff = tgt.sub(mod.base);
      console.log(`\n--- ${s.name} BL target @ off=0x${tgtOff.toString(16)} ---`);
      // Disassemble first 40 instructions of the target
      for (let j = 0; j < 40; j++) {
        const ip2 = tgt.add(j * 4);
        try {
          const ins2 = Instruction.parse(ip2);
          const sym = DebugSymbol.fromAddress(ip2);
          const off2 = ip2.sub(mod.base);
          console.log(`    off=0x${off2.toString(16)}\t${ins2.toString().padEnd(50)}\t${sym.name || ''}`);
          if (ins2.mnemonic === 'ret') break;
        } catch (_) { break; }
      }
      break;  // stop after first BL — the rest are inside register_handler
    } catch (_) {}
  }
}

console.log('\n=== DONE ===');
