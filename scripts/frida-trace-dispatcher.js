/**
 * Trace what Serato does when it receives an OSC message on conn#2.
 *
 * We know:
 *   - Authorize/Response handler is registered @ 0xb78cfc
 *   - StatusChanged handler is registered @ 0xb78ea8
 *   - When we send `,iib` Authorize/Response, conn#2 stays alive but the
 *     handler never fires — meaning something between framer and dispatch
 *     is filtering/ignoring our message.
 *
 * Strategy:
 *   1. Find the StreamMgmt dispatcher by searching for code that loads BOTH
 *      handler addresses (0xb78cfc, 0xb78ea8) — that's the registration table
 *      consumer.
 *   2. Hook the dispatcher entry to log every OSC message it sees.
 *   3. Also hook the registered handlers themselves (sanity check).
 *   4. Hook the Authorize/Response sender (0xb78f98) so we have a known
 *      trigger point — its caller is the parent OSC pipeline. Trace any
 *      time it fires.
 *
 * If (3) doesn't fire when our message arrives but (2) does, we've found the
 * filter. If (2) also doesn't fire, the framer is rejecting silently.
 */

const mod = Process.enumerateModules()[0];
console.log(`MAIN ${mod.name} base=${mod.base} size=${mod.size}`);

const HANDLER_RESPONSE = mod.base.add(0xb78cfc);
const HANDLER_STATUS   = mod.base.add(0xb78ea8);
const REG_RESPONSE     = mod.base.add(0xb79138);
const REG_STATUS       = mod.base.add(0xb7923c);

// 1. Find xrefs INTO the handler addresses by scanning text for ADR/ADRP+ADD pairs
//    that compute these addresses. The registration site code at 0xb79138 already
//    contains an ADR x2, #0xb78cfc — but the DISPATCHER reads the function pointer
//    from a data structure, not via ADR.
//
// We'll instead search for the handler addresses STORED as 8-byte literals in
// data sections (registration tables). Then find code that reads those addresses.

console.log('\n=== scanning data sections for handler-pointer occurrences ===');
const dataRanges = Process.enumerateRanges('rw-')
  .filter(r => r.base.compare(mod.base) >= 0 &&
               r.base.compare(mod.base.add(mod.size)) < 0);

const handlerLits = [HANDLER_RESPONSE, HANDLER_STATUS];
for (const handler of handlerLits) {
  const bytes = handler.toMatchPattern();
  console.log(`searching for ${handler} pattern=${bytes}`);
  for (const r of dataRanges) {
    let scan;
    try { scan = Memory.scanSync(r.base, r.size, bytes); } catch (_) { continue; }
    for (const m of scan) {
      const off = m.address.sub(mod.base);
      console.log(`  found ${handler} at data off=0x${off.toString(16)} (${r.protection})`);
    }
  }
}

// 2. Hook handlers themselves with verbose log + LR + backtrace
function hookHandler(label, addr) {
  Interceptor.attach(addr, {
    onEnter(args) {
      console.log(`\n*** HANDLER FIRED [${label}] off=0x${addr.sub(mod.base).toString(16)} t=${Date.now()}`);
      console.log(`   x0=${this.context.x0}  x1=${this.context.x1}  x2=${this.context.x2}`);
      console.log(`   LR=${this.context.lr}  off=0x${this.context.lr.sub(mod.base).toString(16)}`);
      const bt = Thread.backtrace(this.context, Backtracer.ACCURATE)
        .slice(0, 14)
        .map(a => {
          const o = a.sub(mod.base);
          const s = DebugSymbol.fromAddress(a);
          return `   ${a}  off=0x${o.toString(16)}  ${s.moduleName || '?'}!${s.name || ''}`;
        }).join('\n');
      console.log(bt);
    }
  });
  console.log(`HOOK handler [${label}] @ 0x${addr.sub(mod.base).toString(16)}`);
}

hookHandler('Authorize/Response', HANDLER_RESPONSE);
hookHandler('StatusChanged',      HANDLER_STATUS);

// 3. Find recv/read for tcp sockets — we need to see what bytes arrive on conn#2
//    so we can correlate with handler dispatch. Hook libsystem_kernel.dylib!read.
const readPtr = Module.findExportByName(null, 'read');
const recvPtr = Module.findExportByName(null, 'recv');

if (readPtr) {
  console.log(`HOOK read @ ${readPtr}`);
  Interceptor.attach(readPtr, {
    onEnter(args) {
      this.fd = args[0].toInt32();
      this.buf = args[1];
      this.len = args[2].toInt32();
    },
    onLeave(retval) {
      const n = retval.toInt32();
      if (n <= 0) return;
      // Look for OSC bytes: starts with '/'
      try {
        const head = this.buf.readU8();
        if (head !== 0x2f) return;  // '/'
        const slice = this.buf.readByteArray(Math.min(n, 64));
        const u8 = new Uint8Array(slice);
        const ascii = Array.from(u8).map(b => (b >= 0x20 && b < 0x7f) ? String.fromCharCode(b) : '.').join('');
        const hex = Array.from(u8).map(b => b.toString(16).padStart(2,'0')).join(' ');
        console.log(`\n>> read fd=${this.fd} n=${n} ${ascii.slice(0, 48)}`);
        // Get backtrace of caller
        const bt = Thread.backtrace(this.context, Backtracer.FUZZY)
          .slice(0, 8)
          .map(a => {
            const s = DebugSymbol.fromAddress(a);
            return `   ${a}  off=0x${a.sub(mod.base).toString(16)}  ${s.name || ''}`;
          }).join('\n');
        console.log(bt);
      } catch (_) {}
    }
  });
}

// 4. Once we've seen which read returns our message, attach Stalker
//    to that thread for a brief window to see the dispatch path.
//    For now just observe the handler firings + reads.

console.log('\n=== HOOKS READY ===\n');
