#!/usr/bin/env bash
# List recent GitHub Actions artifacts, download one and extract its archives.
set -euo pipefail

REPO="${OPALNOTE_REPO:-liyu1981/opal_note}"
OUT_DIR="artifacts"
LIMIT=20
SELECT=""
LATEST=0

usage() {
  cat <<'EOF'
Usage: scripts/download_github_artifact.sh [options]

Lists the most recent GitHub Actions artifacts (newest first), downloads the
selected one with `gh run download`, then extracts any nested .tar.gz, .tgz,
.tar.bz2, .tar.xz, .tar, .zip or .gz files in place.

Options:
  -n, --index N    Select the Nth artifact from the newest-first list.
  -y, --latest     Select the newest artifact without prompting.
      --repo REPO  GitHub repository (default: OPALNOTE_REPO or
                   liyu1981/opal_note).
      --limit N    How many artifacts to list (default: 20, max: 100).
  -o, --out DIR    Output directory, relative to the current working
                   directory (default: ./artifacts).
  -h, --help       Show this help.

Environment:
  OPALNOTE_REPO    Default repository override.
EOF
}

die() {
  printf '✖ %s\n' "$*" >&2
  exit 1
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    -n|--index)
      [[ $# -ge 2 ]] || die "$1 needs a value"
      SELECT="$2"
      shift 2
      ;;
    -y|--latest)
      LATEST=1
      shift
      ;;
    --repo)
      [[ $# -ge 2 ]] || die "--repo needs a value"
      REPO="$2"
      shift 2
      ;;
    --limit)
      [[ $# -ge 2 ]] || die "--limit needs a value"
      LIMIT="$2"
      shift 2
      ;;
    -o|--out)
      [[ $# -ge 2 ]] || die "$1 needs a value"
      OUT_DIR="$2"
      shift 2
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      die "unknown option: $1 (try --help)"
      ;;
  esac
done

[[ "$LIMIT" =~ ^[0-9]+$ ]] && (( LIMIT >= 1 && LIMIT <= 100 )) \
  || die "--limit must be a number between 1 and 100"
[[ -z "$SELECT" || "$SELECT" =~ ^[0-9]+$ ]] \
  || die "--index must be a number"
[[ -n "$REPO" ]] || die "repository must not be empty"
[[ -n "$OUT_DIR" ]] || die "output directory must not be empty"

command -v gh >/dev/null 2>&1 \
  || die "GitHub CLI (gh) is required: https://cli.github.com"
gh auth status >/dev/null 2>&1 \
  || die "gh is not authenticated; run: gh auth login"

case "$OUT_DIR" in
  /*) out_display="$OUT_DIR" ;;
  *) out_display="$(pwd)/${OUT_DIR#./}" ;;
esac

printf '\n▸ Fetching recent artifacts from %s\n' "$REPO"
printf '  Output goes to %s\n' "$out_display"

rows="$(
  gh api "repos/${REPO}/actions/artifacts?per_page=100" --jq '
    [.artifacts[]
      | select(.expired | not)
      | select(.workflow_run.id != null)]
    | sort_by(.created_at) | reverse
    | .[:'"$LIMIT"']
    | .[]
    | [
        .id,
        .name,
        (.size_in_bytes | tostring),
        .created_at,
        (.workflow_run.id | tostring),
        (.workflow_run.head_branch // "-"),
        ((.workflow_run.head_sha // "")[0:6])
      ]
    | @tsv
  '
)" || die "could not list artifacts for ${REPO}"

[[ -n "$rows" ]] || die "no unexpired artifacts found; run the workflow first: gh workflow run dev-build.yml --repo ${REPO}"

names=()
run_ids=()
sizes=()
created=()
branches=()

count=0
while IFS=$'\t' read -r _id name bytes created_at run_id branch _sha; do
  [[ -n "$name" ]] || continue
  count=$((count + 1))
  names[$count]="$name"
  run_ids[$count]="$run_id"
  sizes[$count]="$bytes"
  created[$count]="$created_at"
  branches[$count]="$branch"
done <<< "$rows"

epoch_of() {
  date -u -d "$1" +%s 2>/dev/null \
    || date -j -u -f "%Y-%m-%dT%H:%M:%SZ" "$1" +%s 2>/dev/null \
    || printf '0'
}

human_age() {
  local stamp diff
  stamp="$(epoch_of "$1")"
  diff=$(( $(date +%s) - stamp ))
  (( diff < 0 )) && diff=0
  if (( diff < 60 )); then
    printf '%ds ago' "$diff"
  elif (( diff < 3600 )); then
    printf '%dm ago' "$((diff / 60))"
  elif (( diff < 86400 )); then
    printf '%dh ago' "$((diff / 3600))"
  else
    printf '%dd ago' "$((diff / 86400))"
  fi
}

human_size() {
  awk -v bytes="$1" 'BEGIN {
    split("B KiB MiB GiB", units, " ");
    i = 1;
    while (bytes >= 1024 && i < 4) {
      bytes /= 1024;
      i++;
    }
    if (i == 1) printf "%d %s", bytes, units[i];
    else printf "%.1f %s", bytes, units[i];
  }'
}

printf '\n  %-3s  %-10s  %-44s  %-10s  %s\n' \
  "#" "CREATED" "ARTIFACT" "BRANCH" "SIZE"
for ((i = 1; i <= count; i++)); do
  printf '  %-3d  %-10s  %-44s  %-10s  %s\n' \
    "$i" "$(human_age "${created[$i]}")" "${names[$i]}" \
    "${branches[$i]}" "$(human_size "${sizes[$i]}")"
done
printf '\n'

if [[ -n "$SELECT" ]]; then
  choice="$SELECT"
elif (( LATEST )); then
  choice=1
else
  [[ -t 0 ]] || die "stdin is not a TTY; rerun with --latest or --index N"
  read -r -p "Select artifact [1-${count}] (default 1): " choice || exit 0
  choice="${choice:-1}"
fi

[[ "$choice" =~ ^[0-9]+$ ]] && (( choice >= 1 && choice <= count )) \
  || die "invalid selection: ${choice} (choose 1-${count})"

artifact="${names[$choice]}"
run_id="${run_ids[$choice]}"
safe_name="$(printf '%s' "$artifact" | tr '/\\:*?"<>| ' '___________')"
dest="${OUT_DIR%/}/${safe_name}"

if [[ -e "$dest" ]]; then
  printf '▸ Replacing existing %s\n' "$dest"
  rm -rf -- "$dest"
fi
mkdir -p -- "$dest"

printf '▸ Downloading %s (run %s)\n' "$artifact" "$run_id"
gh run download "$run_id" --repo "$REPO" --name "$artifact" --dir "$dest" \
  || die "download failed; the artifact may have expired"

printf '▸ Extracting archives in %s\n' "$dest"
extracted=0
for file in "$dest"/*; do
  [[ -f "$file" ]] || continue
  case "$file" in
    *.tar.gz|*.tgz)
      tar -xzf "$file" -C "$dest"
      extracted=$((extracted + 1))
      ;;
    *.tar.bz2|*.tbz2)
      tar -xjf "$file" -C "$dest"
      extracted=$((extracted + 1))
      ;;
    *.tar.xz|*.txz)
      tar -xJf "$file" -C "$dest"
      extracted=$((extracted + 1))
      ;;
    *.tar)
      tar -xf "$file" -C "$dest"
      extracted=$((extracted + 1))
      ;;
    *.zip)
      if command -v unzip >/dev/null 2>&1; then
        unzip -oq "$file" -d "$dest"
      else
        tar -xf "$file" -C "$dest" \
          || die "cannot extract ${file##*/}; install unzip"
      fi
      extracted=$((extracted + 1))
      ;;
    *.gz)
      gzip -dkf "$file"
      extracted=$((extracted + 1))
      ;;
  esac
done

if (( extracted == 0 )); then
  printf '  no nested archives found\n'
fi

printf '\n✔ Downloaded to %s\n' "$dest"
find "$dest" -maxdepth 1 -type f -printf '  %f\n' 2>/dev/null \
  || ls -1 "$dest"
