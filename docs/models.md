# Model Recommendations

Tested with `scripts/model-test.ts` — 4 tasks per model: simple Q&A, single tool use, multi-step tool chain (Obsidian vault), and LSP write-and-fix loop.

## Summary

| Model           | Size | Architecture | Avg Time | Completion Tokens | Reliability |
| --------------- | ---- | ------------ | -------- | ----------------- | ----------- |
| **gemma4:e4b**  | 8GB  | MoE          | **19s**  | 1332              | 4/4 ✅      |
| **qwen3.6:35b** | 22GB | MoE          | **17s**  | 871               | 4/4 ✅      |
| qwen3.6:27b     | 16GB | Dense        | 66s      | 878               | 4/4 ✅      |
| qwen3-agentic   | 8GB  | Dense        | 70s      | 2951              | 4/4 ✅      |

## Recommendations

### Default: `gemma4:e4b`

Best all-rounder for daily use:

- Fast (19s average across all task types)
- Reliable tool calling — chains search → read → analyze without issues
- Compact output — doesn't over-explain
- Self-corrects with LSP feedback
- Low memory footprint (8GB)

### Power: `qwen3.6:35b`

Fastest overall (17s avg) despite being largest:

- MoE architecture — only activates subset of parameters per token
- Most token-efficient (871 total completion tokens across 4 tasks)
- Excellent for complex tasks where quality matters
- Requires 22GB VRAM

### Deep reasoning: `qwen3.6:27b`

Most capable per-parameter but slow:

- Dense architecture — all 27B params active per token
- 3-4x slower than MoE models (66s average)
- Same output quality as 35b for these tasks
- Use when you need maximum reasoning but aren't time-constrained

### Avoid for agentic work: `qwen3-agentic`

Despite the name, not ideal:

- Extremely verbose (2951 completion tokens — 3x more than others)
- Slow (70s average)
- Works correctly but wastes tokens on explanations
- May be better for single-shot generation, not tool loops

## Observations

- **All models reliably chain tools.** The MCP Obsidian search → read pipeline works across all tested models.
- **LSP feedback loop works.** All models detect diagnostics and attempt fixes. `gemma4:e4b` uses a clean pattern: write → check diagnostics → rewrite.
- **MoE models are faster.** Both gemma4:e4b (8GB) and qwen3.6:35b (22GB) use MoE, explaining their speed advantage over dense models.
- **Token efficiency correlates with quality.** Models that produce fewer tokens tend to give more focused, actionable responses.

## Running Tests

```bash
# Test all Ollama models:
tsx scripts/model-test.ts

# Test specific models:
tsx scripts/model-test.ts gemma4:e4b qwen3.6:35b
```

## Hardware

Tested on macOS with Apple Silicon. All models served via Ollama. Times include cold-start (first model load ~5-10s extra, subsequent runs faster).

---

## Hardware Setup Guides

### Apple Silicon Mac (M-series)

Ollama uses unified memory — the same pool serves both CPU and GPU. This means large models fit without a discrete GPU, but memory is shared with the OS and other apps.

#### Recommended: M3 Pro 36GB

| Model                                | Size  | Fits in 36GB? | Notes                      |
| ------------------------------------ | ----- | ------------- | -------------------------- |
| `gemma4:e4b`                         | 9.6GB | ✅ easily     | Best daily driver          |
| `qwen3.6:27b`                        | 17GB  | ✅            | Slow (dense), but fits     |
| `qwen3.6:35b`                        | 23GB  | ✅            | Fast MoE, recommended      |
| `qwen3:32b-q4_K_M`                   | 20GB  | ✅            | Good quality/size tradeoff |
| `qwen3:30b-a3b-instruct-2507-q4_K_M` | 19GB  | ✅            | Fast MoE, 3B active params |

**KV cache is the hidden cost.** At 128k context, a 27B model needs ~10-12GB for KV cache on top of the weights — leaving little headroom on 36GB. At 64k context, `qwen3.6:35b` uses ~28GB total — fits comfortably with headroom to spare.

#### Ollama environment variables

Set in `~/.zshrc` or `~/.bashrc`:

