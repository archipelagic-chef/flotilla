# Flotilla playground

A throwaway repo for testing Flotilla on the host and in the devcontainer. Nothing to install: it runs on plain Node.

- `node src/cli.js [name]` prints a greeting.
- `node src/server.js` serves the greeting on a free port and prints its URL.
- `node --test` runs the tests. The branch `feature/greeting-without-comma` has one that fails.
