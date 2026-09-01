import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';
export default defineConfig({ plugins:[react()],server:{headers:{'Cross-Origin-Opener-Policy':'same-origin','Cross-Origin-Embedder-Policy':'require-corp'}},optimizeDeps:{exclude:['@sqlite.org/sqlite-wasm']},test:{environment:'jsdom',setupFiles:'./src/tests/setup.ts',css:true,globals:true,exclude:['e2e/**','node_modules/**']} });
