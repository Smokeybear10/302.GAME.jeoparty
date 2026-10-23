'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const zlib = require('node:zlib');
const test = require('node:test');
const { PREPARED_ARCHIVE_VERSION, gameFromEpisode, gamesFromHowardArchive, requiresMissingMedia } = require('../lib/howard-archive');
const { loadGames, loadPreferredGames, validateGame } = require('../lib/game-store');

function completeEpisode(epNum = '123') {
  const jeopardy = [];
  for (let x = 1; x <= 6; x += 1) {
    for (let y = 1; y <= 5; y += 1) {
      jeopardy.push({
        x,
        y,
        q: `Clue ${x}-${y}`,
        a: `Response ${x}-${y}`,
        cat: `CATEGORY ${x}`,
        dd: x === 2 && y === 3,
        val: y * 200,
      });
    }
  }
  return {
    epNum,
    airDate: '2025-01-02',
    jeopardy,
    double: jeopardy.map((clue) => ({
      ...clue,
      q: `Double ${clue.q}`,
      cat: `DOUBLE ${clue.cat}`,
      dd: (clue.x === 1 || clue.x === 4) && clue.y === 4,
      val: clue.val * 2,
    })),
    final: [{ x: 1, y: 1, q: 'Final clue', a: 'Final response', cat: 'FINAL CATEGORY', dd: false, val: 0 }],
  };
}

test('converts both Howard rounds with their original Daily Double positions', () => {
  const game = gameFromEpisode(completeEpisode(), '123');

  assert.equal(game.id, 'archive-123');
  assert.equal(game.title, 'Jan 2, 2025');
  assert.equal(game.description, 'Episode 123 · original broadcast');
  assert.equal(game.source, 'archive');
  assert.equal(game.year, 2025);
  assert.equal(game.airDate, '2025-01-02');
  assert.equal(game.categories.length, 6);
  assert.deepEqual(game.categories[0].clues.map((clue) => clue.value), [200, 400, 600, 800, 1000]);
  assert.equal(game.categories.flatMap((category) => category.clues).filter((clue) => clue.dailyDouble).length, 1);
  assert.deepEqual(game.doubleJeopardy.categories[0].clues.map((clue) => clue.value), [400, 800, 1200, 1600, 2000]);
  assert.equal(game.doubleJeopardy.categories.flatMap((category) => category.clues).filter((clue) => clue.dailyDouble).length, 2);
  assert.equal(game.categories[1].clues[2].dailyDouble, true);
  assert.equal(game.doubleJeopardy.categories[0].clues[3].dailyDouble, true);
  assert.equal(game.doubleJeopardy.categories[3].clues[3].dailyDouble, true);
  assert.equal(game.finalJeopardy.category, 'FINAL CATEGORY');
  assert.deepEqual(validateGame(game, game.id), []);
});

test('skips incomplete episodes and respects the requested library limit', () => {
  const archive = {
    incomplete: { ...completeEpisode('1'), jeopardy: [] },
    first: completeEpisode('2'),
    second: { ...completeEpisode('3'), airDate: '2025-02-01' },
  };

  const games = gamesFromHowardArchive(archive, { limit: 1 });
  assert.equal(games.length, 1);
  assert.equal(games[0].id, 'archive-3');
});

test('prepared archive replaces raw parsing and preserves all boards or the requested limit', (context) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'jeopardy-prepared-'));
  context.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const archivePath = path.join(directory, 'howard-jeopardy.json.gz');
  const preparedArchivePath = path.join(directory, 'howard-playable.json');
  const games = gamesFromHowardArchive({
    first: completeEpisode('2'),
    second: { ...completeEpisode('3'), airDate: '2025-02-01' },
  }, { limit: 0 });
  fs.writeFileSync(archivePath, 'raw archive must not be parsed');
  fs.writeFileSync(preparedArchivePath, JSON.stringify({ version: PREPARED_ARCHIVE_VERSION, games }));

  assert.deepEqual(loadPreferredGames({ archivePath, archiveLimit: 0 }), games);
  assert.deepEqual(loadPreferredGames({ archivePath, archiveLimit: 1 }), [games[0]]);
  assert.deepEqual(loadPreferredGames({ archivePath, archiveLimit: -1 }), games);
  fs.unlinkSync(archivePath);
  assert.deepEqual(loadPreferredGames({ archivePath, archiveLimit: 0 }), games);
});

