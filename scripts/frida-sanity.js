/**
 * Sanity check: find ADRPs that target the page containing the OSC strings,
 * then disassemble nearby instructions to see how the strings are computed.
 */

const mod = Process.enumerateModules()[0];
console.log(`MAIN ${mod.name} base=${mod.base}`);

function findStr(s) {
  const pat = Array.from(s).map(c => c.charCodeAt(0).toString(16).padStart(2,'0')).join(' ');
  return Memory.scanSync(mod.base, mod.size, pat);
}

const strAddr = findStr('/StreamMgmt/Authorize/Response')[0].address;
const targetPage = strAddr.and(ptr('0xFFFFFFFFFFFFF000'));
const targetOff  = strAddr.and(ptr('0xFFF')).toUInt32();
console.log(`target string @ ${strAddr}, page=${targetPage}, off=0x${targetOff.toString(16)}`);

function adrpImm21(insn) {
  const immlo = (insn >>> 29) & 0x3;
  const immhi = (insn >>> 5) & 0x7FFFF;
  let imm21 = (immhi << 2) | immlo;
  if (imm21 & (1 << 20)) imm21 -= (1 << 21);
  return imm21;
}

const ranges = Process.enumerateRanges({ protection: 'r-x', coalesce: true })
  .filter(r => r.base.compare(mod.base) >= 0 &&
               r.base.add(r.size).compare(mod.base.add(mod.size)) <= 0);

let totalAdrp = 0;
let pageMatches = 0;
const samples = [];

for (const r of ranges) {
  const start = r.base;
  const end   = r.base.add(r.size);
  let cur = start;
  const pageStep = 0x1000;
  for (; cur.compare(end) < 0; cur = cur.add(pageStep)) {
    const sz = Math.min(pageStep, end.sub(cur).toInt32());
    let buf;
    try { buf = cur.readByteArray(sz); } catch (_) { continue; }
    if (!buf) continue;
    const u32 = new Uint32Array(buf);
    for (let i = 0; i < u32.length; i++) {
      const insn = u32[i];
      if ((insn & 0x9F000000) !== 0x90000000) continue;
      totalAdrp++;
      const imm21 = adrpImm21(insn);
      const pcAddr = cur.add(i * 4);
      const adrpPage = pcAddr.and(ptr('0xFFFFFFFFFFFFF000')).add(imm21 * 0x1000);
      if (adrpPage.equals(targetPage)) {
        pageMatches++;
        if (samples.length < 6) samples.push({ pcAddr, insn });
      }
    }
  }
}
console.log(`total ADRP instructions: ${totalAdrp}`);
console.log(`ADRPs targeting our string's page: ${pageMatches}`);
console.log('first 6 sample ADRPs:');
for (const s of samples) {
  console.log(`\n--- adrp at ${s.pcAddr}  insn=0x${s.insn.toString(16).padStart(8, '0')} ---`);
  // Try to disassemble using Frida's Instruction.parse
  try {
    const insn = Instruction.parse(s.pcAddr);
    console.log(`  parsed: ${insn.toString()}`);
  } catch (e) {
    console.log(`  parse err: ${e.message}`);
  }
  // Disassemble next 8 instructions
  for (let k = 1; k <= 8; k++) {
    try {
      const ip = s.pcAddr.add(k * 4);
      const ins = Instruction.parse(ip);
      console.log(`  +${k * 4}: ${ip}  ${ins.toString()}`);
    } catch (e) {}
  }
}

console.log('-- DONE --');