```bash
export OLLAMA_FLASH_ATTENTION=1     # required for Apple Silicon — enables Metal optimizations
export OLLAMA_KV_CACHE_TYPE=q8_0   # halves KV cache vs fp16; use q4_0 if memory-constrained
export OLLAMA_CONTEXT_LENGTH=32000  # default context for models (Anvil overrides per-request)
```

#### Anvil config (`~/.anvil/config.yaml`)

```yaml
default_provider: ollama
default_model: qwen3.6:35b          # fast MoE, best speed+capability on 36GB; gemma4:e4b for lighter tasks
stream_timeout: 120
connect_timeout: 300                # cold model load from disk can take 30-60s
context_size: 65536                 # 64k — qwen3.6:35b at 64k uses ~28GB total, fits in 36GB

providers:
  ollama:
    endpoint: http://localhost:11434  # no /v1 — uses native API with num_ctx support
```

#### Install Ollama

Use the macOS app from [ollama.com/download](https://ollama.com/download), **not Homebrew**. The app handles the launchd service and picks up `OLLAMA_*` env vars from your shell profile.

```bash
ollama pull gemma4:e4b
ollama pull qwen3.6:35b
```

---

### Windows 11 + WSL2 (Nvidia GPU)

With a discrete GPU, VRAM is the constraint — not system RAM. Model weights plus KV cache must fit in VRAM to run fully on GPU. If they don't, Ollama offloads layers to system RAM and runs them on CPU, which is significantly slower.

#### Example: RTX 5080 (16GB VRAM) + 64GB system RAM

The key constraint: at 64k context with q4_0 KV cache, the cache alone takes ~3-4GB, leaving ~12GB for model weights. Anything larger offloads to CPU.

| Model                | Size  | Full GPU at 32k? | Full GPU at 64k? | Notes                           |
| -------------------- | ----- | ---------------- | ---------------- | ------------------------------- |
| `qwen3.5:9b-q4_K_M`  | 6.6GB | ✅               | ✅               | Fastest, plenty of headroom     |
| `qwen3.5:9b-q8_0`    | 11GB  | ✅               | ✅               | Best quality that fits fully    |
| `gemma4:e4b`         | 9.6GB | ✅               | ✅               | Good all-rounder                |
| `qwen3.8:27b`        | 18GB  | ⚠ ~30% CPU       | ⚠ ~40% CPU       | Capable but slower with offload |
| `qwen3.5:27b-q4_K_M` | 17GB  | ⚠ ~25% CPU       | ⚠ ~40% CPU       | Same tradeoff                   |
| `muse-glimmer:30b`   | 18GB  | ⚠ ~30% CPU       | ⚠ ~40% CPU       | Meta agentic model, partial     |

**For 16GB VRAM with long context (64k+):** the sweet spot is `qwen3.5:9b-q8_0` — latest generation, 11GB, fully in VRAM with room for KV cache, fast. The quality gap vs 27B models is real but qwen3.5 is meaningfully stronger than qwen3 at the same size.

```bash
ollama pull qwen3.5:9b-q8_0
```

If you need a larger model and can tolerate slower generation, `qwen3.8:27b` (default q4_K_M, 18GB) is the most capable option — ~30-40% of layers offload to CPU but 64GB system RAM handles it without swapping.

```bash
ollama pull qwen3.8:27b
```

#### With 32GB VRAM (e.g. RTX 5090)

32GB is the tier where capability, long context, and full-GPU inference coexist without compromise:

| Model              | Size | Full GPU at 64k? | Notes                              |
| ------------------ | ---- | ---------------- | ---------------------------------- |
| `qwen3.8:27b`      | 18GB | ✅               | Fully on GPU, 256k context capable |
| `qwen3.5:27b-q8_0` | 30GB | ✅ at 32k        | High quality, tight at 64k         |
| `qwen3.5:35b-a3b`  | 24GB | ✅               | MoE — fast + capable               |
| `muse-glimmer:30b` | 18GB | ✅               | Meta agentic model, full GPU       |

`qwen3.8:27b` fits fully at 64k context with comfortable headroom on 32GB — that's the upgrade that resolves the 16GB tradeoff entirely.

#### Running Ollama inside WSL2

The Windows Nvidia driver is automatically stubbed into WSL2 as `libcuda.so`. **Do not install a Linux GPU driver inside WSL** — it will overwrite this stub and break GPU access.

What you need inside WSL is only the CUDA _toolkit_ (compiler, libraries), not the driver.

Check your current state first:

```bash
nvidia-smi                        # should show your GPU — works via Windows driver stub
nvcc --version                    # check if toolkit is installed and which version
dpkg -l | grep "nvidia-driver"    # should return nothing — if not, you have the wrong package
```

If `nvidia-smi` fails or Linux driver packages are present, fix it:

```bash
# Remove wrong packages
sudo apt remove --purge nvidia-cuda-toolkit nvidia-driver-* cuda-drivers
sudo apt autoremove

# Add Nvidia's official WSL-Ubuntu repo (installs toolkit without driver)
wget https://developer.download.nvidia.com/compute/cuda/repos/wsl-ubuntu/x86_64/cuda-keyring_1.1-1_all.deb
sudo dpkg -i cuda-keyring_1.1-1_all.deb
sudo apt update

# Install toolkit only — do NOT use 'cuda' or 'cuda-drivers' meta-packages
sudo apt install cuda-toolkit-12-9
```

> **Never** run `sudo apt install nvidia-cuda-toolkit` inside WSL — that installs Ubuntu's
> repo package (typically outdated CUDA 11.x) and can pull in Linux driver components that
> conflict with the Windows driver stub.

Once `nvidia-smi` works in WSL, install Ollama normally:

```bash
curl -fsSL https://ollama.com/install.sh | sh
```

Ollama's installer detects the GPU via `nvidia-smi` automatically. Verify after pulling a model:

```bash
ollama ps   # GPU column should show your card, not CPU
```

#### Ollama environment variables (set in WSL `~/.bashrc`)

```bash
export OLLAMA_FLASH_ATTENTION=1
export OLLAMA_KV_CACHE_TYPE=q8_0
export OLLAMA_CONTEXT_LENGTH=32768
# export OLLAMA_NUM_GPU_LAYERS=-1   # -1 = auto (default); tune down if VRAM OOM
```

> **Important:** `~/.bashrc` env vars are not picked up by the Ollama systemd service.
> They only apply if you start Ollama manually from a shell. If Ollama runs as a service
> (the default after `curl | sh` install), you must add the vars to the service instead.

If Ollama is running as a systemd service (check with `systemctl status ollama`):

```bash
sudo systemctl edit ollama
```

Add this block and save:

```ini
[Service]
Environment="OLLAMA_FLASH_ATTENTION=1"
Environment="OLLAMA_KV_CACHE_TYPE=q8_0"
Environment="OLLAMA_CONTEXT_LENGTH=32768"
```

Then apply:

```bash
sudo systemctl daemon-reload
sudo systemctl restart ollama
```

Verify the model loaded with the right context after restarting:

```bash
ollama run qwen3.8:27b  # load the model
# Ctrl+C to exit, then:
ollama ps               # check context size and GPU/CPU split
```

#### Anvil config (`~/.anvil/config.yaml` inside WSL)

```yaml
default_provider: ollama
default_model: qwen3.5:9b-q8_0   # fully in VRAM at 64k; swap for qwen3.8:27b if you prefer capability over speed
stream_timeout: 120
connect_timeout: 60               # GPU loads models fast; 60s is sufficient
context_size: 65536               # 64k — fits fully in 16GB VRAM with 9b-q8_0; expect CPU offload with 27b

providers:
  ollama:
    endpoint: http://localhost:11434
```

#### Layer offload tuning

With 16GB VRAM and an 18GB model, Ollama offloads ~2GB of layers to system RAM automatically. Check what's running:

```bash
ollama ps   # shows loaded model and which device(s) it's running on
```

If generation is slower than expected, those offloaded layers are the bottleneck. Options:

- Reduce `context_size` — smaller KV cache frees VRAM headroom for more layers on GPU
- Use `qwen3:14b-q4_K_M` (9.3GB) if you want guaranteed full-GPU inference
- Force fewer GPU layers: set `OLLAMA_NUM_GPU_LAYERS=40` and tune until stable