test('an unprepared archive keeps the raw loader and missing archives keep the bundled bank', (context) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'jeopardy-raw-'));
  context.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const archivePath = path.join(directory, 'howard-jeopardy.json.gz');
  const archive = { first: completeEpisode('2') };
  fs.writeFileSync(archivePath, zlib.gzipSync(JSON.stringify(archive)));

  assert.deepEqual(loadPreferredGames({ archivePath }), gamesFromHowardArchive(archive));
  fs.unlinkSync(archivePath);
  assert.deepEqual(loadPreferredGames({ archivePath }), loadGames());
});

test('an invalid prepared bank fails startup instead of serving an empty archive', (context) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'jeopardy-invalid-prepared-'));
  context.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const archivePath = path.join(directory, 'howard-jeopardy.json.gz');
  const preparedArchivePath = path.join(directory, 'howard-playable.json');

  for (const invalid of [[], {}]) {
    fs.writeFileSync(preparedArchivePath, JSON.stringify(invalid));
    assert.throws(() => loadPreferredGames({ archivePath }), /Prepared archive must contain playable games/);
  }
});


test('incomplete second rounds and missing Daily Doubles are not filled with invented clues', () => {
  const missingClue = completeEpisode();
  missingClue.double.pop();
  assert.equal(gameFromEpisode(missingClue, '123'), null);

  for (const round of ['jeopardy', 'double']) {
    const missingDouble = completeEpisode();
    missingDouble[round].forEach((clue) => { clue.dd = false; });
    assert.equal(gameFromEpisode(missingDouble, '123'), null);
  }
});

test('excludes episodes whose first, second, or final round needs unavailable media', () => {
  for (const round of ['jeopardy', 'double', 'final']) {
    const episode = completeEpisode('9420');
    episode[round][0].q = "Perfect for a language category, it's the math symbol seen here";
    episode[round].filter((clue) => clue.x === 1).forEach((clue) => { clue.cat = 'COMPARATIVE WORDS'; });
    assert.equal(gameFromEpisode(episode, '9420'), null, round);
  }
});

test('missing-media detection distinguishes external material from ordinary trivia', () => {
  const missing = [
    'Name the singer heard here',
    'Highlighted here, this part of the brain plays a big role in controlling respiration',
    'Noun then adjective, it is the correct heraldic way to refer to the creature here',
    "Here's a piece from this celebrated American artist, known for capturing all sorts of seaworthy scenes",
    'No: This expert British murder solver, here portrayed by Angela Lansbury',
    'Here are two titans of 20th century music, this conductor with Aaron Copland',
    'This photograph shows a bridge in this city',
    '(Audio Daily Double) Name this tune',
    '[Instrumental music plays] Name the composer',
    'The flag shown below belongs to this nation',
    'Watch this clip and name the actor',
  ];
  for (const q of missing) assert.equal(requiresMissingMedia({ q }), true, q);
  assert.equal(requiresMissingMedia({ q: 'Name the landmark', cat: 'VIDEO CLUES' }), true);
  for (const cat of ['PICTURE THE HIT SONG', 'PICTURE THE 21st CENTURY FILM', 'NOVEL PICTURE PUZZLES', 'OSCAR BEST PICTURE PARTIAL MARQUEES', 'A PICTURE IS WORTH...']) {
    assert.equal(requiresMissingMedia({ q: 'A classic from 1980', cat }), true, cat);
  }
  for (const cat of ['AUDIO BOOKS', 'BEST PICTURE OSCAR WINNERS', 'FROM THE VIDEO GAME MANUAL']) {
    assert.equal(requiresMissingMedia({ q: 'A text-only clue', cat }), false, cat);
  }

  const textOnly = [
    'This video game stars a plumber named Mario',
    'In this video game, Mario rescues Princess Peach',
    'Video in which Michael Jackson plays a werewolf & a zombie',
    'The Frenchman Laennec invented this instrument to listen for sounds inside a body',
    'Its capital is Montevideo',
    'Some U.S. airmail stamps depicted these transatlantic craft',
    'This former dean was pictured with a robe in her high school yearbook',
    'In this novel, the narrator recalls a childhood in Alabama',
  ];
  for (const q of textOnly) assert.equal(requiresMissingMedia({ q }), false, q);
});

