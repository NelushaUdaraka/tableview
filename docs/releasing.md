# Releasing

`.github/workflows/release.yml` builds and publishes releases. Bump the version and push the tag
that makes:

```bash
npm version 0.2.0        # or patch, minor, major: sets package.json and tags v0.2.0
git push --follow-tags
```

The workflow then:

1. runs the type check and the unit tests, and stops if the tag does not match `package.json` — the
   app compares updates against that version, so the two have to agree;
2. drafts a GitHub release for the tag, with notes generated from what was merged since the last one;
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
