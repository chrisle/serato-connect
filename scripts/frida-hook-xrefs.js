/**
 * Hook every xref to /StreamMgmt/* path strings.
 *
 * For each ADRP+ADD pair that loads one of the OSC paths, attach a callback
 * AT the ADRP. When that PC is reached, the call site is firing.
 * This catches BOTH:
 *   - sender sites (e.g. Serato builds /StreamMgmt/Authorize/Request to send)
 *   - register sites (Serato installs a handler for /StreamMgmt/Authorize/Response)
 *
 * Goal: prove our hooks fire when Serato exercises the OSC path. If they fire
 * for senders but the receiver never fires, our Authorize/Response is being
 * rejected upstream of the dispatch handler (parser/framer/sentinel).
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

const xrefs = [];

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

      // Look for ADD with same Rn, Rd anywhere in the next 6 instructions
      for (let k = 1; k <= 6 && i + k < u32.length; k++) {
        const nx = u32[i + k];
        if (((nx & ADD_MASK) >>> 0) !== ADD_VAL) continue;
        if (rn(nx) !== adrpRd) continue;
        const computed = adrpPage.add(add_imm12(nx));
        const hit = targets.find(t => t.addr && computed.equals(t.addr));
        if (!hit) continue;

        // Look for ADR x2 within next 10 insns to mark register-style sites
        let hasAdrX2 = false;
        let handlerAddr = null;
        for (let j = k + 1; j <= k + 10 && i + j < u32.length; j++) {
          const ai = u32[i + j];
          if (((ai & ADR_MASK) >>> 0) === ADR_VAL && rd(ai) === 2) {
            hasAdrX2 = true;
            const adrPC = cur.add((i + j) * 4);
            handlerAddr = adrPC.add(imm21(ai));
            break;
          }
        }
        xrefs.push({
          path: hit.name,
          adrpPC,
          kind: hasAdrX2 ? 'REGISTER' : 'SENDER',
          handler: handlerAddr,
        });
        break;
      }
    }
  }
}

console.log(`\n=== xrefs found: ${xrefs.length} ===`);
for (const x of xrefs) {
  const off = x.adrpPC.sub(mod.base);
  let extra = '';
  if (x.handler) extra = `  handler=0x${x.handler.sub(mod.base).toString(16)}`;
  const sym = DebugSymbol.fromAddress(x.adrpPC);
  console.log(`  ${x.kind.padEnd(8)} ${x.path.padEnd(20)} pc=0x${off.toString(16)}${extra}  sym=${sym.name || '?'}`);
}

// Hook each xref AT the ADRP — this fires when execution reaches that PC.
// For senders: fires when Serato is about to send the message.
// For registers: fires once at app init (we'll miss this if we attached late).
for (const x of xrefs) {
  const off = x.adrpPC.sub(mod.base);
  const tag = `${x.kind}:${x.path}`;
  try {
    Interceptor.attach(x.adrpPC, {
      onEnter() {
        const sym = DebugSymbol.fromAddress(x.adrpPC);
        console.log(`\n*** XREF FIRED [${tag}] pc=0x${off.toString(16)} sym=${sym.name || '?'} t=${Date.now()}`);
        const ctx = this.context;
        for (const reg of ['x0','x1','x2','x3','x4','x19','x20']) {
          let v = '?';
          try { v = ctx[reg].toString(); } catch (_) {}
          console.log(`   ${reg} = ${v}`);
        }
        const bt = Thread.backtrace(this.context, Backtracer.ACCURATE)
          .slice(0, 10)
          .map(a => {
            const o = a.sub(mod.base);
            const s = DebugSymbol.fromAddress(a);
            return `   ${a}  off=0x${o.toString(16)}  ${s.moduleName || '?'}!${s.name || ''}`;
          }).join('\n');
        console.log(bt);
      }
    });
  } catch (e) {
    console.log(`!! hook err [${tag}] @ 0x${off.toString(16)}: ${e.message}`);
  }
}

// Also hook the unique handlers (for receive paths)
const handlers = new Map();
for (const x of xrefs) {
  if (!x.handler) continue;
  const k = x.handler.toString();
  if (handlers.has(k)) {
    handlers.get(k).paths.push(x.path);
  } else {
    handlers.set(k, { addr: x.handler, paths: [x.path] });
  }
}

console.log(`\n=== hooking ${handlers.size} unique receive-handlers ===`);
for (const h of handlers.values()) {
  const off = h.addr.sub(mod.base);
  const tag = `RECV:${h.paths.join('+')}`;
  try {
    Interceptor.attach(h.addr, {
      onEnter(args) {
        console.log(`\n*** RECV-HANDLER FIRED [${tag}] off=0x${off.toString(16)} t=${Date.now()}`);
        for (let i = 0; i < 6; i++) {
          let v = '?';
          try { v = args[i].toString(); } catch (_) {}
          console.log(`   x${i} = ${v}`);
        }
        for (const ai of [1, 2]) {
          try {
            const p = args[ai];
            if (!p || p.isNull()) continue;
            const head = p.readByteArray(96);
            console.log(`   x${ai}[0..96]:`);
            console.log(hexdump(head, { length: 96, ansi: false }));
          } catch (_) {}
        }
        const bt = Thread.backtrace(this.context, Backtracer.ACCURATE)
          .slice(0, 12)
          .map(a => {
            const o = a.sub(mod.base);
            const s = DebugSymbol.fromAddress(a);
            return `   ${a}  off=0x${o.toString(16)}  ${s.moduleName || '?'}!${s.name || ''}`;
          }).join('\n');
        console.log(bt);
      }
    });
    console.log(`HOOK [${tag}] @ 0x${off.toString(16)}`);
  } catch (e) {
    console.log(`!! recv hook err [${tag}]: ${e.message}`);
  }
}

console.log('\n=== HOOKS READY ===\n');
