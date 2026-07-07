/**
 * Trace each decision point in handler 0xb78cfc to see exactly what happens
 * when our Authorize/Response arrives.
 *
 * Probes:
 *   0xb78d94 (after bl comparator) — dump w0 and decide path
 *   0xb78db0 (fallback entry — no match)
 *   0xb78de8 (blr x8 in fallback) — last call before return
 *   0xb78dec (instruction after blr) — confirms blr returned
 *   0xb78e08 (match path entry)
 *   0xb78e3c (blr x8 in match path)
 *   0xb78e40 (after blr in match) — confirms returned
 *   0xb78d18 (entry — dump x19, x2)
 *   0xb78d78 (loaded list bounds — dump x22, x8)
 */

const mod = Process.enumerateModules()[0];
send({tag: 'main', base: mod.base.toString()});

function readBytes(p, n) {
  try { return Array.from(new Uint8Array(p.readByteArray(n))).map(b => b.toString(16).padStart(2, '0')).join(' '); }
  catch (e) { return null; }
}

function probe(off, label, dump) {
  const a = mod.base.add(off);
  let n = 0;
  Interceptor.attach(a, {
    onEnter() {
      n++;
      const o = {tag: label, n, t: Date.now()};
      if (dump) {
        try { Object.assign(o, dump(this.context)); } catch(e) { o.err = e.message; }
      }
      send(o);
    }
  });
}

// Probe only TWO points: after-compare (D) and either-blr-call.
probe(0xb78d94, 'D_after_compare', ctx => ({
  w0: ctx.x0.toUInt32().toString(16),
  x22: ctx.x22.toString(),
  x22_bytes: readBytes(ctx.x22, 32),
}));

// And the fallback blr — only fires if the compare loop ended without match.
probe(0xb78de8, 'F_fallback_blr_x8', ctx => ({
  x8: ctx.x8.toString(),
  x0: ctx.x0.toString(),
  w2: ctx.x2.toUInt32(),
  x3: ctx.x3.toString(),
  x4: ctx.x4.toString(),
}));

let beats = 0;
setInterval(() => { beats++; send({tag: 'beat', n: beats, t: Date.now()}); }, 5000);

send({tag: 'setup_done'});
