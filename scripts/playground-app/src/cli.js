// Prints a greeting: `node src/cli.js` or `node src/cli.js Ada`.
import { greet } from './greeting.js';

console.log(greet(process.argv[2]));
