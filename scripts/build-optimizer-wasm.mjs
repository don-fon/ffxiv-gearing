import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const output = path.join(root, 'src/optimizerSearch.wasm');
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'optimizer-wasm-'));
const target = path.join(temporary, 'optimizerSearch.wasm');
const exports = ['search_abi', 'search_cache_bytes', 'search_frame_bytes', 'configure_search',
  'start_search', 'step_search', 'search_damage', 'search_visited', 'search_evaluated',
  'search_coverage', 'search_selected', 'search_error', 'pareto_node_bytes', 'pareto_frontier', '__heap_base'];
try {
  const args = ['--target=wasm32', '-O3', '-ffp-contract=off', '-fno-builtin', '-nostdlib',
    '-mbulk-memory', '-msimd128', `-fuse-ld=${process.env.WASM_LD || 'lld'}`,
    '-Wl,--no-entry', '-Wl,--import-memory', '-Wl,-z,stack-size=1048576',
    '-Wl,--initial-memory=8388608', '-Wl,--max-memory=2147483648', '-Wl,--strip-all',
    ...exports.map(name => `-Wl,--export=${name}`), path.join(root, 'src/optimizerSearch.c'), '-o', target];
  const result = spawnSync(process.env.WASM_CC || 'clang-19', args, { stdio: 'inherit' });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`WASM compiler exited with ${result.status}`);
  const bytes = fs.readFileSync(target);
  if (process.argv.includes('--check')) {
    if (!bytes.equals(fs.readFileSync(output))) throw new Error('WASM artifact differs; rebuild with the pinned LLVM 19 toolchain.');
    console.log(`WASM artifact matches source (${bytes.length} bytes).`);
  } else {
    fs.writeFileSync(output, bytes, { mode: 0o644 });
    fs.chmodSync(output, 0o644);
    console.log(`Built ${bytes.length} bytes: src/optimizerSearch.wasm`);
  }
} finally {
  fs.rmSync(temporary, { recursive: true, force: true });
}
