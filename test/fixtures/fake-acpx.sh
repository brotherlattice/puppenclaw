#!/usr/bin/env bash

set -euo pipefail

json_escape() {
  local value="${1-}"
  value=${value//\\/\\\\}
  value=${value//\"/\\\"}
  value=${value//$'\n'/\\n}
  value=${value//$'\r'/\\r}
  value=${value//$'\t'/\\t}
  printf '%s' "$value"
}

emit_json() {
  printf '%s\n' "$1"
}

trim_whitespace() {
  printf '%s' "$1" | sed -E 's/[[:space:]]+/ /g; s/^ //; s/ $//'
}

split_text() {
  local text="$1"
  local size="${2:-14}"
  while [[ -n "$text" ]]; do
    printf '%s\n' "${text:0:size}"
    text="${text:size}"
  done
}

cwd="$(pwd)"
agent=""
args=("$@")
index=0

while [[ $index -lt ${#args[@]} ]]; do
  current="${args[$index]}"
  case "$current" in
    --cwd)
      index=$((index + 1))
      cwd="${args[$index]:-$(pwd)}"
      index=$((index + 1))
      ;;
    --format)
      index=$((index + 2))
      ;;
    --json-strict|--approve-reads|--approve-all|--deny-all)
      index=$((index + 1))
      ;;
    --non-interactive-permissions)
      index=$((index + 2))
      ;;
    --agent)
      index=$((index + 1))
      agent="${args[$index]:-}"
      index=$((index + 1))
      ;;
    --*)
      break
      ;;
    *)
      if [[ -z "$agent" ]]; then
        agent="$current"
        index=$((index + 1))
      fi
      break
      ;;
  esac
done

if [[ -z "$agent" ]]; then
  agent="unknown"
fi

command=("${args[@]:$index}")
state_dir="$cwd/.fake-acpx-state"
mkdir -p "$state_dir"

session_file() {
  printf '%s/%s.session' "$state_dir" "$1"
}

session_exists() {
  [[ -f "$(session_file "$1")" ]]
}

read_session_status() {
  sed -n '1p' "$(session_file "$1")"
}

read_session_agent() {
  sed -n '2p' "$(session_file "$1")"
}

write_session() {
  local name="$1"
  local status="$2"
  local session_agent="$3"
  printf '%s\n%s\n' "$status" "$session_agent" > "$(session_file "$name")"
}

emit_error() {
  local code="$1"
  local message="$2"
  emit_json "{\"type\":\"error\",\"code\":\"$(json_escape "$code")\",\"message\":\"$(json_escape "$message")\"}"
}

if [[ "${command[0]:-}" == "status" && "${command[1]:-}" == "--session" && -n "${command[2]:-}" ]]; then
  name="${command[2]}"
  if ! session_exists "$name"; then
    emit_json '{"action":"status_snapshot","status":"no-session","summary":"no active session"}'
    exit 0
  fi
  status="$(read_session_status "$name")"
  emit_json "{\"status\":\"$(json_escape "${status:-alive}")\",\"acpxRecordId\":\"rec-$(json_escape "$name")\",\"acpxSessionId\":\"backend-$(json_escape "$name")\",\"agentSessionId\":\"agent-$(json_escape "$name")\",\"agent\":\"$(json_escape "${agent:-$(read_session_agent "$name")}")\"}"
  exit 0
fi

if [[ "${command[0]:-}" == "sessions" && "${command[1]:-}" == "new" ]]; then
  name="session-$(date +%s)"
  if [[ "${#command[@]}" -ge 4 ]]; then
    for (( command_index=0; command_index<${#command[@]}; command_index++ )); do
      if [[ "${command[$command_index]}" == "--name" && -n "${command[$((command_index + 1))]:-}" ]]; then
        name="${command[$((command_index + 1))]}"
        break
      fi
    done
  fi
  write_session "$name" "alive" "$agent"
  emit_json "{\"acpxRecordId\":\"rec-$(json_escape "$name")\",\"acpxSessionId\":\"backend-$(json_escape "$name")\",\"agentSessionId\":\"agent-$(json_escape "$name")\",\"status\":\"alive\"}"
  exit 0
fi

if [[ "${command[0]:-}" == "sessions" && "${command[1]:-}" == "close" && -n "${command[2]:-}" ]]; then
  rm -f "$(session_file "${command[2]}")"
  emit_json '{"status":"closed"}'
  exit 0
fi

if [[ "${command[0]:-}" == "cancel" && "${command[1]:-}" == "--session" && -n "${command[2]:-}" ]]; then
  name="${command[2]}"
  if session_exists "$name"; then
    write_session "$name" "alive" "$(read_session_agent "$name")"
  fi
  emit_json '{"status":"cancelled"}'
  exit 0
fi

if [[ "${command[0]:-}" == "prompt" && "${command[1]:-}" == "--session" && -n "${command[2]:-}" ]]; then
  name="${command[2]}"
  input="$(cat)"
  normalized_input="$(trim_whitespace "$input")"
  if ! session_exists "$name"; then
    emit_json "{\"jsonrpc\":\"2.0\",\"id\":null,\"error\":{\"code\":-32002,\"message\":\"No acpx session found\",\"data\":{\"acpxCode\":\"NO_SESSION\",\"origin\":\"cli\",\"sessionId\":\"unknown\"}}}"
    exit 4
  fi
  emit_json "{\"type\":\"usage_update\",\"used\":${#normalized_input},\"size\":4096}"
  if [[ "$normalized_input" == *"FAIL_TURN"* ]]; then
    emit_error "SIM_FAIL" "Simulated turn failure"
    exit 0
  fi
  if [[ "$normalized_input" == *"PUPPENFUSION_ROLE: planning"* ]]; then
    if [[ "$normalized_input" == *"PUPPENFUSION_CANDIDATE: codex"* ]]; then
      reply=$'## Scope\nImplement the requested feature with minimal risk.\n## Architecture\nPrefer a direct module change.\n## Files\n- src.ts\n- codex-plan.txt\n## Validation\n- Run the configured evaluation command.\n## Risks\n- Keep scope bounded to the sealed bundle.'
    else
      reply=$'## Scope\nImplement the requested feature cleanly from the sealed bundle.\n## Architecture\nFavor explicit structure and readable changes.\n## Files\n- src.ts\n- claude-plan.txt\n## Validation\n- Run the configured evaluation command.\n## Risks\n- Avoid widening scope beyond the approved plan.'
    fi
  elif [[ "$normalized_input" == *"PUPPENFUSION_ROLE: implementation"* ]]; then
    if [[ "$normalized_input" == *"PUPPENFUSION_CANDIDATE: codex"* ]]; then
      printf '%s\n' 'codex candidate output' > "$cwd/codex-candidate.txt"
      reply=$'## Summary\nImplemented the Codex candidate.\n## Changed Areas\n- Added codex-candidate.txt\n## Decisions\n- Keep the change isolated to Codex-owned output.\n## Risks\n- Minimal.\n## Validation\n- Ready for evaluation.'
    else
      printf '%s\n' 'claude candidate output' > "$cwd/claude-candidate.txt"
      reply=$'## Summary\nImplemented the Claude candidate.\n## Changed Areas\n- Added claude-candidate.txt\n## Decisions\n- Keep the change isolated to Claude-owned output.\n## Risks\n- Minimal.\n## Validation\n- Ready for evaluation.'
    fi
  elif [[ "$normalized_input" == *"PUPPENFUSION_ROLE: peer_review"* ]]; then
    if [[ "$normalized_input" == *"PUPPENFUSION_CANDIDATE: codex"* ]]; then
      reply=$'## Verdict\nAccept with small follow-up.\n## Strengths\n- The Claude candidate is readable.\n## Weaknesses\n- The change could expose more rationale.\n## Risks\n- Low.\n## Merge Guidance\n- Keep the file-level change and preserve the bounded scope.'
    else
      reply=$'## Verdict\nAccept with small follow-up.\n## Strengths\n- The Codex candidate is direct.\n## Weaknesses\n- The change could expose more rationale.\n## Risks\n- Low.\n## Merge Guidance\n- Keep the file-level change and preserve the bounded scope.'
    fi
  elif [[ "$normalized_input" == *"PUPPENFUSION_ROLE: merge"* ]]; then
    printf '%s\n' 'resolved merged output' > "$cwd/merged-candidate.txt"
    reply=$'## Summary\nResolved the fusion merge in the merged worktree.\n## Incorporated from Codex\n- Preserved the direct candidate change.\n## Incorporated from Claude\n- Preserved the readable candidate change.\n## Remaining Risks\n- Low.\n## Validation\n- Ready for evaluation.'
  elif [[ "$normalized_input" == *"ASK_USER"* ]]; then
    reply="Need input from the user?"
  else
    reply="Handled: $normalized_input"
  fi
  while IFS= read -r chunk; do
    emit_json "{\"type\":\"agent_message_chunk\",\"content\":{\"type\":\"text\",\"text\":\"$(json_escape "$chunk")\"}}"
  done < <(split_text "$reply" 14)
  emit_json '{"type":"done"}'
  exit 0
fi

emit_error "UNSUPPORTED" "Unsupported fake-acpx invocation: ${command[*]}"
