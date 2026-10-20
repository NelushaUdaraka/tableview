# Releasing

`.github/workflows/release.yml` builds and publishes releases, and pushing a version tag is what
starts it.

`main` is kept ready to release. Every change to what ships prepares the next release as it lands:
the first one after a release bumps the version in `package.json` (a patch for fixes and small
improvements, a minor for a new feature), and each one adds a line about itself to that version's
section of [`CHANGELOG.md`](../CHANGELOG.md). `CLAUDE.md` holds the rule. Releasing is then tagging
`main` at the version it already carries:

```bash
git checkout main && git pull
git tag v0.2.0           # the version package.json says
git push origin v0.2.0
```

If nothing has bumped the version, `npm version patch` (or `minor`, `major`) sets it and makes the
tag in one step; push both with `git push --follow-tags`.

The workflow then:

1. runs the type check and the unit tests, and stops if the tag does not match `package.json` — the
   app compares updates against that version, so the two have to agree;
2. drafts a GitHub release for the tag. Its notes open with the version's section of
   `CHANGELOG.md`, followed by the pull requests merged since the last release;
3. builds the installer and the portable exe on Windows, and the AppImages and .debs for x64 and
   arm64 on Linux, side by side, and uploads them all to the draft with the files installed copies
   read: `latest.yml` and the installer's block map, `latest-linux.yml` and `latest-linux-arm64.yml`;
4. publishes the release once both builds are done. Only then: a draft is invisible to installed
   copies, so none of them is ever offered a release whose files are still on their way up.

A tag with a pre-release part (`v0.3.0-beta.1`) is published as a pre-release, which the stable app
never updates to. Running the workflow by hand from the Actions tab builds the same files without
releasing anything, and keeps them on the run.

**The repository has to be public.** Installed copies read the releases without signing in, and a
private repository's releases are invisible to them: the check says GitHub has no published release.

**Signing is optional, and once started, has to carry on.** Unsigned builds install and update, but
Windows SmartScreen warns on the first install. To sign, add two repository secrets: `WIN_CSC_LINK`
(the `.pfx`, base64-encoded) and `WIN_CSC_KEY_PASSWORD`. A signed copy then accepts only updates
signed by the same publisher, so a later unsigned release, or one signed with another certificate,
is downloaded and refused.

Copies built before updating existed have nothing to update them; install the first release by hand.
