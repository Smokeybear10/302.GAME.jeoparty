'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const zlib = require('node:zlib');
const { PREPARED_ARCHIVE_VERSION, gamesFromHowardArchive } = require('../lib/howard-archive');

const SOURCE = 'https://raw.githubusercontent.com/howardchung/jeopardy/master/jeopardy.json.gz';
const OUTPUT = path.join(__dirname, '..', 'data', 'archive', 'howard-jeopardy.json.gz');
const PREPARED_OUTPUT = path.join(path.dirname(OUTPUT), 'howard-playable.json');

async function main() {
  const response = await fetch(SOURCE, { redirect: 'follow' });
  if (!response.ok) throw new Error(`Archive download failed: ${response.status} ${response.statusText}`);

  const compressed = Buffer.from(await response.arrayBuffer());
  const archive = JSON.parse(zlib.gunzipSync(compressed).toString('utf8'));
  const episodeCount = Object.keys(archive).length;
  if (episodeCount < 1000) throw new Error(`Archive only contained ${episodeCount} episodes`);
  const games = gamesFromHowardArchive(archive, { limit: 0 });

  await fs.mkdir(path.dirname(OUTPUT), { recursive: true });
  const temporary = `${OUTPUT}.tmp`;
  await fs.writeFile(temporary, compressed);
  await fs.rename(temporary, OUTPUT);
  await fs.writeFile(`${PREPARED_OUTPUT}.tmp`, JSON.stringify({ version: PREPARED_ARCHIVE_VERSION, games }));
  await fs.rename(`${PREPARED_OUTPUT}.tmp`, PREPARED_OUTPUT);
  console.log(`Downloaded ${episodeCount} episodes (${(compressed.length / 1e6).toFixed(1)} MB) to ${OUTPUT}`);
  console.log(`Prepared ${games.length} complete text-only games for startup`);
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
