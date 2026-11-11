// Entry point of the PDF worker threads (render.ts). A worker doesn't get the tsx loader that the app was started
// with, so it registers tsx itself before loading the TypeScript worker code.
import { register } from 'tsx/esm/api';

register();
await import('./render-worker.ts');
