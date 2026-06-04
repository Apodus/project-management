# Runbook — Establish GitHub as the daemon's canonical main (game_one)

**Audience:** the game_one team member who owns git/infra on the daemon host.
**Why:** the merge-train daemon clones a repo URL, tracks its `main`/`master`
(`git fetch` → `reset --hard <remote>/<branch>`), and on a successful land **pushes** to that
branch. Pushing to a normal checked-out working repo is refused by git ("won't update the
checked-out branch"), so the canonical main must be a **bare** remote — GitHub here. This runbook
gets your local-only landed history onto GitHub and gives the daemon credentials to push.

> One-time setup. Budget ~30–60 min, mostly the history reconcile. Do it on the daemon host (or
> anywhere with push rights), not inside a daemon worktree.

---

## 0. Preconditions / facts to confirm first

- **Local is ahead of GitHub, and they've diverged.** As reported: rynx local `master` is at
  `66d53713` while `origin/master` is stale at `4f632dcc`; the outer game repo's landed arcs
  (grass/foliage + the enet/vma fix) are local-only too. Expect a **non-fast-forward** push.
- **Two repos.** Inner `rynx` (D:\code\game_one\rynx) and outer `game_one` (D:\code\game_one),
  linked by a `160000` gitlink at path `rynx`. Both need their canonical main on GitHub.
- **Submodules.** jolt, zstd, portaudio, spirv-reflect, sharpmake, and now enet/vma — all resolvable
  via `git submodule update --init --recursive`. Confirm `.gitmodules` URLs are reachable from the host.
- **Decide the branch name per repo.** rynx's mainline is `master`; the outer may be `main` or
  `master`. Whatever you pick is the daemon's `git_main_branch` for that repo.

## 1. Back up the local history before touching anything

```powershell
# A throwaway safety tag on each repo's current local tip — instant, free, lets you recover.
cd D:\code\game_one\rynx ;  git tag backup/pre-github-reconcile-rynx  HEAD
cd D:\code\game_one      ;  git tag backup/pre-github-reconcile-outer HEAD
```

Optionally also `git bundle create ..\rynx-backup.bundle --all` for an off-disk copy.

## 2. Inspect the divergence (don't guess — look)

```powershell
cd D:\code\game_one\rynx
git fetch origin
git log --oneline --graph origin/master..HEAD     # what you have that GitHub doesn't
git log --oneline --graph HEAD..origin/master      # what GitHub has that you don't (the risk)
```

- If `HEAD..origin/master` is **empty**, GitHub has nothing you'd lose → a force-push is safe (§3a).
- If it's **non-empty**, someone pushed to GitHub independently → you must reconcile (§3b) before
  overwriting, or you'll drop their commits.

Repeat for the outer `game_one`.

## 3. Get local history onto GitHub

### 3a. GitHub has nothing unique (clean overwrite) — preferred if §2 showed empty

```powershell
cd D:\code\game_one\rynx
git push origin master --force-with-lease          # --force-with-lease, NOT --force: refuses if
                                                   # the remote moved since your fetch (safety)
git push origin --tags                              # if you keep release tags

cd D:\code\game_one
# Push the OUTER only AFTER the inner is on GitHub, so its gitlink SHA is resolvable upstream.
git push origin main --force-with-lease            # (or master — your outer mainline)
git push origin --tags
```

### 3b. GitHub has unique commits (true divergence) — reconcile first

```powershell
cd D:\code\game_one\rynx
git fetch origin
git rebase origin/master                            # replay your local-only commits on top of theirs
# resolve any conflicts, `git rebase --continue` until done; verify the tree builds locally
git push origin master                              # now a normal fast-forward, no force needed
```

Then the outer repo the same way. If the rebase is gnarly, stop and get a human who knows both
intents — do not force-overwrite someone else's pushed work.

## 4. Verify GitHub is now the source of truth

```powershell
git ls-remote origin master                         # SHA matches your local 66d53713 (rynx)
# Fresh-clone smoke test in a scratch dir — proves a clean machine (= the daemon) can reproduce:
cd $env:TEMP
git clone --recurse-submodules <git@github.com:org/rynx.git> rynx-verify
cd rynx-verify ; git submodule status                # all submodules present at expected SHAs
```

## 5. Give the daemon push credentials (as the `integrator-daemon` agent, NOT a human)

The daemon process needs to push to GitHub non-interactively. Pick ONE:

- **Deploy key (recommended, per-repo, narrow):** generate an SSH key on the host
  (`ssh-keygen -t ed25519 -C "integrator-daemon"`), add the **public** key as a *Deploy key with
  write access* on each repo (rynx + game_one) in GitHub → Settings → Deploy keys. Use the SSH
  remote URL form (`git@github.com:org/repo.git`) as the daemon's clone source. Keep the private
  key readable only by the daemon's service account.
- **Fine-grained PAT:** a Personal Access Token scoped to just these two repos with
  Contents:read/write, stored in the host's credential manager (or `GIT_ASKPASS`), HTTPS remote URL.

> The daemon authenticates to **PM** with `PM_API_TOKEN` (the `integrator-daemon` token you already
> created) and to **GitHub** with this deploy key / PAT. They are two different credentials for two
> different systems. Neither belongs in any git repo — host env / credential store only.

## 6. Hand these values to PM config (the Integrator settings page, once it ships)

| PM field | Value |
|---|---|
| `gitRepoUrl` (outer) | the outer game_one GitHub URL (SSH if deploy key) |
| `linked_repos[inner].path` | the rynx GitHub URL |
| `linked_repos[outer].path` | the outer game_one GitHub URL |
| `git_remote` | `origin` |
| `git_main_branch` (per repo) | `master` for rynx; your outer's mainline for game_one |

(Until the UI lands, these go in via REST — but you won't have to: the campaign delivers the page.)

## 7. After the daemon is verified end-to-end

Rotate the `integrator-daemon` **PM** token (Settings → Users → rotate) since its current value
passed through a chat transcript, and update the host env with the fresh value. The GitHub
deploy-key/PAT never left the host, so it doesn't need rotation unless exposed.

---

### Rollback

Everything destructive here is the force-push in §3a. If it goes wrong, the local tips are tagged
(`backup/pre-github-reconcile-*`) and the remote's prior SHA is recoverable from GitHub's ref log /
your `--force-with-lease` having refused if it moved. Reset and retry:
`git reset --hard backup/pre-github-reconcile-rynx`.
