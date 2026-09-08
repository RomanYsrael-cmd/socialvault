import base from './vite.config';
// Keep real validation runs alive while instrumentation is edited locally.
export default { ...base, server: { ...base.server, hmr: false } };
