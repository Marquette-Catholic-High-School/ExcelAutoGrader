/**
 * `npm run dev` entry point. The Vite dev server proxies /api to port 3001 (client/vite.config.ts), so in
 * development the API always listens there, even when the environment sets PORT for some other tool (a
 * launcher that injects PORT for the web page would otherwise move the API away from the proxy).
 * Set API_PORT to use a different port, and change the proxy target to match.
 * `npm start` and `tsx src/index.ts` still honour PORT.
 */
process.env.PORT = process.env.API_PORT || '3001';

await import('./index.js');
