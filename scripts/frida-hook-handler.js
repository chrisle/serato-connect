/**
 * Discover and hook Serato's OSC /StreamMgmt/* dispatch handlers.
 *
 * Strategy:
 *   1. Locate each path string in __cstring.
 *   2. Scan __TEXT for the "register" pattern
 *        adrp x?, page          (page = path-string page)
 *        add  x?, x?, #imm12    (imm12 = path-string off-in-page)
 *        ...up to 10 insns...
 *        adr  x2, #handler      (the local callback registered for that path)
 *   3. For each unique handler address, dump its prologue and attach
 *      Interceptor — when Serato later parses an /StreamMgmt/<X> message the
 *      handler fires and we get the OSC message struct in x0/x1/x2.
 *
 * NOTE: JS bitwise ops produce int32 — every 0x90000000-style mask compare
 * MUST do `((x & MASK) >>> 0) === VAL` to compare as u32, otherwise the test
 * silently fails for any insn with bit 31 set.
 */

const ADRP_MASK = 0x9F000000;
const ADRP_VAL  = 0x90000000;
const ADD_MASK  = 0xFFC00000;
const ADD_VAL   = 0x91000000;
const ADR_MASK  = 0x9F000000;
const ADR_VAL   = 0x10000000;

const mod = Process.enumerateModules()[0];
console.log(`MAIN ${mod.name} base=${mod.base} size=${mod.size}`);

function findStr(s) {
  const pat = Array.from(s).map(c => c.charCodeAt(0).toString(16).padStart(2,'0')).join(' ');
  return Memory.scanSync(mod.base, mod.size, pat);
}

const targets = [
  { name: 'Authorize/Request',   s: '/StreamMgmt/Authorize/Request'   },
  { name: 'Authorize/Response',  s: '/StreamMgmt/Authorize/Response'  },
  { name: 'Pair',                s: '/StreamMgmt/Pairing/Pair'        },
  { name: 'StatusChanged',       s: '/StreamMgmt/Pairing/StatusChanged' },
];

for (const t of targets) {
  const m = findStr(t.s);
  if (!m.length) { console.log(`!! no string for ${t.name}`); continue; }
  t.addr = m[0].address;
  console.log(`STR ${t.name} @ ${t.addr} (off=0x${t.addr.sub(mod.base).toString(16)})`);
}

function imm21(insn) {
  const u = insn >>> 0;
  const lo = (u >>> 29) & 0x3;
  const hi = (u >>> 5) & 0x7FFFF;
  let v = (hi << 2) | lo;
  if (v & (1 << 20)) v -= (1 << 21);
  return v;
}
function rd(insn) { return (insn >>> 0) & 0x1F; }
function rn(insn) { return ((insn >>> 0) >>> 5) & 0x1F; }
function add_imm12(insn) { return ((insn >>> 0) >>> 10) & 0xFFF; }

const ranges = Process.enumerateRanges('r-x')
  .filter(r => r.base.compare(mod.base) >= 0 &&
               r.base.compare(mod.base.add(mod.size)) < 0);

const found = [];

for (const r of ranges) {
  let cur = r.base;
  const end = r.base.add(r.size);
  for (; cur.compare(end) < 0; cur = cur.add(0x1000)) {
    let buf;
    try { buf = cur.readByteArray(0x1000); } catch (_) { continue; }
    if (!buf) continue;
    const u32 = new Uint32Array(buf);
    for (let i = 0; i + 1 < u32.length; i++) {
      const insn = u32[i];
      if (((insn & ADRP_MASK) >>> 0) !== ADRP_VAL) continue;
      const adrpRd = rd(insn);
      const adrpPC = cur.add(i * 4);
      const adrpPage = adrpPC.and(ptr('0xFFFFFFFFFFFFF000')).add(imm21(insn) * 0x1000);

      const nx = u32[i + 1];
      if (((nx & ADD_MASK) >>> 0) !== ADD_VAL) continue;
      if (rn(nx) !== adrpRd) continue;
      const computed = adrpPage.add(add_imm12(nx));
      const hit = targets.find(t => t.addr && computed.equals(t.addr));
      if (!hit) continue;

      // Find ADR x2, #handler within the next ~10 instructions
      let handlerAddr = null;
      for (let k = 2; k <= 10 && i + k < u32.length; k++) {
        const ai = u32[i + k];
        if (((ai & ADR_MASK) >>> 0) !== ADR_VAL) continue;
        if (rd(ai) !== 2) continue;
        const adrPC = cur.add((i + k) * 4);
        handlerAddr = adrPC.add(imm21(ai));
        break;
      }
      if (handlerAddr) {
        found.push({ path: hit.name, regPC: adrpPC, handler: handlerAddr });
      }
    }
  }
}

console.log(`\n=== registration sites: ${found.length} ===`);
for (const f of found) {
  console.log(`  ${f.path}  reg=0x${f.regPC.sub(mod.base).toString(16)}  handler=0x${f.handler.sub(mod.base).toString(16)}`);
}

// Group by handler to avoid double-attach
const handlers = new Map();
for (const f of found) {
  const k = f.handler.toString();
  if (handlers.has(k)) {
    handlers.get(k).paths.push(f.path);
  } else {
    handlers.set(k, { addr: f.handler, paths: [f.path] });
  }
}

console.log(`\n=== installing ${handlers.size} handler hooks ===`);

for (const h of handlers.values()) {
  const off = h.addr.sub(mod.base);
  const tag = h.paths.join('+');

  // Show first ~10 instructions of the handler so we know what we're entering
  console.log(`\n--- handler [${tag}] @ 0x${off.toString(16)} prologue:`);
  for (let k = 0; k < 10; k++) {
    try {
      const ip = h.addr.add(k * 4);
      const ins = Instruction.parse(ip);
      console.log(`     ${ip}  ${ins}`);
    } catch (_) { break; }
  }

  try {
    Interceptor.attach(h.addr, {
      onEnter(args) {
        console.log(`\n*** HANDLER FIRED [${tag}] off=0x${off.toString(16)} t=${Date.now()}`);
        for (let i = 0; i < 6; i++) {
          let v;
          try { v = args[i].toString(); } catch (_) { v = '?'; }
          console.log(`   x${i} = ${v}`);
        }
        for (const ai of [0, 1, 2, 3]) {
          try {
            const p = args[ai];
            if (p.isNull()) continue;
            const head = p.readByteArray(96);
            console.log(`   x${ai}[0..96]:`);
            console.log(hexdump(head, { length: 96, ansi: false }));
          } catch (_) {}
        }
        const bt = Thread.backtrace(this.context, Backtracer.ACCURATE)
          .slice(0, 14)
          .map(a => {
            const o = a.sub(mod.base);
            const sym = DebugSymbol.fromAddress(a);
            return `   ${a}  off=0x${o.toString(16)}  ${sym.moduleName || '?'}!${sym.name || ''}`;
          }).join('\n');
        console.log(bt);
      },
      onLeave(retval) {
        console.log(`<<< RETURN [${tag}] retval=${retval}`);
      }
    });
    console.log(`HOOK [${tag}] @ 0x${off.toString(16)}`);
  } catch (e) {
    console.log(`!! attach err [${tag}]: ${e.message}`);
  }
}

console.log('\n=== HOOKS READY ===\n');
