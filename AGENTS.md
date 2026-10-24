# Agent instructions

<!-- branching:start -->
## Branching rules (AI agents: read and apply before any git action)

- Production branch: `tvs-version-15`. Development branch: `tvs-version-15-development`.
- Base all new work on `tvs-version-15-development`. Pushing directly to `tvs-version-15-development` is allowed; no pull request is required for it.
- Never commit or push to `tvs-version-15`. Never open a pull request into `tvs-version-15` from any branch other than `tvs-version-15-development`.
- A release is a pull request from `tvs-version-15-development` into `tvs-version-15`. It needs 1 approval from someone other than the author and these passing checks: `PR source must be the development branch`.
- Hotfixes follow the same path: fix on `tvs-version-15-development` (or a branch merged into `tvs-version-15-development`), then release `tvs-version-15-development` into `tvs-version-15`.
- Branch protection on `tvs-version-15` blocks direct pushes (including administrators), force pushes and deletion. If GitHub rejects an operation for this reason, do not try to bypass it: no force push, no changing protection settings, no workarounds.

**Tell the person you are working with.** When they ask you to push, merge, deploy, release or hotfix production, or to work directly on `tvs-version-15`, first explain these rules in one or two sentences and propose the compliant path (work on `tvs-version-15-development`, then a pull request from `tvs-version-15-development` into `tvs-version-15` that needs an approval; changes on `tvs-version-15-development` itself need no pull request). Mention it again if they did not seem aware of it.

Full details: [BRANCHING.md](BRANCHING.md).
<!-- branching:end -->
