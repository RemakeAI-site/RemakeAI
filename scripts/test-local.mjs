import { spawn, spawnSync } from 'node:child_process';
import { createWriteStream } from 'node:fs';
import { mkdtemp, rm, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const cwd = fileURLToPath(new URL('..',import.meta.url));
const persisted = await mkdtemp(resolve(tmpdir(),'remake-tests-'));
const rootPort = Number(process.env.STUDIO_TEST_PORT ?? 8797);
const base = 'http://127.0.0.1:'+rootPort;
const restored = 'http://127.0.0.1:'+(rootPort+1);
const children = [];
const flags = process.argv.slice(2);
const e2e = flags.includes('--e2e');
const apiOnly = flags.includes('--api-only');
const env = {...process.env, WRANGLER_SEND_METRICS:'false', NO_PROXY:'localhost,127.0.0.1'};

function run(path,args,more={}) {
  const result = spawnSync(process.execPath,[path,...args],{cwd,env:{...env,...more},stdio:'inherit'});
  if (result.status!==0) throw new Error(path+' завершился с кодом '+result.status);
}
async function start(port,dir) {
  const log = createWriteStream(resolve(cwd,'test-results',`worker-${port}.log`));
  const child = spawn(process.execPath,['scripts/local.mjs','--no-build','--port',String(port),'--inspector-port',String(port+1000),'--persist-to',dir],{cwd,env,stdio:['ignore','pipe','pipe']});
  child.stdout.pipe(log,{end:false});
  child.stderr.pipe(log,{end:false});
  child.once('exit',()=>log.end());
  children.push(child);
  for (let i=0;i<150;i++) {
    if (child.exitCode!==null) throw new Error('Wrangler завершился. Журнал в test-results.');
    const ok = await fetch(`http://127.0.0.1:${port}/api/stats`,{signal:AbortSignal.timeout(1000)}).then(r=>r.ok).catch(()=>false);
    if (ok) return;
    await new Promise(done=>setTimeout(done,200));
  }
  throw new Error('Тестовый сервер не запустился. Журнал в test-results.');
}
try {
  await mkdir(resolve(cwd,'test-results'),{recursive:true});
  if (!apiOnly) run('node_modules/vite/bin/vite.js',['build']);
  await start(rootPort,resolve(persisted,'main'));
  await start(rootPort+1,resolve(persisted,'restore'));
  if (!e2e) {
    run('tests/content.integration.mjs',[base]);
    run('tests/media.integration.mjs',[base]);
    run('tests/backup.integration.mjs',[base,restored,persisted]);
    run('tests/library.integration.mjs',[base,resolve(persisted,'main')]);
  } else run('node_modules/@playwright/test/cli.js',['test',...flags.filter(flag=>flag!=='--e2e')],{STUDIO_TEST_URL:base,STUDIO_RESTORE_URL:restored});
} finally {
  for (const child of children) child.kill('SIGTERM');
  await Promise.all(children.map(child=>child.exitCode === null && child.signalCode === null ? new Promise(done=>child.once('exit',done)) : Promise.resolve()));
  await rm(persisted,{recursive:true,force:true});
}
