/**
 * Frida discovery — list OSC-related symbols inside Serato.
 * Run synchronously so it works under `frida -q -e`.
 */
function dump(pattern) {
  const r = new ApiResolver('module');
  let m;
  try { m = r.enumerateMatches(pattern); } catch (e) {
    console.log(`!! ${pattern} -> ${e.message}`);
    return;
  }
  console.log(`== ${pattern} (${m.length} matches)`);
  for (const x of m.slice(0, 80)) console.log(`   ${x.address}  ${x.name}`);
  if (m.length > 80) console.log(`   ... +${m.length - 80} more`);
}

const main = Process.enumerateModules()[0];
console.log(`MAIN=${main.name}  base=${main.base}  size=${main.size}`);

dump('exports:*!*OSCEvent*');
dump('exports:*!*Marshaller*');
dump('exports:*!*Authorize*');
dump('exports:*!*Authoriz*');
dump('exports:*!*Pairing*');
dump('exports:*!*RemoteManagement*');
dump('exports:*!*StreamMgmt*');
dump('exports:*!*MalformedMessage*');
dump('exports:*!*readDataCallback*');
dump('exports:*!*PeerSession*');

// Try ObjC bridge
if (ObjC.available) {
  console.log('OBJC AVAILABLE');
  const classes = Object.keys(ObjC.classes);
  console.log(`OBJC class count=${classes.length}`);
  const re = /Async|OSC|Remote|Auth|Pair|Session/i;
  const hits = classes.filter(c => re.test(c));
  console.log(`OBJC interesting classes (${hits.length}):`);
  for (const c of hits.slice(0, 30)) console.log(`   ${c}`);
} else {
  console.log('OBJC unavailable');
}

console.log('-- DONE --');
