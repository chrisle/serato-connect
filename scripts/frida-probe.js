/**
 * Verify endianness — pick the first ADR-classified instruction and inspect.
 */
const mod = Process.enumerateModules()[0];
console.log(`MAIN ${mod.name} base=${mod.base}`);

const ranges = Process.enumerateRanges('r-x')
  .filter(r => r.base.compare(mod.base) >= 0 &&
               r.base.compare(mod.base.add(mod.size)) < 0);
const r = ranges[0];

// Sample first 4KB
const buf = r.base.readByteArray(0x1000);
const u32 = new Uint32Array(buf);
const u8  = new Uint8Array(buf);

console.log(`first 16 bytes: ${Array.from(u8.slice(0, 16)).map(x => x.toString(16).padStart(2,'0')).join(' ')}`);
console.log(`first 4 u32:    ${Array.from(u32.slice(0, 4)).map(x => x.toString(16).padStart(8,'0')).join(' ')}`);
// readU32 from address
console.log(`readU32 at base:    0x${r.base.readU32().toString(16).padStart(8,'0')}`);
console.log(`readU32 at base+4:  0x${r.base.add(4).readU32().toString(16).padStart(8,'0')}`);

// Walk first 100 instructions
console.log('\n--- first 100 instructions, starting at first valid ---');
let started = false;
for (let i = 0; i < 1024; i++) {
  const ip = r.base.add(i * 4);
  let parsed;
  try { parsed = Instruction.parse(ip); } catch (_) { continue; }
  const u32_byteorder = u32[i];
  const u32_readU32   = ip.readU32();
  console.log(`+0x${(i*4).toString(16).padStart(4,'0')}  ip=${ip}  u32_arr=0x${u32_byteorder.toString(16).padStart(8,'0')}  readU32=0x${u32_readU32.toString(16).padStart(8,'0')}  asm=${parsed}`);
  started = true;
  if (i > 30) break;
}

// Now find an actual ADRP via Instruction.parse and compare with our mask
console.log('\n--- searching for ADRP via Instruction.parse ---');
let found = 0;
for (let i = 0; i < 100000; i++) {
  const ip = r.base.add(i * 4);
  try {
    const ins = Instruction.parse(ip);
    if (ins.mnemonic === 'adrp') {
      const u32_arr = u32[i];
      const u32_read = ip.readU32();
      console.log(`ADRP at +0x${(i*4).toString(16)}  u32_arr=0x${u32_arr.toString(16).padStart(8,'0')}  readU32=0x${u32_read.toString(16).padStart(8,'0')}  ${ins.toString()}`);
      // Show mask test
      console.log(`   mask&0x9F000000 = 0x${(u32_arr & 0x9F000000).toString(16)}, expecting 0x90000000`);
      found++;
      if (found >= 3) break;
    }
  } catch (_) {}
}

console.log('-- DONE --');
