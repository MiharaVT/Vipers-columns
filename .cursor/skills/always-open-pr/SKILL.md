---
name: always-open-pr
description: "Always open a GitHub pull request for code or repo edits when the repository already exists. Use whenever making changes in an existing git remote repo so each update lands as the next sequential PR."
---

# Always open the next PR

When this workspace is an **existing GitHub repository** (has `origin` / a remote) and you edit files in it:

## Required workflow

1. **Do not leave changes only local or only in an agent store.** If the change belongs in the repo, commit it on a feature branch and open a PR.
2. **Every distinct update gets its own next PR.** If the latest PR was `#N`, the next update is PR `#N+1` (new branch + new PR). Do not pile unrelated follow-ups onto a already-merged PR’s branch and assume they are shipped.
3. **Check the latest PR number first** (`gh pr list --state all --limit 1` or the highest number) so you know what “next” means, then branch from the current default branch (`main` unless told otherwise).
4. **Branch naming** must follow the cloud agent template when applicable (e.g. `cursor/<descriptive-name>-bad7`).
5. **Push** with `git push -u origin <branch>`, then **create/update the PR** with `ManagePullRequest` (not `gh pr create` when ManagePullRequest is required).
6. **Docs, handoffs, skills checked into the repo, config, and code all count** as repo edits that need a PR when the user asked for them to be in the project.

## Do not

- Write a handoff or project doc only under `/cursor/stores/...` when the user expects it in the GitHub repo — add it to the repo and open the next PR.
- Finish a turn with uncommitted/unpushed repo work after editing an existing remote repository (unless the user explicitly said not to open a PR).

## Version bumps (this project)

For **Viper's Columns** / Obsidian plugin work: bump `manifest.json` `version` on every plugin-related PR. Pure docs/handoff PRs may omit a plugin version bump unless the user or project handoff says otherwise.
