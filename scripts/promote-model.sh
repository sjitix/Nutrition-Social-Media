#!/usr/bin/env bash
# Promote a freshly-trained LoRA adapter to a running, evaluated model — in one command.
#
#   bash scripts/promote-model.sh v8
#
# Chains the six steps that otherwise get run by hand (and fat-fingered at 1am):
#   archive the adapter -> merge -> convert to GGUF -> install into LM Studio -> load -> eval.
#
# Run it ONLY after training has finished (the GPU must be free for the merge). It refuses to run
# if the training log doesn't show the adapter was saved, unless you pass --force.
set -euo pipefail

VERSION="${1:-v8}"
LOG="train-${VERSION}.log"
ADAPTER="models/nutriflow-lora"
ARCHIVE="models/nutriflow-lora-${VERSION}"
MERGED="models/nutriflow-merged"
GGUF="models/nutriflow-assistant-${VERSION}-q8_0.gguf"
LMS_DIR="$HOME/.lmstudio/models/nutriflow/nutriflow-assistant-${VERSION}"
LMS="$HOME/.lmstudio/bin/lms.exe"
PY=".venv-ft/Scripts/python.exe"
IDENT="nutriflow-${VERSION}"

say() { printf '\n\033[1;35m>>> %s\033[0m\n' "$*"; }

# ---- guards --------------------------------------------------------------
[ -d "$ADAPTER" ] || { echo "No adapter at $ADAPTER — has training run?"; exit 1; }
if [ -f "$LOG" ] && ! grep -q "Saved LoRA adapter" "$LOG"; then
  if [ "${2:-}" != "--force" ]; then
    echo "‼ $LOG does not show 'Saved LoRA adapter' — training may still be running."
    echo "  Wait for it to finish, or re-run with:  bash scripts/promote-model.sh $VERSION --force"
    exit 1
  fi
fi
# The merge needs the GPU. If a model is still loaded in LM Studio, free it first.
"$LMS" unload --all >/dev/null 2>&1 || true

# ---- 1. archive the adapter under its version name -----------------------
say "1/6  Archiving adapter -> $ARCHIVE"
rm -rf "$ARCHIVE"
cp -r "$ADAPTER" "$ARCHIVE"

# ---- 2. merge the adapter into the base model (fp16) ---------------------
say "2/6  Merging adapter into base model"
"$PY" scripts/merge_lora.py

# ---- 3. convert the merged model to GGUF q8_0 ----------------------------
say "3/6  Converting to GGUF (q8_0)"
"$PY" llama.cpp/convert_hf_to_gguf.py "$MERGED" --outfile "$GGUF" --outtype q8_0

# ---- 4. install into LM Studio -------------------------------------------
say "4/6  Installing into LM Studio -> $LMS_DIR"
mkdir -p "$LMS_DIR"
cp "$GGUF" "$LMS_DIR/"

# ---- 5. load it ----------------------------------------------------------
say "5/6  Loading as '$IDENT'"
"$LMS" load "nutriflow-assistant-${VERSION}" --gpu max --context-length 8192 --identifier "$IDENT" -y

# ---- 6. evaluate on the held-out set -------------------------------------
say "6/6  Evaluating (production path, then unconstrained)"
ENFORCE=1 MODEL="$IDENT" npm run eval:assistant
echo
MODEL="$IDENT" npm run eval:assistant

say "Done. If the scores look good, point the site at it:"
echo "  edit .env.local -> LOCAL_AI_MODEL=$IDENT   (must match 'lms ps'), then it's live."
