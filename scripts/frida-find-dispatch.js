/**
 * Find xrefs to OSC path strings via ARM64 ADRP+ADD/LDR pair scanning.
 *
 * NOTE: JS bitwise ops produce int32, so we ">>> 0" everywhere to compare as u32.
 *
 * ARM64 encoding refresher (little-endian instruction word):
 *   ADRP: bit31=1, bit28=1, bits27:24=0       — mask 0x9F000000, value 0x90000000
 *   ADD #imm12 (sf=1): mask 0xFFC00000, value 0x91000000
 *   LDR Xt, [Xn, #imm12]: mask 0xFFC00000, value 0xF9400000  (size=11, V=0, opc=01)
 *   ADD #imm12 (sf=0): value 0x11000000
 */

const ADRP_MASK = 0x9F000000;
const ADRP_VAL  = 0x90000000;
const ADD_MASK  = 0xFFC00000;
const ADD_VAL   = 0x91000000;
const LDR_MASK  = 0xFFC00000;
const LDR_VAL   = 0xF9400000;

const mod = Process.enumerateModules()[0];
console.log(`MAIN ${mod.name} base=${mod.base} size=${mod.size}`);

function findStr(s) {
  const pat = Array.from(s).map(c => c.charCodeAt(0).toString(16).padStart(2,'0')).join(' ');
  return Memory.scanSync(mod.base, mod.size, pat);
}

const targets = [
  { name: 'Authorize/Request',  s: '/StreamMgmt/Authorize/Request'  },
  { name: 'Authorize/Response', s: '/StreamMgmt/Authorize/Response' },
  { name: 'Pair',               s: '/StreamMgmt/Pairing/Pair' },
  { name: 'StatusChanged',      s: '/StreamMgmt/Pairing/StatusChanged' },
];

for (const t of targets) {
  const m = findStr(t.s);
  if (!m.length) { console.log(`!! no string for ${t.name}`); continue; }
  t.addr = m[0].address;
  t.page = ptr(t.addr.toString()).and(ptr('0xFFFFFFFFFFFFF000'));
  t.off  = t.addr.and(ptr('0xFFF')).toUInt32();
  console.log(`STR ${t.name} addr=${t.addr} page=${t.page} off-in-page=0x${t.off.toString(16)}`);
}

function adrpImm21(insn) {
  const u = insn >>> 0;
  const immlo = (u >>> 29) & 0x3;
  const immhi = (u >>> 5) & 0x7FFFF;
  let imm21 = (immhi << 2) | immlo;
  if (imm21 & (1 << 20)) imm21 -= (1 << 21);
  return imm21;
}
function add_Rn(insn) { return ((insn >>> 0) >>> 5) & 0x1F; }
function add_Rd(insn) { return (insn >>> 0) & 0x1F; }
function add_imm12(insn) { return ((insn >>> 0) >>> 10) & 0xFFF; }
function ldr_imm12_64(insn) { return (((insn >>> 0) >>> 10) & 0xFFF) * 8; }

const ranges = Process.enumerateRanges('r-x')
  .filter(r => r.base.compare(mod.base) >= 0 &&
               r.base.compare(mod.base.add(mod.size)) < 0);

let scannedBytes = 0;
let adrpCount = 0;
const xrefs = [];

for (const r of ranges) {
  let cur = r.base;
  const end = r.base.add(r.size);
  for (; cur.compare(end) < 0; cur = cur.add(0x1000)) {
    let buf;
    try { buf = cur.readByteArray(0x1000); } catch (_) { continue; }
    if (!buf) continue;
    scannedBytes += 0x1000;
    const u32 = new Uint32Array(buf);
    for (let i = 0; i < u32.length; i++) {
      const insn = u32[i];
      if (((insn & ADRP_MASK) >>> 0) !== ADRP_VAL) continue;
      adrpCount++;
      const imm21 = adrpImm21(insn);
      const Rd = (insn >>> 0) & 0x1F;
      const pcAddr = cur.add(i * 4);
      const adrpPage = pcAddr.and(ptr('0xFFFFFFFFFFFFF000')).add(imm21 * 0x1000);

      // Skip ADRPs whose page does not match any of our targets
      if (!targets.some(t => t.addr && adrpPage.equals(t.page))) continue;

      // Look at next ~50 instructions for an ADD/LDR with same Rn AND imm matching any target
      for (let k = 1; k <= 50 && i + k < u32.length; k++) {
        const next = u32[i + k];
        let computed = null;
        let kind = '';
        if (((next & ADD_MASK) >>> 0) === ADD_VAL) {
          if (add_Rn(next) === Rd) {
            computed = adrpPage.add(add_imm12(next));
            kind = `ADD k=${k}`;
          }
        } else if (((next & LDR_MASK) >>> 0) === LDR_VAL) {
          if (add_Rn(next) === Rd) {
            computed = adrpPage.add(ldr_imm12_64(next));
            kind = `LDR k=${k}`;
          }
        }
        if (!computed) continue;
        const hit = targets.find(t => t.addr && computed.equals(t.addr));
        if (hit) {
          xrefs.push({ pcAddr, kind, target: hit.name, targetAddr: hit.addr });
          break;
        }
      }
    }
  }
}

console.log(`\nscanned=${(scannedBytes / 1024 / 1024).toFixed(1)}MiB  ADRPs=${adrpCount}  xrefs=${xrefs.length}`);
for (const x of xrefs) {
  const off = x.pcAddr.sub(mod.base);
  console.log(`  ${x.pcAddr}  off=0x${off.toString(16)}  ${x.kind} -> ${x.target} @ ${x.targetAddr}`);
  // disassemble around it (3 before, 12 after)
  for (let k = -3; k <= 12; k++) {
    try {
      const ip = x.pcAddr.add(k * 4);
      const ins = Instruction.parse(ip);
      console.log(`     ${k >= 0 ? '+' : ''}${k * 4}: ${ip}  ${ins}`);
    } catch (_) {}
  }
}

console.log('-- DONE --');
