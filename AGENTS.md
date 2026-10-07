# AGENTS.md

Repo-level working rules. Area-specific guides: `CLAUDE.md` (repo overview), `open-sse/AGENTS.md` (routing/translation engine), `tests/translator/AGENTS.md`.

## Release discipline — bump the version on every push

Every push to `master-sina` MUST ship a version bump in the same push:

1. Bump `package.json` **and** `cli/package.json` to the next version (patch for fixes, e.g. `0.5.95` → `0.5.96`).
2. Prepend a matching `# vX.Y.Z (YYYY-MM-DD)` entry to `CHANGELOG.md` describing the changes since the last tag.
3. Commit as `chore(release): bump to X.Y.Z`.
4. Move/recreate the tag on the new HEAD (`git tag -f vX.Y.Z`) and push branch + tag together (`git push origin master-sina && git push -f origin vX.Y.Z`).

Never push code without the bump, and never leave a tag pointing at a stale commit — tags are lightweight and must always match the bumped `package.json` version.
