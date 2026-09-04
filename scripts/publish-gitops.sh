#!/usr/bin/env bash
# Commits back what a run produced that genuinely belongs in the customer's
# repository, and removes what no longer does.
#
# Lives here, and not in the workflow, because the workflow is ONE file shared by
# every channel and every customer -- anything encoded there can only change for
# everyone at once, while this script is checked out per channel. What gets
# committed, and under which name, changed twice in a single day; keeping it here
# means the next change lands in the channel being developed and never touches
# what production runs.
#
# Expects in the environment: GITHUB_WORKSPACE, GITHUB_REF_NAME.
# Matches what `shell: bash` gives a workflow step by default
# (bash -eo pipefail), so moving this body out of the workflow did not
# quietly change how it reacts to a failing command. Same line as pipeline.sh.
set -eo pipefail

# Configura o bot do Github
git config --global user.name "github-actions[bot]"
git config --global user.email "github-actions[bot]@users.noreply.github.com"

# Pushing from here RACES. States in one repository run in parallel --
# see the note about `concurrency` at the top of this file -- so two runs
# can reach this step at the same time. A bare `git push` loses that race
# with a non-fast-forward rejection, and under `set -e` that kills the
# whole run AFTER the terraform work already succeeded.
#
# Rebase rather than merge: each run adds one commit touching only its own
# state folder, so replaying it on top of whatever landed first is exactly
# right and leaves no merge commits in the client's history.
#
# A conflict here would mean two runs writing the SAME file, which the
# per-state layout should make impossible. If it happens the rebase is
# aborted and the step fails loudly instead of guessing.
push_with_retry() {
    local label="$1" attempt=1 max=5
    local branch="${GITHUB_REF_NAME:-main}"

    until git push; do
        if [ "$attempt" -ge "$max" ]; then
            echo "❌ ${label}: still rejected after ${max} attempts."
            return 1
        fi

        echo "🔁 ${label}: another run reached the branch first. Rebasing (${attempt}/${max})..."

        # The client checkout is shallow (fetch-depth: 2), so the rebase
        # base may simply not be present. Deepen first; on a complete
        # clone --deepen errors, hence the fallback.
        git fetch --deepen=20 origin "$branch" 2>/dev/null || git fetch origin "$branch"

        if ! git rebase "origin/$branch"; then
            git rebase --abort || true
            echo "❌ ${label}: conflict while rebasing onto origin/$branch."
            return 1
        fi

        attempt=$((attempt + 1))
        sleep $((attempt * 3))
    done
}

# 1. LÓGICA DO PASSO 2 (GERAÇÃO DE IMPORT)
if [ -f "$GITHUB_WORKSPACE/.needs_commit" ]; then
  echo "📥 Import operation detected. Saving the generated resources to the repository..."
  # QUOTED, for the reason spelled out in the `git rm` block below: unquoted,
  # bash expands `./**/x` itself, and without globstar it treats `**` as a
  # single `*`. While nothing matches one level down the pattern reaches git
  # untouched and git's own matching crosses `/`, so this worked by accident.
  # The moment something DOES match at depth 1, bash hands git that one path and
  # the deeper ones are dropped in silence -- which is exactly the account-import
  # layout, `<account>/_import/<node>/`, three levels down. Measured, not
  # reasoned: with a depth-1 match present, the depth-3 file was not staged.
  git add -- '*generated_resources.json'

  if ! git diff --staged --quiet; then
    git commit -m "chore: generated terraform awaiting CloudMan review [skip ci]"
    push_with_retry "import code"
    echo "✅ Import code pushed to the repository."
  fi
fi

