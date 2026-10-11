# KeyQuest Server ⌨️

KeyQuest Server is a fork of [the original KeyQuest project by ovurevu](https://github.com/ovurevu/keyquest). This fork provides a convenient Docker package for hosting the app, with a Node.js server, SQLite storage, and Docker Compose configuration. See [Running with Docker](#running-with-docker) to get started.

KeyQuest is a free, open-source typing tutor for kids, in the spirit of the classic Mavis Beacon Teaches Typing.
The typing exercises run in your browser. Profiles, settings, and progress are saved on your server and shared by devices that connect to it. A server connection is required to load and save progress.

![Practice screen](docs/practice.png)

## Features

- **24 lessons in 5 units**, starting with posture and hand placement, then keys outward from the home row, capitals, numbers and punctuation, ending with short stories. Each unit ends with a test.
- **Real drills, not letter soup**: every lesson has four to six exercises built from new-key patterns, alternating-hand rhythm groups, common bigrams and trigrams, words, phrases and sentences, all using only the keys taught so far. Exercises are generated fresh every time.
- **Mastery-based progress**: a lesson needs two stars to unlock the next, and unit tests need 90% accuracy. Grown-ups can switch on "unlock all" in Settings.
- **Skill levels** (little kid, kid, big kid) scale speed targets, exercise length and game speed so a six-year-old and an eleven-year-old both get a fair challenge.
- **Tricky-keys practice**: the app watches which keys a child misses most and offers a short targeted workout from the home screen.
- **On-screen keyboard and hands** with colour-coded fingers that light up to show which finger presses the next key.
- **Live feedback**: words per minute, accuracy, a mistake buzz, and a star rating (1 to 3) for every lesson.
- **Three games**:
  - *Letter Rain*: words fall from the sky and you type them before they hit the ground.
  - *Rocket Race*: type a passage to beat Robo's rocket, which flies at 10, 20 or 35 WPM.
  - *Bubble Pop*: single letters (and capitals, numbers and punctuation on the hardest setting) rise in bubbles; hit the key before they escape.
- **One-minute speed test** on kid-friendly paragraphs.
- **Progress tracking** per child: lesson stars, a per-key accuracy heatmap and recent activity.
- **Multiple typists** with their own avatar, settings and progress.
- **Sound effects** synthesised in the browser, so no audio files.
- **Backup and restore** all server profiles and progress as a JSON file.

## Running with Docker

Install Docker with Docker Compose, then run from the `keyquest-server` directory:

```bash
docker compose up --build -d
```

Open <http://localhost:8080>, or use the host's address on your trusted network. Change the first `8080` in `docker-compose.yml` to use a different host port.

The container runs as a non-root user. SQLite lives at `/data/keyquest.sqlite`, with its journal files in the same directory. Compose mounts the named `keyquest-data` volume there, so profiles survive restarts, image rebuilds, and container replacement. Run only one application container against this volume, on local storage.

To stop the app while keeping its data:

```bash
docker compose down
```

To rebuild after updating the code:

```bash
docker compose up --build -d
```

**Data deletion:** `docker compose down -v` also deletes the database volume. Export a backup before intentionally removing the volume.

## Shared profiles and saves

This version is intended for a household or trusted network. There are no accounts or passwords: everyone who can reach the server can view, change, delete, restore, or reset all profiles. Do not expose it directly to the public internet without access control in front of it. If using a reverse proxy, preserve the original Host header.

Each browser remembers only its selected typist ID. Profiles, settings, lesson records, key statistics, game bests, and the latest 200 activity entries per typist live in SQLite. Other devices see updated data when selecting a profile, opening a screen such as Progress, or returning to the app.

The save indicator shows when results have reached the server. If a save fails, keep the page open and use **Retry**. Pending changes are held in memory; closing the page before saving may lose them. Retried requests do not count the same result twice. **Discard unsaved changes** reloads the server's saved state.

**Starting fresh:** previous browser-only profiles and progress are ignored. Create new typists on the server. There is no migration or support for importing old browser backups.

## Backup and restore

Use **Settings → Export progress** to download all server profiles and progress. Wait for pending saves to finish first. The JSON file uses the `keyquest-server` format, version 1.

Use **Settings → Restore server backup** to restore one of these files. Restore replaces all profiles and progress for every device after confirmation; invalid files are rejected without changing the database. Restore accepts up to 10 MB and 1,000 profiles. Keep a current export before restoring an older backup.

## Running without Docker

Install Node.js 24 or newer, then run:

```bash
npm ci
npm start
```

Open <http://localhost:8080>. The default database is `data/keyquest.sqlite`. Set `DATABASE_PATH` to choose another file and `PORT` to change the listening port. The server creates the database directory and initializes the schema at startup. Database files are excluded from Git and the Docker build context.

Opening `index.html` directly or serving it with a static file server does not provide the required storage API.

## Project layout

```
index.html          page structure, all screens
css/style.css       all styling
js/data/words.js    word, sentence and paragraph banks
js/data/lessons.js  curriculum, finger map and exercise generator
js/engine.js        typing session: position, errors, WPM, per-key stats
js/keyboard.js      on-screen keyboard, hands SVG, heatmap
js/audio.js         synthesised sound effects (Web Audio)
js/storage.js       server API client and retryable save queue
server/index.js     HTTP API and static asset serving
server/database.js  SQLite schema, validation and transactions
js/game.js          Letter Rain game
js/race.js          Rocket Race game
js/bubbles.js       Bubble Pop game
js/app.js           screens, navigation and glue
```

The frontend uses plain JavaScript loaded as classic scripts without a bundler. The Node.js server serves the frontend and its API from the same origin.
Everything hangs off a single `KQ` namespace.

## Customising

- **Add words or sentences**: edit `js/data/words.js`. Sentences are automatically lowercased and stripped of punctuation for learners who haven't reached those lessons yet.
- **Change the curriculum**: edit `RAW_LESSONS` in `js/data/lessons.js`. Each lesson lists the new keys it introduces, its unit, a kind (`intro`, `keys`, `review`, `shift`, `numbers`, `punct`, `story`) and a tip. Review lessons automatically get a unit test.
- **Adjust difficulty**: per-unit speed targets and exercise lengths are `UNIT_WPM` and `UNIT_LEN` in the same file, skill-level multipliers are in `KQ.LEVELS`, star thresholds live in `KQ.starsFor` in `js/engine.js`, and the stars needed to unlock the next lesson is `KQ.MASTERY_STARS` in `js/storage.js`.
- **Other keyboard layouts**: the finger map and physical layout are in `KQ.FINGERS` and `KQ.LAYOUT`. Adding AZERTY or Dvorak means adding alternative tables and a setting to pick one. Contributions welcome.

## Development

```bash
npm ci
npx playwright install chromium
npm test
```

The tests use temporary SQLite databases and run backend integration checks, cross-browser persistence and retry checks, and the existing lesson/game end-to-end suite. Set `CHROME_PATH` to use an installed Chrome or Edge instead of bundled Chromium, or `HEADED=1` to watch the lesson/game suite.

With Docker and Compose 2.24.4 or newer installed, also run:

```bash
npm run test:docker
```

This builds the image in an isolated Compose project using a temporary host port, checks HTTP serving and the non-root user, then removes and recreates the container to verify volume persistence. It removes only its own test containers and volume afterward.

Pull requests and pushes to `main` run both suites in CI. This fork uses Docker hosting; GitHub Pages deployment is disabled because the app requires its backend.

## Contributing

Bug reports, new word lists, lessons, games and translations are all welcome. Keep it dependency-free and kid-friendly.

## License

MIT. See [LICENSE](LICENSE).

*Mavis Beacon is a trademark of its respective owner. KeyQuest is an independent project and is not affiliated with it.*
