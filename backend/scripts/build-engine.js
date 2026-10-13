import { spawnSync } from 'node:child_process';
import { mkdirSync, readdirSync } from 'node:fs';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const engine = resolve(dirname(fileURLToPath(import.meta.url)), '../../engine');
const out = join(engine, 'out');
mkdirSync(out, { recursive: true });
const files = [...readdirSync(join(engine, 'src/osh')).map((f) => join(engine, 'src/osh', f)), join(engine, 'test/Tests.java')];
const jdkHome = process.env.JAVA_HOME;
const javac = jdkHome ? join(jdkHome, 'bin', 'javac') : 'javac';
let r = spawnSync(javac, ['-d', out, ...files], { stdio: 'inherit' });
if (r.error) { // no javac launcher: fall back to the compiler module bundled with the JDK runtime
  const java = process.env.JAVA_BIN || (jdkHome ? join(jdkHome, 'bin', 'java') : 'java');
  r = spawnSync(java, ['-m', 'jdk.compiler/com.sun.tools.javac.Main', '-d', out, ...files], { stdio: 'inherit' });
}
if (r.error || r.status !== 0) { console.error('Engine compilation failed. Install a JDK 17+ and set JAVA_HOME.'); process.exit(1); }
console.log('Engine compiled to', out);
