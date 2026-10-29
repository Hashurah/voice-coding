// Runs the live Claude Code test inside the Electron app (uses your Claude account).
import { spawnSync } from 'node:child_process';
const r = spawnSync('npx', ['playwright', 'test', 'tests/e2e/claude.live.spec.ts'], { stdio: 'inherit', shell: true, env: { ...process.env, VCC_LIVE: '1' } });
process.exit(r.status ?? 1);
