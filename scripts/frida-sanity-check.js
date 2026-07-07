/**
 * Sanity check: hook a function that we KNOW fires (Serato's Authorize/Request
 * sender at 0xb791ac, which builds and sends the auth request when conn#2
 * opens) along with the suspected receive handler at 0xb78cfc.
 *
 * Outcomes:
 *   sender fires + handler fires → our message reaches dispatch (we'd be done)
 *   sender fires + handler silent → hook works, handler genuinely never called
 *   sender silent + handler silent → hook attachment broken (e.g., wrong addr)
 */

const mod = Process.enumerateModules()[0];
console.log(`MAIN ${mod.name} base=${mod.base}`);

const points = [
  { label: 'SEND Authorize/Request',  off: 0xb791ac },
  { label: 'SEND Pair',               off: 0xb79260 },
  { label: 'HANDLER Authorize/Response', off: 0xb78cfc },
  { label: 'HANDLER StatusChanged',      off: 0xb78ea8 },
  // Also hook the address-string CONSUMERS — the func that walks "/StreamMgmt/Authorize/Response"
  // The "REG" sites:
  { label: 'REG-A Authorize/Response (b78f98)', off: 0xb78f98 },
  { label: 'REG-A StatusChanged (b78fc0)',      off: 0xb78fc0 },
  { label: 'REG-B Authorize/Response (b79138)', off: 0xb79138 },
  { label: 'REG-B StatusChanged (b7923c)',      off: 0xb7923c },
];

for (const p of points) {
  const addr = mod.base.add(p.off);
  try {
    Interceptor.attach(addr, {
      onEnter(args) {
        console.log(`\n*** [${p.label}] off=0x${p.off.toString(16)} t=${Date.now()}`);
        for (let i = 0; i < 6; i++) {
          let v;
          try { v = args[i].toString(); } catch { v = '?'; }
          console.log(`   x${i} = ${v}`);
        }
        const bt = Thread.backtrace(this.context, Backtracer.ACCURATE)
          .slice(0, 8)
          .map(a => {
            const o = a.sub(mod.base);
            const inMod = a.compare(mod.base) >= 0 && a.compare(mod.base.add(mod.size)) < 0;
            return inMod ? `   MAIN+0x${o.toString(16)}` : `   ${a}`;
          }).join('\n');
        console.log(bt);
      }
    });
    console.log(`HOOK ${p.label} @ 0x${p.off.toString(16)}`);
  } catch (e) {
    console.log(`!! attach err ${p.label}: ${e.message}`);
  }
}

console.log('\n=== HOOKS READY ===\n');
