# 03 — self-hosted Clef serving
Type: research
Status: open
Blocked by:

## Question
Can pi-smart-compact realistically promise a self-hosted backend? Clef weights are Apache-2.0 on Hugging Face (Cloudflare tested on a single H200; transformers + PyTorch). Find: what serving stacks exist (official? vLLM/ollama ports? community), whether any exposes the Jev-shape API (state + questions -> answers) or whether an adapter must wrap a generic endpoint, hardware requirements for clef 27B / clef-flash 9B, and a feasibility verdict for a personal dev box.
Sources: huggingface.co (search "cloudflare clef"), blog.cloudflare.com/clef-decision-models, flaviocopes.com/clef.
