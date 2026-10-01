import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';

// Exact upstream bytes even when the user's Windows Git defaults to CRLF.
// Scope this configuration to the child process, never mutate global Git config.
const env = { ...process.env };
const index = Number(env.GIT_CONFIG_COUNT ?? '0');
if (!Number.isSafeInteger(index) || index < 0 || index > 32) throw new Error('Invalid inherited Git configuration');
env.GIT_CONFIG_COUNT = String(index + 1);
env[`GIT_CONFIG_KEY_${index}`] = 'core.autocrlf';
env[`GIT_CONFIG_VALUE_${index}`] = 'false';
execFileSync('forge', ['install', '--no-git', '--shallow',
  'forge-std=foundry-rs/forge-std@rev=bf647bd6046f2f7da30d0c2bf435e5c76a780c1b',
  'openzeppelin-contracts=OpenZeppelin/openzeppelin-contracts@rev=cab19933c33c2ad1d4c7a84864a3601dddfd16f3',
], { cwd: resolve(import.meta.dirname, '..'), stdio: 'inherit', env });
