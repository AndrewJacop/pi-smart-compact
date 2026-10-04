# 03 — self-hosted Clef serving
Type: research
Status: resolved
Blocked by:

## Question
Can pi-smart-compact realistically promise a self-hosted backend? Clef weights are Apache-2.0 on Hugging Face (Cloudflare tested on a single H200; transformers + PyTorch). Find: what serving stacks exist (official? vLLM/ollama ports? community), whether any exposes the Jev-shape API (state + questions -> answers) or whether an adapter must wrap a generic endpoint, hardware requirements for clef 27B / clef-flash 9B, and a feasibility verdict for a personal dev box.
Sources: huggingface.co (search "cloudflare clef"), blog.cloudflare.com/clef-decision-models, flaviocopes.com/clef.

## Answer

### The models (huggingface.co, blog.cloudflare.com/clef-decision-models)

Both weights are Apache-2.0 on HF, post-trained from frozen Qwen backbones with rank-256 LoRA + a small "joint schema head" that scores every allowed option of every question in one non-autoregressive pass (softmax per question; no text generation, output_tokens is always 0):

- **Cloudflare/clef** — 27B (27.36B BF16 params), base Qwen3.8-27B + vision encoder. ~55 GB of safetensors (12 shards + separate `joint_head.safetensors`). Cloudflare tested on a **single H200** with torch 2.11 / transformers 5.10.2. Median 209 ms hosted.
- **Cloudflare/clef-flash** — 9B, base Qwen3.5-9B (32 layers, hidden 4096). ~18 GB BF16. Median 39 ms hosted.

Safetensors are standard; the schema head is **custom code** (`joint_schema_model.py`, HF tag `custom-code`) — generic serving stacks do not know what to do with it out of the box.

### Serving stacks

| Stack | Status | Notes |
| --- | --- | --- |
| **transformers + PyTorch** (official) | Works today | Repo ships `load_release_model` + a `systemone()` function that takes/returns the exact Jev `POST /v1/systemone` body. It's a Python function, not an HTTP server — wrapping it in a ~20-line FastAPI route is trivial. Needs BF16-capable VRAM (H200-tested; 80 GB-class for 27B, 24 GB for 9B). Only path that supports images/video. |
| **Ollama** | **Works today, native Jev API** | PR #18741 merged Oct 1; `ollama pull clef` (18 GB) and `clef-flash` (11 GB) serve the **native decision head on `/v1/systemone`**. Gotchas: page says 0.35.1 but the PR landed after that tag (use latest build); Ollama lists 256K context vs 64K documented. Quantized (accuracy not verified by Cloudflare). |
| **llama.cpp** | Pending | ggml-org published `Clef-GGUF` / `Clef-Flash-GGUF` (BF16, Q8_0, Q4_K_M) Oct 2, gated on open PR #29831 — text-only, one sequence per batch, unreviewed. The base `/v1/systemone` endpoint has merged; model support hasn't. Running a generic GGUF in an older Ollama gives constrained-JSON output, **not** the decision head. |
| **vLLM** | Not available | Nothing serves the schema head. vLLM would load only the Qwen backbone (text generation, no probabilities). The vLLM PR the blog credits is for DiffusionGemma/Jev, not Clef. Not a viable path without reimplementing the head. |
| **MLX (Apple Silicon)** | Community | `aufklarer/Clef-flash-9B-MLX-4bit`, text-only, ~6 GB unified memory. |

HF lists ~33 quantizations across the two sizes total; all are days old and none are accuracy-benchmarked by Cloudflare.

### Jev-shape API (state + questions → probability answers): per-stack verdict

- **Workers AI hosted**: yes, natively (REST wraps it in Cloudflare's `result` envelope; Worker binding returns it bare).
- **Ollama self-hosted**: **yes, out of the box** — `/v1/systemone`, native head. The only one-command self-hosted option.
- **llama.cpp GGUF**: yes by design (`/v1/systemone` merged), but not usable until PR #29831 lands; text-only.
- **transformers**: yes, but only as an in-process Python function (`systemone()` in the repo) — needs a thin HTTP adapter you write (~20 lines).
- **vLLM / generic completion endpoints**: **no.** A generic completion endpoint cannot reproduce the head's per-option logits; wrapping it would mean approximating via prompt + parsing, which defeats the model's point (deterministic bounded outputs, no parsing). Don't do this.

### Hardware requirements

| Model | Precision | Weights | Fits |
| --- | --- | --- | --- |
| clef 27B | BF16 | ~55 GB | H100/H200/8×A100 class (Cloudflare's H200 test rig) |
| clef 27B | Q4_K_M GGUF | ~17-18 GB | One 24 GB consumer GPU (RTX 3090/4090) — accuracy unverified |
| clef-flash 9B | BF16 | ~18 GB | 24 GB GPU, or 32 GB+ Apple Silicon |
| clef-flash 9B | Q8_0 GGUF | ~10-11 GB | 12-16 GB GPU |
| clef-flash 9B | Q4_K_M GGUF | ~6 GB | 8 GB VRAM, or Apple Silicon (MLX 4-bit, text-only) |

Because inference is prefill-only + one head pass (no autoregressive decoding), throughput per decision is one forward pass — latency on a 9B local model should land in the tens-of-ms GPU / low-seconds CPU range, fine for a dev box.

### Feasibility verdict for a personal dev box

Yes — realistic for **clef-flash**, borderline for full **clef**. Recommended position for the spec: treat self-hosting as a supported but second-class path. `ollama pull clef-flash` + `POST localhost:11434/v1/systemone` is a genuine, one-command Jev-shape backend on any 12 GB+ GPU (Q4_K_M works from ~8 GB) or a 32 GB Apple Silicon box via MLX; the official transformers route plus a ~20-line FastAPI wrapper is the fallback where images are needed. Full clef 27B needs 24 GB VRAM at Q4 (unverified accuracy) or 80 GB at BF16 — not a personal-box target; size-dependent fallback to it isn't worth promising. Caveats to state in the spec: the entire quantized/self-host ecosystem is days old, llama.cpp support is still an unmerged PR, quantized accuracy has zero published benchmarks, and multimodal input only works on the transformers path. For a personal dev box the Workers AI free tier (10k Neurons/day ≈ ~1.2M clef-flash input tokens/day) may already cover the volume, so self-hosting should be an optional deployment mode, not a guarantee.

### Update — internal gateway now serves Clef

pi-smart-compact no longer needs to self-host anything: our **optollm gateway** exposes `clef` natively at `https://optollm.optomatica.com/v1/systemone` (Jev-shape, LiteLLM key auth; verified reachable 2026-10). Usable via the TypeSafe SDK (`TYPESAFE_BASE_URL=https://optollm.optomatica.com`, `TYPESAFE_DEFAULT_MODEL=clef`) or raw POST. Caveats: dedicated decision API only (never the chat endpoint), image input unverified through the gateway, probabilities are estimates. This supersedes the self-hosting path above for practical use; keep the Ollama/`clef-flash` route in the spec only as an offline fallback.

Sources: huggingface.co/Cloudflare/clef · huggingface.co/Cloudflare/clef-flash · huggingface.co/ggml-org/Clef-Flash-GGUF · huggingface.co/aufklarer/Clef-flash-9B-MLX-4bit · ollama.com/library/clef · blog.cloudflare.com/clef-decision-models · modelsystem.one/news/clef-ollama-llamacpp-independent-evals · flaviocopes.com/clef
