#!/usr/bin/env bash
set -euo pipefail

harbor_base_url="${INPUT_HARBOR_BASE_URL:-https://harbor.mt-ss.cdcr.ca.gov}"
harbor_project="${INPUT_HARBOR_PROJECT:-workloads}"
harbor_repository="${INPUT_HARBOR_REPOSITORY:-}"
commit_sha="${INPUT_COMMIT_SHA:-}"
harbor_tag="${INPUT_HARBOR_TAG:-}"
registry_token="${INPUT_REGISTRY_TOKEN:-}"
ignore_tag_pattern="${INPUT_IGNORE_TAG_PATTERN:-^latest$}"
alias_tag_pattern="${INPUT_ALIAS_TAG_PATTERN:-^(rc\\.|r\\.|buildall\\.)}"

write_empty_outputs() {
  {
    echo "found_match=false"
    echo "selected_tag="
    echo "version_number="
    echo "build_sha="
    echo "image_ref="
    echo "artifact_digest="
    echo "artifact_push_time="
  } >> "$GITHUB_OUTPUT"
}

if [[ -z "${harbor_repository}" ]]; then
  echo "INPUT_HARBOR_REPOSITORY is required." >&2
  exit 1
fi

if [[ -z "${commit_sha}" && -z "${harbor_tag}" ]]; then
  echo "One of commit_sha or harbor_tag must be provided." >&2
  exit 1
fi

if [[ -n "${commit_sha}" ]]; then
  match_mode="commit_sha"
else
  match_mode="harbor_tag"
fi

echo "matched_by=${match_mode}" >> "$GITHUB_OUTPUT"
echo "lookup_failed=false" >> "$GITHUB_OUTPUT"

auth_args=()
if [[ -n "${registry_token}" ]]; then
  auth_args+=("-H" "Authorization: Bearer ${registry_token}")
fi

project_uri=$(jq -rn --arg v "${harbor_project}" '$v|@uri')
repo_uri=$(jq -rn --arg v "${harbor_repository}" '$v|@uri')

call_harbor_api() {
  local url="$1"
  local response_file="$2"
  local http_code

  http_code=$(curl -sS -k -o "${response_file}" -w "%{http_code}" "${url}")
  if [[ "${http_code}" == "200" ]]; then
    echo "${http_code}"
    return 0
  fi

  if [[ ${#auth_args[@]} -gt 0 ]]; then
    http_code=$(curl -sS -k -o "${response_file}" -w "%{http_code}" "${auth_args[@]}" "${url}")
    if [[ "${http_code}" == "200" ]]; then
      echo "${http_code}"
      return 0
    fi

    if [[ "${registry_token}" == *:* ]]; then
      local basic_auth
      basic_auth=$(printf "%s" "${registry_token}" | base64 -w 0)
      http_code=$(curl -sS -k -o "${response_file}" -w "%{http_code}" -H "Authorization: Basic ${basic_auth}" "${url}")
      if [[ "${http_code}" == "200" ]]; then
        echo "${http_code}"
        return 0
      fi
    fi
  fi

  echo "${http_code}"
  return 1
}

page=1
page_size=100
all_artifacts='[]'
lookup_failed='false'

while true; do
  url="${harbor_base_url}/api/v2.0/projects/${project_uri}/repositories/${repo_uri}/artifacts?page=${page}&page_size=${page_size}&with_tag=true"
  echo "url:  ${url}"
  nslookup harbor.mt-ss.cdcr.ca.gov 2>/dev/null || true
  echo "***** after nslookup"
  response_file=$(mktemp)

  if ! http_code=$(call_harbor_api "${url}" "${response_file}"); then
    echo "***** lookup failed"
    lookup_failed='true'
    echo "Harbor lookup failed on page ${page} with HTTP ${http_code}."
    rm -f "${response_file}"
    break
  fi
  echo "***** lookup succeeded"

  page_artifacts=$(cat "${response_file}")
  rm -f "${response_file}"

  page_count=$(jq 'length' <<< "${page_artifacts}")
  if [[ "${page_count}" -eq 0 ]]; then
    break
  fi

  all_artifacts=$(jq -c --argjson newPage "${page_artifacts}" '. + $newPage' <<< "${all_artifacts}")

  if [[ "${page_count}" -lt "${page_size}" ]]; then
    break
  fi

  page=$((page + 1))
done

if [[ "${lookup_failed}" == "true" ]]; then
  echo "lookup_failed=true" >> "$GITHUB_OUTPUT"
  write_empty_outputs
  exit 0
fi

if [[ "${match_mode}" == "commit_sha" ]]; then
  matching_artifacts=$(jq -c --arg commit "${commit_sha}" '
    map(select((.extra_attrs.config.Labels.GitInfo.commitId // "") == $commit))
  ' <<< "${all_artifacts}")
else
  matching_artifacts=$(jq -c --arg tag "${harbor_tag}" '
    map(select(any((.tags // [])[]?; (.name // "") == $tag)))
  ' <<< "${all_artifacts}")
fi

match_count=$(jq 'length' <<< "${matching_artifacts}")
echo "Matched ${match_count} artifact(s) by ${match_mode}."

if [[ "${match_count}" -eq 0 ]]; then
  write_empty_outputs
  exit 0
fi

selected_artifact=$(jq -c '
  sort_by(.push_time // .tags[0].push_time // "")
  | reverse
  | .[0]
' <<< "${matching_artifacts}")

selected_tag=$(jq -r \
  --arg ignore "${ignore_tag_pattern}" \
  --arg alias "${alias_tag_pattern}" '
  def newest_non_ignored_tag($ignore):
    (
      (.tags // [])
      | map(select(((.name // "") | test($ignore; "i")) | not))
      | sort_by(.push_time // "")
      | reverse
      | .[0].name // ""
    );
  def newest_preferred_tag($ignore; $alias):
    (
      (.tags // [])
      | map(select(((.name // "") | test($ignore; "i")) | not))
      | map(select(((.name // "") | test($alias; "i")) | not))
      | sort_by(.push_time // "")
      | reverse
      | .[0].name // ""
    );
  newest_preferred_tag($ignore; $alias) as $preferred
  | if $preferred != "" then $preferred else newest_non_ignored_tag($ignore) end
' <<< "${selected_artifact}")

if [[ -z "${selected_tag}" ]]; then
  write_empty_outputs
  exit 0
fi

build_sha=$(jq -r '.extra_attrs.config.Labels.GitInfo.commitId // ""' <<< "${selected_artifact}")
artifact_digest=$(jq -r '.digest // ""' <<< "${selected_artifact}")
artifact_push_time=$(jq -r '.push_time // ""' <<< "${selected_artifact}")
image_ref="${harbor_base_url#https://}/${harbor_project}/${harbor_repository}:${selected_tag}"

{
  echo "found_match=true"
  echo "selected_tag=${selected_tag}"
  echo "version_number=${selected_tag}"
  echo "build_sha=${build_sha}"
  echo "image_ref=${image_ref}"
  echo "artifact_digest=${artifact_digest}"
  echo "artifact_push_time=${artifact_push_time}"
} >> "$GITHUB_OUTPUT"