test('filters archive display directions and picture wordplay that lack their media', () => {
  const examples = [
    ['9291', "Here's this group at the beach"],
    ['8339', 'Here he is leaving the luncheon after accepting his 2018 Music Prize'],
    ['5608', '(A balance is shown)Change the balance, the deciding factor'],
    ['4608', "Created in 1981, this video game character's life ends when you hear the following sound"],
    ['4055', 'This 1764 inventionseen here,whose name includesa female first name,revolutionizedBritish industry'],
    ['6245', '(Jimmy of the Clue Crew explains a painting shown on a monitor.) In art composition, to make the painting more interesting, divide it & put the focus along the lines to follow this fractional rule'],
    ['9302', "It's not a shaped vessel that kids poor gooey stuff into, it's the spore-producing, forest floor-loving organism here"],
  ];
  for (const [id, q] of examples) {
    assert.equal(requiresMissingMedia({ q }), true, id);
    const episode = completeEpisode(id);
    episode.double[0].q = q;
    assert.equal(gameFromEpisode(episode, id), null, id);
  }

  const pictureWordplay = completeEpisode('4616');
  pictureWordplay.jeopardy.filter((clue) => clue.x === 1).forEach((clue) => { clue.cat = '2 PICTURES SAY 1 WORD'; });
  pictureWordplay.jeopardy[0].q = 'This is right';
  assert.equal(requiresMissingMedia(pictureWordplay.jeopardy[0]), true);
  assert.equal(gameFromEpisode(pictureWordplay, '4616'), null);

  for (const q of [
    'Clinical tests have shown this pungent bulb, allium sativum, can lower both cholesterol & blood pressure',
    'During the summer of 1972, reruns of this long-running Western were shown under the title "Ponderosa"',
    'This character appears in the music video "Here It Goes Again"',
    'When you hear a bell ring, a character in this film says an angel gets its wings',
    "Here's some business jargon: this piece of A.I. is a specific task created in a meeting for someone to follow up with",
  ]) assert.equal(requiresMissingMedia({ q }), false, q);
});

test('legacy prepared files rebuild both rounds from the cached archive without losing the full bank', (context) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'jeopardy-migrate-'));
  context.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const archivePath = path.join(directory, 'howard-jeopardy.json.gz');
  const preparedArchivePath = path.join(directory, 'howard-playable.json');
  const archive = { first: completeEpisode('2'), second: completeEpisode('3') };
  const expected = gamesFromHowardArchive(archive, { limit: 0 });
  const legacy = expected.map(({ doubleJeopardy, ...game }) => game);
  fs.writeFileSync(archivePath, zlib.gzipSync(JSON.stringify(archive)));
  fs.writeFileSync(preparedArchivePath, JSON.stringify(legacy));

  assert.deepEqual(loadPreferredGames({ archivePath, archiveLimit: 1 }), [expected[0]]);
  assert.deepEqual(JSON.parse(fs.readFileSync(preparedArchivePath, 'utf8')), {
    version: PREPARED_ARCHIVE_VERSION,
    games: expected,
  });
  assert.deepEqual(loadPreferredGames({ archivePath, archiveLimit: 0 }), expected);
});

test('stale caches without raw data and current caches missing a second round fail explicitly', (context) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'jeopardy-stale-'));
  context.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const archivePath = path.join(directory, 'howard-jeopardy.json.gz');
  const preparedArchivePath = path.join(directory, 'howard-playable.json');
  const game = gameFromEpisode(completeEpisode(), '123');
  delete game.doubleJeopardy;
  fs.writeFileSync(preparedArchivePath, JSON.stringify([game]));
  assert.throws(() => loadPreferredGames({ archivePath }), /outdated.*fetch:archive/);
  fs.writeFileSync(preparedArchivePath, JSON.stringify({ version: PREPARED_ARCHIVE_VERSION, games: [game] }));
  assert.throws(() => loadPreferredGames({ archivePath }), /must include Double Jeopardy/);
});


test('current caches cannot bypass missing-media filtering in either board or Final', (context) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'jeopardy-media-cache-'));
  context.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const archivePath = path.join(directory, 'howard-jeopardy.json.gz');
  const preparedArchivePath = path.join(directory, 'howard-playable.json');
  for (const round of ['jeopardy', 'double', 'final']) {
    const game = gameFromEpisode(completeEpisode(), '123');
    const clue = round === 'final' ? game.finalJeopardy
      : (round === 'double' ? game.doubleJeopardy.categories : game.categories)[0].clues[0];
    clue.clue = 'Name the symbol shown here';
    fs.writeFileSync(preparedArchivePath, JSON.stringify({ version: PREPARED_ARCHIVE_VERSION, games: [game] }));
    assert.throws(() => loadPreferredGames({ archivePath }), /references unavailable media/);
  }
});
