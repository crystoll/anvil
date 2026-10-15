# Models and Hardware

The default model is `gemma4:e4b`, but the best choice depends on your hardware and workload.
Use a model with tool-calling support for agent mode, and benchmark it on your own machine.

## Historical Benchmark Snapshot

These results are from a previous machine-specific run. The run date and exact model revisions
were not recorded, so treat the numbers as historical examples rather than current rankings. The
older run used four tasks, including an Obsidian MCP workflow and an LSP write-and-fix task; the
current benchmark script uses safe, project-local read-only tasks instead.

| Model           | Download size | Architecture | Avg Time | Completion Tokens | Reliability |
| --------------- | ------------- | ------------ | -------- | ----------------- | ----------- |
| **gemma4:e4b**  | 8GB           | MoE          | **19s**  | 1332              | 4/4         |
| **qwen3.6:35b** | 22GB          | MoE          | **17s**  | 871               | 4/4         |
| qwen3.6:27b     | 16GB          | Dense        | 66s      | 878               | 4/4         |
| qwen3-agentic   | 8GB           | Dense        | 70s      | 2951              | 4/4         |

## Observations from That Run

### Project default: `gemma4:e4b`

This is Anvil's built-in default, not a universal recommendation. It completed all four recorded
tasks in an average of 19 seconds and produced 1,332 completion tokens.

### Fastest in this run: `qwen3.6:35b`

It averaged 17 seconds across the recorded tasks and used 871 completion tokens. This result is
specific to the benchmark setup and model revision.

### Other recorded results

`qwen3.6:27b` averaged 66 seconds and 878 completion tokens. `qwen3-agentic` averaged 70 seconds
and 2,951 completion tokens. These measurements do not establish general model quality or current
performance.

## Running Tests

Run from the repository root with Ollama running and the model(s) already available. The current
harness runs simple Q&A, a directory listing, and a project-local search-and-read task. It does not
require an Obsidian vault or modify project files.

```bash
# Test all Ollama models:
pnpm exec tsx scripts/model-test.ts

# Test specific models:
pnpm exec tsx scripts/model-test.ts gemma4:e4b qwen3.6:35b
```

## Hardware

The historical benchmark was run on macOS with Apple Silicon using Ollama. Model loading and
generation times vary by hardware, quantization, context size, and whether the model is already
loaded.

---

## Hardware Setup Guides

The values and model tags below are examples, not current hardware or model recommendations.
Check the current model's disk size and context requirements before pulling it.

### Apple Silicon Mac (M-series)

Ollama uses unified memory — the same pool serves both CPU and GPU. This means large models fit without a discrete GPU, but memory is shared with the OS and other apps.

#### Example: M3 Pro with 36GB unified memory

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
first_token_timeout: 300            # cold model load and prompt evaluation, seconds
stream_timeout: 120
connect_timeout: 300                # HTTP connection and response headers, seconds
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

**Example for 16GB VRAM with long context (64k+):** `qwen3.5:9b-q8_0` was an 11GB option in
this guide's test environment. Check the current tag size and runtime memory before downloading.

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
first_token_timeout: 300           # model load and prompt evaluation
stream_timeout: 120
connect_timeout: 60                # HTTP connection and response headers
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
