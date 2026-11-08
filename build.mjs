import {build} from 'esbuild';
await build({entryPoints:['src/hub.ts'],bundle:true,format:'esm',platform:'browser',outfile:'web/hub.js',external:['/scripts/*'],sourcemap:false});