# 1b. RESULTADO DO PLAN / DRIFT (lido pelo diagrama, não pelo Terraform)
#
# The result itself NO LONGER LIVES HERE. It is published as a workflow
# artifact (see the upload step earlier in this job), because it is
# read once, right after the run, and is worthless a few edits later --
# a repository is the wrong home for something with that lifetime. The
# customer's history is theirs; it should not accumulate our scratch.
#
# What remains is removing what earlier engines DID commit here. Left
# behind, those files are a plan frozen at whatever the last run
# produced -- and the reader still knows the old paths, so a stale plan
# would be served wearing the face of a current one. Both names are
# swept: `.json` from before compression, `.gz` from the brief window
# when the compressed file was still committed.
#
# QUOTED, so git does the matching and not bash. Unquoted, `./**/x` is
# expanded by bash, which without globstar treats `**` as a plain `*`
# -- it matches one level down, and because it DID match, the deeper
# paths are dropped silently. Git's own pathspec lets `*` cross `/`.
#
# NOT --cached: that only unstages a file, leaving it on disk as
# untracked. This step runs while states in the same repository can be
# publishing in parallel (see the note on `concurrency` at the top of
# this file), so a losing run's retry rebases -- which checks out the
# winner's commit internally, and git refuses to check out over an
# untracked file that commit would create. A `--cached` removal here
# reliably broke the next run's rebase.
#
# --ignore-unmatch makes all of this a no-op from the second run on,
# and in repositories that never carried either file, so the common
# case stages nothing and never reaches a commit or a push.
git rm --quiet --ignore-unmatch -- '*plan_result.json' '*plan_result.json.gz' || true

if ! git diff --staged --quiet; then
  echo "🧹 Removing plan results committed by an earlier engine..."
  git commit -m "chore: drop committed plan results, now published as artifacts [skip ci]"
  push_with_retry "plan result cleanup"
  echo "✅ Old plan results removed from the repository."
fi

# 1c. THE ACCOUNT SCAN'S INVENTORY
#
# Committed to the repository rather than published as an artifact like
# plan_result: Struct8 fetches this through the same call that already fetches
# generated_resources, and an artifact is not reachable by it. Unlike a plan, it
# also does not go stale on the next edit -- it is the list of what exists in the
# account, and it is the input to the screen where states get separated.
if [ -f "$GITHUB_WORKSPACE/.needs_scan_commit" ]; then
  echo "🔎 Scan finished. Saving the inventory to the repository..."
  git add -- '*scan_inventory.json'

  if ! git diff --staged --quiet; then
    git commit -m "chore: account scan inventory awaiting CloudMan review [skip ci]"
    push_with_retry "scan inventory"
    echo "✅ Scan inventory pushed to the repository."
  fi
fi

# 1d. THE DEPENDENCY LOCK
#
# `.terraform.lock.hcl` beside a state's main.tf: the checksums of the
# provider releases that state used. With it in the repository, a later run
# refuses a package that does not match, and the versions only move when the
# workspace changes them. pipeline.sh appends to .needs_lock_commit the path
# of each lock it recorded (a state's first run, or provider versions changed);
# a run that only reused the committed lock leaves nothing here.
if [ -f "$GITHUB_WORKSPACE/.needs_lock_commit" ]; then
  echo "🔏 Saving the dependency lock of the states that recorded one..."
  while IFS= read -r lock; do
    if [ -f "$lock" ]; then git add -- "$lock"; fi
  done < "$GITHUB_WORKSPACE/.needs_lock_commit"
  if ! git diff --staged --quiet; then
    git commit -m "chore: terraform dependency lock recorded by the engine [skip ci]"
    push_with_retry "dependency lock"
    echo "✅ Dependency lock pushed to the repository."
  fi
fi

# 2. LÓGICA DO PASSO 4 (LIMPEZA PÓS-APPLY)
if [ -f "$GITHUB_WORKSPACE/.needs_cleanup" ]; then
  echo "🧹 Apply finished. Removing the import files from the repository..."

  # O parâmetro -u no git add pega arquivos que foram deletados
  git add -u ./**/import.tf ./**/generated_resources.json ./**/generated_resources.tf 2>/dev/null || true

  if ! git diff --staged --quiet; then
    git commit -m "chore: cleanup import.tf and json after successful apply [skip ci]"
    push_with_retry "post-apply cleanup"
    echo "✅ Leftover files removed from the repository."
  else
    echo "No leftover files to clean up in git."
  fi
fi

echo "✅ Pipeline finalizado."
