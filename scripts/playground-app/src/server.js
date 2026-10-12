// A small HTTP server on a free port: `node src/server.js` prints its URL.
import http from 'node:http';
import { pathToFileURL } from 'node:url';
import { greet } from './greeting.js';

export function createServer() {
  return http.createServer((request, response) => {
    response.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' });
    response.end(`${greet('playground')}\n`);
  });
}

// Only when run directly, not when a test imports this file.
if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const server = createServer();
  server.listen(0, '127.0.0.1', () => {
    console.log(`http://127.0.0.1:${server.address().port}/`);
  });
}
