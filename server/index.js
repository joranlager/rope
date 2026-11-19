import { createApp } from './app.js';

const port = Number(process.env.PORT ?? 8080);
const dataFile = process.env.DATA_FILE ?? 'data/store.json';

const server = createApp({ dataFile });
server.listen(port, () => {
  console.log(`Rope listening on http://localhost:${port} (data: ${dataFile})`);
});
