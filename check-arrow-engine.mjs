// Fails (exit 1) if lib/arrowEngine.js no longer matches the engine inside games/arrow-puzzle.html.
import fs from 'fs';
const html = fs.readFileSync(new URL('../games/arrow-puzzle.html', import.meta.url), 'utf8');
const a = html.split('/*ENGINE_START*/')[1].split('/*ENGINE_END*/')[0].trim();
const lib = fs.readFileSync(new URL('../lib/arrowEngine.js', import.meta.url), 'utf8');
const b = lib.slice(lib.indexOf('const DIRS'), lib.lastIndexOf('export {')).trim();
if (a !== b) { console.error('arrowEngine.js is OUT OF SYNC with games/arrow-puzzle.html'); process.exit(1); }
console.log('arrowEngine.js matches the game engine');
