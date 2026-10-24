# Branching

| Branch | Role |
|---|---|
| `tvs-version-15` | **Production.** Protected. Only receives pull requests from `tvs-version-15-development`. |
| `tvs-version-15-development` | **Development.** Integration branch for all new work and fixes. |

## How changes flow

1. Create your branch from `tvs-version-15-development` (for example `fix/...` or `feat/...`) and open a pull request into `tvs-version-15-development`.
2. To release, open a pull request from `tvs-version-15-development` into `tvs-version-15`.

## Rules on `tvs-version-15`

A pull request into `tvs-version-15` can be merged only when:

1. It comes from `tvs-version-15-development`. The `Guard production` workflow (`.github/workflows/guard-production.yml`) enforces this through the required check **PR source must be the development branch**.
2. It has at least **1 approval** from someone other than the author.
3. Tests: none are required by branch protection yet, so run the project's checks locally before opening the PR.

Also on `tvs-version-15`:

- No direct pushes, including administrators.
- No force pushes and no branch deletion.
- Hotfixes go through `tvs-version-15-development` first, then a pull request into `tvs-version-15`.
