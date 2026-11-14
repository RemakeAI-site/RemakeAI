import { execFileSync, spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';

const root = fileURLToPath(new URL('..', import.meta.url));
const wrangler = resolve(root, 'node_modules/wrangler/bin/wrangler.js');
const vite = resolve(root, 'node_modules/vite/bin/vite.js');
const argv = process.argv.slice(2);
const persist = argv.includes('--persist-to') ? argv[argv.indexOf('--persist-to') + 1] : '.wrangler/state';
const command = (binary, args, options = {}) => execFileSync(process.execPath,[binary,...args],{cwd:root,stdio:'inherit',...options});
if (!argv.includes('--no-build')) command(vite,['build']);
const local = ['--local','--persist-to',persist];
command(wrangler,['d1','migrations','apply','remake-ai-studio',...local]);
command(wrangler,['d1','execute','remake-ai-studio',...local,'--file','database/seeds/initial.sql']);
const serverArgs = ['--ip','127.0.0.1','--port','8787','--inspector-port','9230'];
for (const option of ['--port','--ip','--inspector-port']) {
  if (argv.includes(option)) serverArgs[serverArgs.indexOf(option)+1] = argv[argv.indexOf(option)+1];
}
const child = spawn(process.execPath,[wrangler,'dev',...local,...serverArgs,'--var','BACKUP_IMPORT_ENABLED:1'],{cwd:root,stdio:'inherit',env:{...process.env,WRANGLER_SEND_METRICS:'false'}});
for (const signal of ['SIGINT','SIGTERM']) process.on(signal,() => child.kill(signal));
child.on('exit', code => { process.exitCode = code ?? 0; });
